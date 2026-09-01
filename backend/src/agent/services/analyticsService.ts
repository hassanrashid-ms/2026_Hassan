import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, notInArray, sql } from 'drizzle-orm'
import type { AnalyticsRange, AnalyticsResponse } from '@support/types'
import { conversation, event, workspaceMember } from '../../shared/db/schema/index.ts'
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'

export async function getVolumeMetrics(
  ctx: Pick<AgentContext, 'workspaceId'>,
  range: AnalyticsRange,
): Promise<AnalyticsResponse['volume']> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const from = new Date(range.from)
    const to = new Date(range.to)

    const seriesRows = await tx
      .select({
        bucket: sql<string>`to_char(date_trunc(${range.granularity}, ${conversation.createdAt}), 'YYYY-MM-DD')`,
        opened: sql<number>`count(*)::int`,
      })
      .from(conversation)
      .where(and(gte(conversation.createdAt, from), lte(conversation.createdAt, to)))
      .groupBy(sql`1`)
      .orderBy(sql`1`)

    // conversation has no resolvedAt column (that lives on resolution_cycle,
    // scoped to per-cycle inactivity tracking, not reporting). "Resolved" here
    // comes from the event spine, same as speed metrics do.
    const resolvedRows = await tx
      .select({
        bucket: sql<string>`to_char(date_trunc(${range.granularity}, ${event.occurredAt}), 'YYYY-MM-DD')`,
        resolved: sql<number>`count(*)::int`,
      })
      .from(event)
      .where(
        and(
          inArray(event.type, ['conversation_resolved', 'conversation_resolved_forced']),
          gte(event.occurredAt, from),
          lte(event.occurredAt, to),
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`)

    const seriesByBucket = new Map<string, { bucket: string; opened: number; resolved: number }>()
    for (const row of seriesRows) seriesByBucket.set(row.bucket, { bucket: row.bucket, opened: row.opened, resolved: 0 })
    for (const row of resolvedRows) {
      const existing = seriesByBucket.get(row.bucket)
      if (existing) existing.resolved = row.resolved
      else seriesByBucket.set(row.bucket, { bucket: row.bucket, opened: 0, resolved: row.resolved })
    }

    const byStatusRows = await tx
      .select({ status: conversation.status, count: sql<number>`count(*)::int` })
      .from(conversation)
      .groupBy(conversation.status)

    const [openTotalRow] = await tx
      .select({ openTotal: sql<number>`count(*)::int` })
      .from(conversation)
      .where(notInArray(conversation.status, ['resolved', 'closed']))

    const byPriorityRows = await tx
      .select({ priority: conversation.priority, count: sql<number>`count(*)::int` })
      .from(conversation)
      .where(notInArray(conversation.status, ['resolved', 'closed']))
      .groupBy(conversation.priority)

    return {
      series: [...seriesByBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
      byStatus: byStatusRows.map((r) => ({ status: r.status, count: r.count })),
      openTotal: openTotalRow?.openTotal ?? 0,
      byPriority: byPriorityRows.map((r) => ({ priority: r.priority, count: r.count })),
    }
  })
}

async function firstResponseSecondsByConversation(tx: Tx, from: Date, to: Date) {
  const opens = await tx
    .select({ conversationId: event.conversationId, occurredAt: event.occurredAt })
    .from(event)
    .where(and(eq(event.type, 'conversation_opened'), gte(event.occurredAt, from), lte(event.occurredAt, to)))

  const replies = await tx
    .select({ conversationId: event.conversationId, occurredAt: event.occurredAt })
    .from(event)
    .where(and(eq(event.type, 'message_sent'), eq(event.actorType, 'agent')))
    .orderBy(asc(event.occurredAt))

  const firstReplyByConversation = new Map<string, Date>()
  for (const reply of replies) {
    if (!reply.conversationId) continue
    if (!firstReplyByConversation.has(reply.conversationId)) firstReplyByConversation.set(reply.conversationId, reply.occurredAt)
  }

  const seconds: Array<{ bucket: string; seconds: number }> = []
  for (const open of opens) {
    if (!open.conversationId) continue
    const reply = firstReplyByConversation.get(open.conversationId)
    if (!reply || reply < open.occurredAt) continue
    const diffSeconds = (reply.getTime() - open.occurredAt.getTime()) / 1000
    seconds.push({ bucket: open.occurredAt.toISOString().slice(0, 10), seconds: diffSeconds })
  }
  return seconds
}

function summarize(values: number[]): { avgSeconds: number | null; p50Seconds: number | null; p90Seconds: number | null } {
  if (values.length === 0) return { avgSeconds: null, p50Seconds: null, p90Seconds: null }
  const sorted = [...values].sort((a, b) => a - b)
  const avg = sorted.reduce((sum, v) => sum + v, 0) / sorted.length
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
  return { avgSeconds: avg, p50Seconds: pick(0.5), p90Seconds: pick(0.9) }
}

function bucketSeries(points: Array<{ bucket: string; seconds: number }>) {
  const byBucket = new Map<string, number[]>()
  for (const p of points) {
    const arr = byBucket.get(p.bucket) ?? []
    arr.push(p.seconds)
    byBucket.set(p.bucket, arr)
  }
  return [...byBucket.entries()]
    .map(([bucket, secs]) => ({ bucket, seconds: secs.reduce((s, v) => s + v, 0) / secs.length }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
}

export async function getSpeedMetrics(
  ctx: Pick<AgentContext, 'workspaceId'>,
  range: AnalyticsRange,
): Promise<AnalyticsResponse['speed']> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const from = new Date(range.from)
    const to = new Date(range.to)

    const firstResponsePoints = await firstResponseSecondsByConversation(tx, from, to)

    const resolutions = await tx
      .select({ conversationId: event.conversationId, type: event.type, occurredAt: event.occurredAt })
      .from(event)
      .where(inArray(event.type, ['conversation_opened', 'conversation_resolved', 'conversation_resolved_forced']))
      .orderBy(asc(event.occurredAt))

    const openedAt = new Map<string, Date>()
    const resolutionPoints: Array<{ bucket: string; seconds: number }> = []
    for (const row of resolutions) {
      if (!row.conversationId) continue
      if (row.type === 'conversation_opened') {
        openedAt.set(row.conversationId, row.occurredAt)
      } else {
        const opened = openedAt.get(row.conversationId)
        if (opened && row.occurredAt >= from && row.occurredAt <= to) {
          resolutionPoints.push({
            bucket: opened.toISOString().slice(0, 10),
            seconds: (row.occurredAt.getTime() - opened.getTime()) / 1000,
          })
        }
      }
    }

    const claims = await tx
      .select({ conversationId: event.conversationId, type: event.type, occurredAt: event.occurredAt })
      .from(event)
      .where(inArray(event.type, ['conversation_opened', 'conversation_assigned_bot', 'conversation_assigned']))
      .orderBy(asc(event.occurredAt))

    const queuedAt = new Map<string, Date>()
    const claimPoints: Array<{ bucket: string; seconds: number }> = []
    for (const row of claims) {
      if (!row.conversationId) continue
      if (row.type === 'conversation_opened' || row.type === 'conversation_assigned_bot') {
        if (!queuedAt.has(row.conversationId)) queuedAt.set(row.conversationId, row.occurredAt)
      } else {
        const queued = queuedAt.get(row.conversationId)
        if (queued && row.occurredAt >= from && row.occurredAt <= to) {
          claimPoints.push({
            bucket: queued.toISOString().slice(0, 10),
            seconds: (row.occurredAt.getTime() - queued.getTime()) / 1000,
          })
        }
      }
    }

    return {
      firstResponse: { ...summarize(firstResponsePoints.map((p) => p.seconds)), series: bucketSeries(firstResponsePoints) },
      resolution: { ...summarize(resolutionPoints.map((p) => p.seconds)), series: bucketSeries(resolutionPoints) },
      timeToClaim: { series: bucketSeries(claimPoints) },
    }
  })
}

export async function getBotMetrics(
  ctx: Pick<AgentContext, 'workspaceId'>,
  range: AnalyticsRange,
): Promise<AnalyticsResponse['bot']> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const from = new Date(range.from)
    const to = new Date(range.to)

    // 'resolved' auto-transitions to 'closed' after workspace.autoCloseDays, so
    // restricting to status='resolved' alone silently drops every ticket old
    // enough to have closed — undercounting non-bot resolutions far more than
    // recent bot ones and skewing containment toward 100%. Both statuses are
    // terminal-resolved; only 'reopened' escapes back to 'open'.
    const [botResolvedRow] = await tx
      .select({ botResolved: sql<number>`count(*) filter (where ${conversation.resolutionSource} = 'bot')::int` })
      .from(conversation)
      .where(inArray(conversation.status, ['resolved', 'closed']))
    const [totalResolvedRow] = await tx
      .select({ totalResolved: sql<number>`count(*)::int` })
      .from(conversation)
      .where(inArray(conversation.status, ['resolved', 'closed']))

    const botResolved = botResolvedRow?.botResolved ?? 0
    const totalResolved = totalResolvedRow?.totalResolved ?? 0

    const [handoffCountRow] = await tx
      .select({ handoffCount: sql<number>`count(*)::int` })
      .from(event)
      .where(and(eq(event.type, 'bot_handoff'), gte(event.occurredAt, from), lte(event.occurredAt, to)))
    const handoffCount = handoffCountRow?.handoffCount ?? 0

    const handoffRows = await tx
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.type, 'bot_handoff'), gte(event.occurredAt, from), lte(event.occurredAt, to)))

    const reasonCounts = new Map<string, number>()
    for (const row of handoffRows) {
      const reason = typeof row.payload.reason === 'string' ? row.payload.reason : 'unknown'
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1)
    }

    const [searchCountRow] = await tx
      .select({ searchCount: sql<number>`count(*)::int` })
      .from(event)
      .where(and(eq(event.type, 'bot_search'), gte(event.occurredAt, from), lte(event.occurredAt, to)))
    const [offeredCountRow] = await tx
      .select({ offeredCount: sql<number>`count(*)::int` })
      .from(event)
      .where(and(eq(event.type, 'bot_article_offered'), gte(event.occurredAt, from), lte(event.occurredAt, to)))

    const searchCount = searchCountRow?.searchCount ?? 0
    const offeredCount = offeredCountRow?.offeredCount ?? 0

    return {
      containmentRate: totalResolved > 0 ? botResolved / totalResolved : null,
      handoff: {
        rate: totalResolved + handoffCount > 0 ? handoffCount / (totalResolved + handoffCount) : null,
        byReason: [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count })),
      },
      articleHitRate: searchCount > 0 ? offeredCount / searchCount : null,
    }
  })
}

export async function getTeamMetrics(
  ctx: Pick<AgentContext, 'workspaceId'>,
  range: AnalyticsRange,
): Promise<AnalyticsResponse['team']> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const from = new Date(range.from)
    const to = new Date(range.to)

    const [assignedOpenRow] = await tx
      .select({ assignedOpen: sql<number>`count(*)::int` })
      .from(conversation)
      .where(and(isNotNull(conversation.assignedAgentId), notInArray(conversation.status, ['resolved', 'closed'])))

    const [activeAgentsRow] = await tx
      .select({ activeAgents: sql<number>`count(*)::int` })
      .from(workspaceMember)
      .where(isNull(workspaceMember.deactivatedAt))

    const assignedOpen = assignedOpenRow?.assignedOpen ?? 0
    const activeAgents = activeAgentsRow?.activeAgents ?? 0

    const opens = await tx
      .select({ conversationId: event.conversationId, occurredAt: event.occurredAt })
      .from(event)
      .where(and(eq(event.type, 'conversation_opened'), gte(event.occurredAt, from), lte(event.occurredAt, to)))
    const assigns = await tx
      .select({ conversationId: event.conversationId, occurredAt: event.occurredAt })
      .from(event)
      .where(and(eq(event.type, 'conversation_assigned'), gte(event.occurredAt, from), lte(event.occurredAt, to)))
      .orderBy(asc(event.occurredAt))

    const assignedByConversation = new Map<string, Date>()
    for (const row of assigns) {
      if (row.conversationId && !assignedByConversation.has(row.conversationId)) {
        assignedByConversation.set(row.conversationId, row.occurredAt)
      }
    }

    const depthByBucket = new Map<string, number>()
    for (const open of opens) {
      if (!open.conversationId) continue
      const bucket = open.occurredAt.toISOString().slice(0, 10)
      const assignedAt = assignedByConversation.get(open.conversationId)
      if (!assignedAt) depthByBucket.set(bucket, (depthByBucket.get(bucket) ?? 0) + 1)
    }

    return {
      avgOpenPerActiveAgent: activeAgents > 0 ? assignedOpen / activeAgents : null,
      unassignedQueueDepth: {
        series: [...depthByBucket.entries()]
          .map(([bucket, depth]) => ({ bucket, depth }))
          .sort((a, b) => a.bucket.localeCompare(b.bucket)),
      },
    }
  })
}
