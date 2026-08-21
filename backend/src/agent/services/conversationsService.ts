import { and, desc, eq, inArray, isNull, isNotNull } from 'drizzle-orm'
import type { AgentConversationSummary, AgentMessageView } from '@support/types'
import { postMessage, toAgentView, type PostedMessageRow } from '../../domain/conversations/index.ts'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { agent, conversation, message, player } from '../../shared/db/schema/index.ts'
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'
import { getConversationTags } from './tagsService.ts'

export type ConversationsFilter = 'unassigned' | 'mine' | 'agentAssigned' | 'botHandling' | 'escalated'

// The inbox is a work queue, not an archive — a finished ticket is noise there,
// and its history stays reachable through the context rail. A reopen flips the
// status back to `open`, so it returns to the queue on its own.
const ACTIVE_AGENT_STATUSES: (typeof conversation.status.enumValues)[number][] = ['open', 'awaiting_player', 'escalated']
const UNASSIGNED_STATUSES: (typeof conversation.status.enumValues)[number][] = ['open', 'escalated']

export async function listConversations(ctx: AgentContext, filter: ConversationsFilter): Promise<AgentConversationSummary[]> {
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
        ),
      )
      .orderBy(conversation.priority, conversation.createdAt)

    // One extra query per row for the last-message preview. Fine at this
    // slice's inbox size; a lateral join is the fix if the inbox ever grows
    // large enough for this to matter.
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
    return summaries
  })
}

export type ClaimResult = { claimed: boolean; status: string | null; posted: PostedMessageRow | null }
export type TakeOverResult = ClaimResult

// Shared by claimConversation and takeOverConversation: both are the same
// player-invisible fact ("this ticket now belongs to a different agent, or an
// agent at all"), regardless of whether the previous owner was the bot,
// nobody, or another agent — a second agent who already has the ticket open
// only learns about the reassignment through this message, since neither
// `conversation:changed` nor the status prop reaches an already-open thread
// panel.
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
      // Status guard lives in the UPDATE's where, not a pre-check: a separate
      // read could be resolved out from under the write.
      .where(and(eq(conversation.id, conversationId), inArray(conversation.status, ACTIVE_AGENT_STATUSES)))
      .returning({ id: conversation.id, status: conversation.status })
    const [row] = claimed
    if (!row) return { claimed: false, status: null, posted: null }

    // Guarded by the same `claimed` check as the update, so a losing racer
    // writes nothing. `via` leaves room for a future auto-assignment path to
    // write this same type rather than a second one. No session_id: this is an
    // agent-console request, with no player session behind it.
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

/** Atomically moves a bot-owned ticket into the acting agent's queue. */
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
