import { and, desc, eq, lte, ne } from 'drizzle-orm'
import type { z } from 'zod'
import { MarkPlayerReadBody, SendMessageBody, type ConversationStatusValue, type PlayerMessageView } from '@support/types'

type SendMessageBodyType = z.infer<typeof SendMessageBody>
type MarkPlayerReadBodyType = z.infer<typeof MarkPlayerReadBody>
import { postMessage, toAgentView, toPlayerView } from '../../domain/conversations/index.ts'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { conversation, message, session } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import { emitInboxChanged, emitMessageToRooms, emitReadReceipt } from '../../shared/realtime/emit.ts'
import { getIo } from '../../shared/realtime/socketServer.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'

const REOPENABLE_STATUSES = new Set(['resolved', 'closed'])

export async function sendPlayerMessage(
  ctx: PlayerContext,
  body: SendMessageBodyType,
): Promise<{ conversation_id: string; message: PlayerMessageView | null }> {
  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx
      .select({ id: conversation.id, status: conversation.status })
      .from(conversation)
      .where(eq(conversation.playerId, ctx.playerId))
      .orderBy(desc(conversation.createdAt))
      .limit(1)

    let conversationId: string
    // Set whenever the inbox needs to refetch: a brand-new conversation just
    // appeared in Unassigned, a reopen just moved one back into it, or a reply
    // just took one out of Awaiting Player. Claiming (Task 7) is the fourth
    // trigger for the same event, from a different path.
    let inboxStatus: string | null = null

    if (!existing) {
      // Best-effort: attaches the player's most recent session so a future
      // agent Game View can reach the player-state snapshot. Never rewritten
      // on reopen — see docs/specs/2026-08-06-chat-module-design.md.
      const [latestSession] = await tx
        .select({ id: session.id })
        .from(session)
        .where(eq(session.playerId, ctx.playerId))
        .orderBy(desc(session.startedAt))
        .limit(1)

      const [created] = await tx
        .insert(conversation)
        .values({ workspaceId: ctx.workspaceId, playerId: ctx.playerId, sessionId: latestSession?.id ?? null, status: 'open' })
        .returning({ id: conversation.id })
      if (!created) throw new Error('conversation insert returned nothing')
      conversationId = created.id
      inboxStatus = 'open'
    } else {
      conversationId = existing.id
      if (REOPENABLE_STATUSES.has(existing.status)) {
        await tx.update(conversation).set({ status: 'open', assignedAgentId: null }).where(eq(conversation.id, conversationId))
        await appendEvent(tx, {
          workspaceId: ctx.workspaceId,
          type: 'conversation_reopened',
          conversationId,
          actorId: ctx.playerId,
          actorType: 'player',
        })
        inboxStatus = 'open'
      } else if (existing.status === 'awaiting_player') {
        // The other half of the pair `sendAgentMessage` opens with its
        // `open → awaiting_player` flip: the player has now answered, so support
        // owns the next action again. Deliberately NOT the reopen branch above —
        // clearing assignedAgentId here would dump an actively-handled
        // conversation back into Unassigned, and the agent who asked stays owner.
        await tx.update(conversation).set({ status: 'open' }).where(eq(conversation.id, conversationId))
        await appendEvent(tx, {
          workspaceId: ctx.workspaceId,
          type: 'conversation_player_replied',
          conversationId,
          actorId: ctx.playerId,
          actorType: 'player',
        })
        inboxStatus = 'open'
      }
    }

    const posted = await postMessage(tx, {
      workspaceId: ctx.workspaceId,
      conversationId,
      authorType: 'player',
      actorId: ctx.playerId,
      body: body.body,
    })

    return { conversationId, posted, inboxStatus }
  })

  const playerView = toPlayerView(result.posted)
  const agentView = toAgentView(result.posted)
  emitMessageToRooms(getIo(), result.conversationId, playerView, agentView)
  if (result.inboxStatus) {
    emitInboxChanged(getIo(), ctx.workspaceId, result.conversationId, result.inboxStatus)
  }

  return { conversation_id: result.conversationId, message: playerView }
}

export async function getPlayerMessages(
  ctx: PlayerContext,
  query: { session_id: string },
): Promise<{ conversation_id: string | null; messages: PlayerMessageView[]; status?: ConversationStatusValue } | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [ownedSession] = await tx
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.id, query.session_id), eq(session.playerId, ctx.playerId)))
      .limit(1)
    if (!ownedSession) return null

    const [found] = await tx
      .select({ id: conversation.id, status: conversation.status })
      .from(conversation)
      .where(eq(conversation.playerId, ctx.playerId))
      .orderBy(desc(conversation.createdAt))
      .limit(1)
    if (!found) return { conversation_id: null, messages: [] }

    const rows = await tx.select().from(message).where(eq(message.conversationId, found.id)).orderBy(message.seq)
    const messages = rows.map(toPlayerView).filter((m): m is PlayerMessageView => m !== null)
    return { conversation_id: found.id, messages, status: found.status }
  })
}

/**
 * `null` means there is nothing to announce — no conversation, or every message
 * in range was already read. The caller uses that to skip the socket emit.
 */
export type MarkReadResult = { conversationId: string; upToSeq: number; readAt: Date } | null

export async function markPlayerMessagesRead(
  ctx: PlayerContext,
  body: MarkPlayerReadBodyType,
): Promise<MarkReadResult> {
  // One timestamp for the whole batch: every message in this range was seen in
  // the same glance, and a per-row now() would imply an ordering that did not happen.
  const readAt = new Date()

  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx.select({ id: conversation.id }).from(conversation).where(eq(conversation.playerId, ctx.playerId)).limit(1)
    if (!found) return null

    const updated = await tx
      .update(message)
      .set({ deliveryState: 'read', readAt })
      .where(
        and(
          eq(message.conversationId, found.id),
          ne(message.authorType, 'player'),
          // Load-bearing: this is what makes read_at first-write-wins. Removing
          // it would let every thread open overwrite the original read time.
          ne(message.deliveryState, 'read'),
          lte(message.seq, body.up_to_seq),
        ),
      )
      .returning({ seq: message.seq })

    if (updated.length === 0) return null
    return { conversationId: found.id, upToSeq: Math.max(...updated.map((r) => r.seq)), readAt }
  })

  if (result) {
    emitReadReceipt(getIo(), 'agents', {
      conversation_id: result.conversationId,
      up_to_seq: result.upToSeq,
      reader_type: 'player',
      read_at: result.readAt.toISOString(),
    })
  }

  return result
}
