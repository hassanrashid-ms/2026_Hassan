import { and, desc, eq, isNull } from 'drizzle-orm'
import type { AgentConversationSummary, AgentMessageView } from '@support/types'
import { toAgentView } from '../../domain/conversations/index.ts'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { conversation, message, player } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'

export type ConversationsFilter = 'unassigned' | 'mine'

export async function listConversations(ctx: AgentContext, filter: ConversationsFilter): Promise<AgentConversationSummary[]> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const rows = await tx
      .select({ id: conversation.id, status: conversation.status, externalPlayerId: player.externalId })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .where(filter === 'unassigned' ? isNull(conversation.assignedAgentId) : eq(conversation.assignedAgentId, ctx.agentId))
      .orderBy(desc(conversation.createdAt))

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

      summaries.push({
        id: row.id,
        player: { external_player_id: row.externalPlayerId },
        status: row.status,
        last_message_preview: last?.body ?? null,
        last_message_at: last?.createdAt.toISOString() ?? null,
      })
    }
    return summaries
  })
}

export type ClaimResult = { claimed: boolean; status: string | null }

export async function claimConversation(ctx: AgentContext, conversationId: string): Promise<ClaimResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const claimed = await tx
      .update(conversation)
      .set({ assignedAgentId: ctx.agentId })
      .where(and(eq(conversation.id, conversationId), isNull(conversation.assignedAgentId)))
      .returning({ id: conversation.id, status: conversation.status })
    const [row] = claimed
    if (!row) return { claimed: false, status: null }

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
    return { claimed: true, status: row.status }
  })
}

export async function getAgentConversationMessages(ctx: AgentContext, conversationId: string): Promise<AgentMessageView[] | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx.select({ id: conversation.id }).from(conversation).where(eq(conversation.id, conversationId)).limit(1)
    if (!found) return null

    const rows = await tx.select().from(message).where(eq(message.conversationId, conversationId)).orderBy(message.seq)
    return rows.map(toAgentView)
  })
}
