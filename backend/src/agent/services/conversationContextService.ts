import { and, asc, count, desc, eq, ne, sql } from 'drizzle-orm'
import type { AgentConversationDetail, AgentPlayerStateView, AgentTicketSummary } from '@support/types'
import {
  agent,
  conversation,
  declaredField,
  event,
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

const TICKET_CAP = 20

export type TicketHistory = {
  tickets: AgentTicketSummary[]
  totalTickets: number
  totalReopened: number
}

/**
 * This player's other conversations in this workspace, newest first, capped at
 * 20 with the true count alongside.
 *
 * Two queries regardless of ticket count. listConversations() runs one preview
 * query per row and says so in a comment; this does not repeat that. The total
 * rides along on the first query as a window count — Postgres computes window
 * functions before LIMIT, so it counts the whole population, not the page.
 *
 * The message table is never touched, so there is no path by which an internal
 * note reaches this response. toAgentView is not involved.
 */
export async function getTicketHistory(
  tx: Tx,
  args: { playerId: string; excludeConversationId: string },
): Promise<TicketHistory> {
  const rows = await tx
    .select({
      id: conversation.id,
      number: conversation.number,
      createdAt: conversation.createdAt,
      status: conversation.status,
      resolutionSource: conversation.resolutionSource,
      intentName: intent.name,
      subintentName: subintent.name,
      assignedAgentName: agent.displayName,
      totalCount: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(conversation)
    .leftJoin(subintent, eq(subintent.id, conversation.subintentId))
    .leftJoin(intent, eq(intent.id, subintent.intentId))
    .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
    .where(and(eq(conversation.playerId, args.playerId), ne(conversation.id, args.excludeConversationId)))
    .orderBy(desc(conversation.createdAt))
    .limit(TICKET_CAP)

  const reopens = await tx
    .select({ conversationId: event.conversationId, reopens: count() })
    .from(event)
    .innerJoin(conversation, eq(conversation.id, event.conversationId))
    .where(
      and(
        eq(event.type, 'conversation_reopened'),
        eq(conversation.playerId, args.playerId),
        ne(conversation.id, args.excludeConversationId),
      ),
    )
    .groupBy(event.conversationId)

  const reopenById = new Map<string, number>()
  let totalReopened = 0
  for (const row of reopens) {
    if (!row.conversationId) continue
    reopenById.set(row.conversationId, row.reopens)
    totalReopened += row.reopens
  }

  const tickets: AgentTicketSummary[] = rows.map((row) => ({
    id: row.id,
    number: row.number,
    created_at: row.createdAt.toISOString(),
    status: row.status,
    subintent:
      row.subintentName && row.intentName
        ? { intent_name: row.intentName, subintent_name: row.subintentName }
        : null,
    resolution_source: row.resolutionSource,
    resolved_by_agent_name: row.resolutionSource === 'agent' ? row.assignedAgentName : null,
    reopen_count: reopenById.get(row.id) ?? 0,
  }))

  return { tickets, totalTickets: rows[0]?.totalCount ?? 0, totalReopened }
}
