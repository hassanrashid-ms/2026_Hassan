import { eq } from 'drizzle-orm'
import type { AgentConversationDetail } from '@support/types'
import { agent, conversation, intent, player, subintent } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'

/**
 * One conversation's header row, by id.
 *
 * `null` covers both "no such conversation" and "not this workspace" — RLS
 * makes the two indistinguishable, which is the point. The controller turns it
 * into a 404 either way.
 */
export async function getConversationDetail(
  ctx: AgentContext,
  conversationId: string,
): Promise<AgentConversationDetail | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .select({
        id: conversation.id,
        number: conversation.number,
        status: conversation.status,
        resolutionSource: conversation.resolutionSource,
        createdAt: conversation.createdAt,
        playerId: player.id,
        externalPlayerId: player.externalId,
        intentName: intent.name,
        subintentName: subintent.name,
        assignedAgentId: agent.id,
        assignedAgentName: agent.displayName,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(subintent, eq(subintent.id, conversation.subintentId))
      .leftJoin(intent, eq(intent.id, subintent.intentId))
      .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
      .where(eq(conversation.id, conversationId))
      .limit(1)

    if (!row) return null

    return {
      id: row.id,
      number: row.number,
      player: { id: row.playerId, external_player_id: row.externalPlayerId },
      status: row.status,
      subintent:
        row.subintentName && row.intentName
          ? { intent_name: row.intentName, subintent_name: row.subintentName }
          : null,
      assigned_agent:
        row.assignedAgentId && row.assignedAgentName
          ? { id: row.assignedAgentId, display_name: row.assignedAgentName }
          : null,
      resolution_source: row.resolutionSource,
      resolved_by_agent_name: row.resolutionSource === 'agent' ? row.assignedAgentName : null,
      created_at: row.createdAt.toISOString(),
    }
  })
}
