import { and, desc, eq } from 'drizzle-orm'
import type { z } from 'zod'
import type { ConversationStatusValue, NewTicketBody } from '@support/types'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { allocateTicketNumber } from '../../domain/conversations/index.ts'
import { conversation, player, session } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import { emitInboxChanged } from '../../shared/realtime/emit.ts'
import { getIo } from '../../shared/realtime/socketServer.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'

type Body = z.infer<typeof NewTicketBody>

const CLOSEABLE_STATUSES = new Set<string>(['resolved', 'closed'])

export type OpenNewTicketResult =
  | { ok: false; reason: 'not_found' | 'conversation_still_open' }
  | { ok: true; conversationId: string; status: ConversationStatusValue }

/**
 * "Open a new ticket" — the one path that gives a player a second conversation
 * row. Everywhere else "the player's current conversation" still means "their
 * latest by created_at", which stays true precisely because this endpoint
 * refuses to run while a live conversation exists: the old one is closed for
 * good before the new one is inserted, so it can never be the latest again.
 *
 * The 409 is enforced here rather than trusted from the UI — the button is only
 * rendered on the resolved banner, but a button is not an invariant.
 */
export async function openNewTicket(ctx: PlayerContext, body: Body): Promise<OpenNewTicketResult> {
  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    // The serialization point for two rapid taps. Deliberately the *player* row
    // and not the latest conversation row: locking the conversation would let a
    // second transaction wake up still holding a reference to the row it read
    // before blocking — now `closed`, so it would pass the check below and open
    // a second live conversation. Locking the player means the re-read of
    // `conversation` below happens after the winner committed, so the loser
    // sees the new `bot_active` row and 409s.
    const [lockedPlayer] = await tx.select({ id: player.id }).from(player).where(eq(player.id, ctx.playerId)).limit(1).for('update')
    if (!lockedPlayer) return { ok: false as const, reason: 'not_found' as const }

    // FK checks bypass RLS and `event.session_id` is ON DELETE RESTRICT, so an
    // unverified id would roll the whole ticket back. Any miss degrades to null.
    const [verifiedSession] = body.session_id
      ? await tx
          .select({ id: session.id })
          .from(session)
          .where(and(eq(session.id, body.session_id), eq(session.playerId, ctx.playerId)))
          .limit(1)
      : []
    const sessionId = verifiedSession?.id ?? null

    const [latest] = await tx
      .select({ id: conversation.id, status: conversation.status })
      .from(conversation)
      .where(eq(conversation.playerId, ctx.playerId))
      .orderBy(desc(conversation.createdAt))
      .limit(1)

    // Nothing to close. The banner this comes from cannot render without a
    // conversation, so this is a client that skipped the flow, not a state to
    // paper over by silently creating a first conversation.
    if (!latest) return { ok: false as const, reason: 'not_found' as const }
    if (!CLOSEABLE_STATUSES.has(latest.status)) {
      return { ok: false as const, reason: 'conversation_still_open' as const }
    }

    // `closed` even when it was already `closed`: this is a deliberate close,
    // and the event that records it is the point of the write.
    await tx.update(conversation).set({ status: 'closed' }).where(eq(conversation.id, latest.id))
    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_closed',
      conversationId: latest.id,
      sessionId,
      actorId: ctx.playerId,
      actorType: 'player',
      // Snapshotted, not a pointer: the row now reads `closed` either way, so
      // without this the event could never say what was closed.
      payload: { previous_status: latest.status, reason: 'new_ticket' },
    })

    const number = await allocateTicketNumber(tx, ctx.workspaceId)
    const [created] = await tx
      .insert(conversation)
      .values({ workspaceId: ctx.workspaceId, playerId: ctx.playerId, sessionId, number })
      .returning({ id: conversation.id, status: conversation.status })
    if (!created) throw new Error('openNewTicket: conversation insert returned nothing')

    // Entering a state is a state change — a conversation whose `bot_active` is
    // only ever a column default is invisible to every metric.
    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_opened',
      conversationId: created.id,
      sessionId,
      actorId: ctx.playerId,
      actorType: 'player',
      payload: { entry_point: null, source: 'new_ticket', previous_conversation_id: latest.id },
    })
    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_assigned_bot',
      conversationId: created.id,
      sessionId,
      actorId: ctx.playerId,
      actorType: 'player',
    })

    return { ok: true as const, closedConversationId: latest.id, conversationId: created.id, status: created.status }
  })

  if (!result.ok) return result

  // After commit, never inside the transaction: a rolled-back ticket must not
  // move anything in an agent's inbox.
  emitInboxChanged(getIo(), ctx.workspaceId, result.closedConversationId, 'closed')
  emitInboxChanged(getIo(), ctx.workspaceId, result.conversationId, result.status)

  return { ok: true, conversationId: result.conversationId, status: result.status }
}
