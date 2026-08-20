import { eq, sql } from 'drizzle-orm'
import type { ChatAuthorType, ChatDeliveryState } from '@support/types'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { conversation, message } from '../../shared/db/schema/index.ts'
import type { Tx } from '../../shared/db/withWorkspace.ts'
import { touchInactivityClock } from './resolutionCycle.ts'

export type PostMessageInput = {
  workspaceId: string
  conversationId: string
  authorType: ChatAuthorType
  /**
   * The player id or agent id behind this send — recorded on the event, not the
   * message row. Null for a `system` message: it has no player and no agent
   * behind it, and inventing a sentinel actor id would put a fictional uuid in
   * the reporting spine.
   */
  actorId: string | null
  /**
   * The verified player session behind this send, stamped onto the
   * `message_sent` event. Agent, bot and system callers omit it — they have no
   * player request, and a guessed session would be a wrong answer on the
   * `(session_id, type)` index rather than no answer.
   */
  sessionId?: string | null
  authorAgentId?: string | null
  body: string
  visibility?: 'public' | 'internal'
  /**
   * The article the bot answered from, when it answered from one. Null for every
   * other author and every other decision kind. Not validated here: the only
   * caller that sets it is applyBotTurn's `answer` branch, and toolLoop already
   * refused any id that searchArticles had not returned for this workspace.
   */
  articleId?: string | null
  /**
   * The timestamp the inactivity-clock touch below is computed from. Defaults to
   * wall-clock now. Only the background jobs pass it, and only so their tests can
   * assert an exact due date instead of a range.
   */
  now?: Date
}

export type PostedMessageRow = {
  id: string
  conversationId: string
  seq: number
  authorType: ChatAuthorType
  authorAgentId: string | null
  /** Populated by message-list joins; absent on the immediate insert result. */
  authorAgentName?: string | null
  /** The conversation player's external id, populated by message-list joins. */
  authorPlayerName?: string | null
  body: string
  articleId: string | null
  visibility: 'public' | 'internal'
  deliveryState: ChatDeliveryState
  readAt: Date | null
  createdAt: Date
}

/**
 * The one place that bumps `message_seq`, inserts the message, and appends the
 * event — always in that order, always in the caller's transaction. The UPDATE
 * below takes a row lock on the conversation row, so a second concurrent call
 * against the same conversation blocks until this one commits: that lock, not
 * any application-level retry, is what keeps `seq` gap-free of duplicates.
 *
 * No I/O beyond these three DB statements — no socket emit here. The caller
 * emits only after this transaction commits, so a rolled-back message is never
 * pushed to a client that thinks it succeeded.
 */
export async function postMessage(tx: Tx, input: PostMessageInput): Promise<PostedMessageRow> {
  // A message with no body is always a bug, never a legitimate send: the player
  // and agent routes both reject it at their Zod schemas, so anything empty
  // arriving here came from server-side code that had nothing to say and posted
  // anyway. The bot did exactly that when the model returned neither a tool call
  // nor any text. Refused at the one choke point every message goes through,
  // rather than at each caller, so no future path can persist an empty bubble.
  // Throwing is right for the bot: its caller is a retried background job that
  // degrades to a handoff, which is a far better outcome than a blank bubble
  // that the player cannot act on and nothing records as a failure.
  if (input.body.trim() === '') {
    throw new Error(`postMessage: refusing to post an empty ${input.authorType} message`)
  }

  const [bumped] = await tx
    .update(conversation)
    .set({ messageSeq: sql`${conversation.messageSeq} + 1` })
    .where(eq(conversation.id, input.conversationId))
    .returning({ seq: conversation.messageSeq, status: conversation.status })

  if (!bumped) {
    throw new Error(`postMessage: conversation ${input.conversationId} not found`)
  }

  const visibility = input.visibility ?? 'public'

  const [inserted] = await tx
    .insert(message)
    .values({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      seq: bumped.seq,
      authorType: input.authorType,
      authorAgentId: input.authorAgentId ?? null,
      body: input.body,
      articleId: input.articleId ?? null,
      visibility,
    })
    .returning()

  if (!inserted) {
    throw new Error('postMessage: message insert returned nothing')
  }

  await appendEvent(tx, {
    workspaceId: input.workspaceId,
    type: 'message_sent',
    conversationId: input.conversationId,
    sessionId: input.sessionId ?? null,
    actorId: input.actorId,
    actorType: input.authorType,
    payload: { seq: bumped.seq, author_type: input.authorType, visibility },
  })

  // The one place the inactivity clock is wound. Every message path — agent
  // reply, player reply, the bot's handoff line, the clock's own ask, the
  // decline — already funnels through here, so no other call site needs to know
  // a clock exists.
  //
  // Public only: an internal note is a conversation between agents, and letting
  // it reset the player's clock would hide a ticket nobody had actually replied
  // to. Status-gated because the clock does not run under the bot (`bot_active`)
  // or while escalated, and never after `resolved`/`closed`.
  if (visibility === 'public' && (bumped.status === 'open' || bumped.status === 'awaiting_player')) {
    await touchInactivityClock(tx, { conversationId: input.conversationId, now: input.now ?? new Date() })
  }

  return inserted
}
