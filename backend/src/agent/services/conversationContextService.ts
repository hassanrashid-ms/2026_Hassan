import { and, asc, eq } from 'drizzle-orm'
import type { AgentConversationDetail, AgentPlayerStateView } from '@support/types'
import {
  agent,
  conversation,
  declaredField,
  intent,
  player,
  playerStateSnapshot,
  subintent,
} from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { Tx } from '../../shared/db/withWorkspace.ts'
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

/**
 * The rail's player-state panel, as a tagged union rather than one nullable
 * object. Four cases, all 200: missing player state is a state, not an error.
 *
 * No fallback to a later snapshot. When this conversation's session captured
 * nothing, the response says so and carries nothing else — synthesising state
 * from a different session would manufacture exactly the misleading
 * current-level number the product spec rejects, and a label under a number
 * does not stop anyone reading the number.
 *
 * Takes an open tx so the context endpoint reads everything in one transaction.
 */
export async function getPlayerStateView(
  tx: Tx,
  workspaceId: string,
  sessionId: string | null,
): Promise<AgentPlayerStateView> {
  if (!sessionId) return { status: 'no_session' }

  const [snapshot] = await tx
    .select({
      declared: playerStateSnapshot.declared,
      raw: playerStateSnapshot.raw,
      isMissing: playerStateSnapshot.isMissing,
      degradedReason: playerStateSnapshot.degradedReason,
      capturedAt: playerStateSnapshot.capturedAt,
    })
    .from(playerStateSnapshot)
    .where(eq(playerStateSnapshot.sessionId, sessionId))
    .limit(1)

  if (!snapshot) return { status: 'not_captured' }
  if (snapshot.isMissing) return { status: 'missing' }

  // Ordered by when the field was declared, so the seed order the game sees in
  // its own config is the order the agent reads down the panel.
  const fields = await tx
    .select({ key: declaredField.key, label: declaredField.label, type: declaredField.type })
    .from(declaredField)
    .where(eq(declaredField.workspaceId, workspaceId))
    .orderBy(asc(declaredField.declaredAt), asc(declaredField.key))

  const blob = snapshot.declared
  const declared: { key: string; label: string; type: (typeof fields)[number]['type']; value: unknown }[] = []
  const seen = new Set<string>()
  for (const field of fields) {
    if (!(field.key in blob)) continue
    seen.add(field.key)
    declared.push({ key: field.key, label: field.label, type: field.type, value: blob[field.key] })
  }
  // A key in the blob with no declared_field row cannot normally occur —
  // nothing is ever deleted — but appending beats dropping: a value the agent
  // can see is worth more than a tidy list.
  for (const key of Object.keys(blob)) {
    if (seen.has(key)) continue
    declared.push({ key, label: key, type: 'string', value: blob[key] })
  }

  return {
    status: 'captured',
    declared,
    raw: snapshot.raw,
    degraded_reason: snapshot.degradedReason,
    captured_at: snapshot.capturedAt.toISOString(),
  }
}
