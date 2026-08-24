import { and, desc, eq, exists, ilike, inArray, isNull, isNotNull, or, sql } from 'drizzle-orm'
import type { AgentConversationSummary, AgentMessageView } from '@support/types'
import { postMessage, toAgentView, type PostedMessageRow } from '../../domain/conversations/index.ts'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { appendChangeLog } from '../../shared/changeLog/appendChangeLog.ts'
import { agent, conversation, conversationTag, message, player, subintent, workspaceMember } from '../../shared/db/schema/index.ts'
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'
import { getConversationTags } from './tagsService.ts'

export type ConversationsFilter = 'unassigned' | 'mine' | 'agentAssigned' | 'botHandling' | 'escalated'

export type ConversationsListFilters = {
  priority?: (typeof conversation.priority.enumValues)[number][]
  labelIds?: string[]
  subintentIds?: string[]
  assigneeIds?: string[]
  olderThanHours?: number
  q?: string
}

const ACTIVE_AGENT_STATUSES: (typeof conversation.status.enumValues)[number][] = ['open', 'awaiting_player', 'escalated']
const UNASSIGNED_STATUSES: (typeof conversation.status.enumValues)[number][] = ['open', 'escalated']

function extraFilterConditions(extra: ConversationsListFilters) {
  const conditions = []
  if (extra.priority?.length) conditions.push(inArray(conversation.priority, extra.priority))
  if (extra.subintentIds?.length) conditions.push(inArray(conversation.subintentId, extra.subintentIds))
  if (extra.assigneeIds?.length) conditions.push(inArray(conversation.assignedAgentId, extra.assigneeIds))
  if (extra.labelIds?.length) {
    conditions.push(
      exists(
        sql`(select 1 from ${conversationTag} where ${conversationTag.conversationId} = ${conversation.id} and ${conversationTag.removedAt} is null and ${conversationTag.tagId} in ${extra.labelIds})`,
      ),
    )
  }
  if (extra.q) {
    const term = `%${extra.q}%`
    const qNum = parseInt(extra.q, 10)
    const numMatch = !isNaN(qNum) ? eq(conversation.number, qNum) : undefined
    const qCond = or(
      numMatch,
      ilike(player.externalId, term),
      ilike(subintent.name, term)
    )
    if (qCond) conditions.push(qCond)
  }
  return conditions
}

export async function listConversations(
  ctx: AgentContext,
  filter: ConversationsFilter,
  extra: ConversationsListFilters = {},
): Promise<AgentConversationSummary[]> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const rows = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
        externalPlayerId: player.externalId,
        confirmPhase: conversation.confirmPhase,
        assignedAgentId: conversation.assignedAgentId,
        assignedAgentName: agent.displayName,
        priority: conversation.priority,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
      .leftJoin(subintent, eq(subintent.id, conversation.subintentId))
      .where(
        and(
          filter === 'mine'
            ? and(eq(conversation.assignedAgentId, ctx.agentId), inArray(conversation.status, ACTIVE_AGENT_STATUSES))
            : filter === 'agentAssigned'
              ? and(isNotNull(conversation.assignedAgentId), inArray(conversation.status, ACTIVE_AGENT_STATUSES))
              : filter === 'botHandling'
                ? eq(conversation.status, 'bot_active')
                : filter === 'escalated'
                  ? eq(conversation.status, 'escalated')
                  : and(isNull(conversation.assignedAgentId), inArray(conversation.status, UNASSIGNED_STATUSES)),
          ...extraFilterConditions(extra),
        ),
      )
      .orderBy(conversation.priority, conversation.createdAt)

    const summaries: AgentConversationSummary[] = []
    for (const row of rows) {
      const [last] = await tx
        .select({ body: message.body, createdAt: message.createdAt })
        .from(message)
        .where(eq(message.conversationId, row.id))
        .orderBy(desc(message.seq))
        .limit(1)
      const tags = await getConversationTags(tx, row.id)

      summaries.push({
        id: row.id,
        player: { external_player_id: row.externalPlayerId },
        status: row.status,
        confirm_phase: row.confirmPhase,
        last_message_preview: last?.body ?? null,
        last_message_at: last?.createdAt.toISOString() ?? null,
        assigned_agent_id: row.assignedAgentId,
        assigned_agent_name: row.assignedAgentName,
        priority: row.priority,
        tags,
      })
    }

    if (extra.olderThanHours !== undefined) {
      const cutoff = Date.now() - extra.olderThanHours * 60 * 60 * 1000
      return summaries.filter((s) => s.last_message_at !== null && new Date(s.last_message_at).getTime() < cutoff)
    }
    return summaries
  })
}

export type ClaimResult = { claimed: boolean; status: string | null; posted: PostedMessageRow | null }
export type TakeOverResult = ClaimResult

async function postTakenOverNotice(tx: Tx, ctx: AgentContext, conversationId: string): Promise<PostedMessageRow> {
  const [actor] = await tx.select({ displayName: agent.displayName }).from(agent).where(eq(agent.id, ctx.agentId)).limit(1)
  return postMessage(tx, {
    workspaceId: ctx.workspaceId,
    conversationId,
    authorType: 'system',
    actorId: null,
    body: `Chat taken over by ${actor?.displayName ?? 'an agent'}.`,
    visibility: 'internal',
  })
}

export async function claimConversation(ctx: AgentContext, conversationId: string): Promise<ClaimResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const claimed = await tx
      .update(conversation)
      .set({ assignedAgentId: ctx.agentId })
      .where(and(eq(conversation.id, conversationId), isNull(conversation.assignedAgentId), inArray(conversation.status, ACTIVE_AGENT_STATUSES)))
      .returning({ id: conversation.id, status: conversation.status })
    const [row] = claimed
    if (!row) return { claimed: false, status: null, posted: null }

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_assigned',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { agent_id: ctx.agentId, via: 'claim' },
    })
    const posted = await postTakenOverNotice(tx, ctx, conversationId)
    return { claimed: true, status: row.status, posted }
  })
}

export async function takeOverConversation(ctx: AgentContext, conversationId: string): Promise<TakeOverResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .update(conversation)
      .set({ assignedAgentId: ctx.agentId, status: 'open', confirmPhase: 'none' })
      .where(and(eq(conversation.id, conversationId), isNull(conversation.assignedAgentId), eq(conversation.status, 'bot_active')))
      .returning({ id: conversation.id, status: conversation.status })
    if (!row) return { claimed: false, status: null, posted: null }

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_taken_over',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { agent_id: ctx.agentId, from_status: 'bot_active', to_status: 'open' },
    })

    const posted = await postTakenOverNotice(tx, ctx, conversationId)
    return { claimed: true, status: row.status, posted }
  })
}

export type ReassignResult =
  | { ok: true; status: string; posted: PostedMessageRow }
  | { ok: false; reason: 'not_found' | 'invalid_status' | 'agent_not_found' | 'agent_not_active' }

async function postReassignedNotice(tx: Tx, ctx: AgentContext, conversationId: string, targetAgentId: string): Promise<PostedMessageRow> {
  const [actor] = await tx.select({ displayName: agent.displayName }).from(agent).where(eq(agent.id, ctx.agentId)).limit(1)
  const [target] = await tx.select({ displayName: agent.displayName }).from(agent).where(eq(agent.id, targetAgentId)).limit(1)
  return postMessage(tx, {
    workspaceId: ctx.workspaceId,
    conversationId,
    authorType: 'system',
    actorId: null,
    body: `Reassigned to ${target?.displayName ?? 'an agent'} by ${actor?.displayName ?? 'an agent'}.`,
    visibility: 'internal',
  })
}

export async function reassignConversation(ctx: AgentContext, conversationId: string, targetAgentId: string): Promise<ReassignResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [conv] = await tx
      .select({ id: conversation.id, status: conversation.status })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1)
    if (!conv) return { ok: false, reason: 'not_found' }
    if (!ACTIVE_AGENT_STATUSES.includes(conv.status)) return { ok: false, reason: 'invalid_status' }

    const [member] = await tx
      .select({ id: workspaceMember.id })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, ctx.workspaceId), eq(workspaceMember.agentId, targetAgentId), isNull(workspaceMember.deactivatedAt)))
      .limit(1)
    if (!member) return { ok: false, reason: 'agent_not_found' }

    const [targetAgent] = await tx.select({ status: agent.status }).from(agent).where(eq(agent.id, targetAgentId)).limit(1)
    if (!targetAgent || targetAgent.status !== 'active') return { ok: false, reason: 'agent_not_active' }

    const [row] = await tx
      .update(conversation)
      .set({ assignedAgentId: targetAgentId })
      .where(eq(conversation.id, conversationId))
      .returning({ id: conversation.id, status: conversation.status })

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_reassigned',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { agent_id: targetAgentId, reassigned_by: ctx.agentId, via: 'reassign' },
    })
    const posted = await postReassignedNotice(tx, ctx, conversationId, targetAgentId)
    return { ok: true, status: row!.status, posted }
  })
}

export type ReclassifyResult =
  | { ok: true; subintentId: string; status: string }
  | { ok: false; reason: 'not_found' | 'invalid_subintent' }

export async function reclassifyConversation(ctx: AgentContext, conversationId: string, subintentId: string): Promise<ReclassifyResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [conv] = await tx
      .select({ id: conversation.id, subintentId: conversation.subintentId, status: conversation.status })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1)
    if (!conv) return { ok: false, reason: 'not_found' }

    const [target] = await tx
      .select({ id: subintent.id })
      .from(subintent)
      .where(and(eq(subintent.id, subintentId), eq(subintent.workspaceId, ctx.workspaceId), isNull(subintent.archivedAt)))
      .limit(1)
    if (!target) return { ok: false, reason: 'invalid_subintent' }

    await tx.update(conversation).set({ subintentId, classificationSource: 'agent' }).where(eq(conversation.id, conversationId))

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_reclassified',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { from_subintent_id: conv.subintentId, to_subintent_id: subintentId, classification_source: 'agent' },
    })
    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'conversation',
      entityId: conversationId,
      actorId: ctx.agentId,
      changes: [{ field: 'subintent_id', before: conv.subintentId, after: subintentId }],
    })
    return { ok: true, subintentId, status: conv.status }
  })
}

export async function getAgentConversationMessages(ctx: AgentContext, conversationId: string): Promise<AgentMessageView[] | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx.select({ id: conversation.id }).from(conversation).where(eq(conversation.id, conversationId)).limit(1)
    if (!found) return null

    const rows = await tx
      .select({
        id: message.id,
        conversationId: message.conversationId,
        seq: message.seq,
        authorType: message.authorType,
        authorAgentId: message.authorAgentId,
        body: message.body,
        articleId: message.articleId,
        visibility: message.visibility,
        deliveryState: message.deliveryState,
        readAt: message.readAt,
        createdAt: message.createdAt,
        authorAgentName: agent.displayName,
        authorPlayerName: player.externalId,
      })
      .from(message)
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(agent, eq(agent.id, message.authorAgentId))
      .where(eq(message.conversationId, conversationId))
      .orderBy(message.seq)
    return rows.map(toAgentView)
  })
}
