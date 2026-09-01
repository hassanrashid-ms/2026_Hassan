import { and, eq, gte, inArray, lte, notInArray, sql } from 'drizzle-orm'
import type { AnalyticsRange, AnalyticsResponse } from '@support/types'
import { conversation, event } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
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
