import { eq, sql } from 'drizzle-orm'
import type { ChatAuthorType, ChatDeliveryState } from '@support/types'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { conversation, message } from '../../shared/db/schema/index.ts'
import type { Tx } from '../../shared/db/withWorkspace.ts'

export type PostMessageInput = {
  workspaceId: string
  conversationId: string
  authorType: ChatAuthorType
  /** The player id or agent id behind this send — recorded on the event, not the message row. */
  actorId: string
  authorAgentId?: string | null
  body: string
  visibility?: 'public' | 'internal'
}

export type PostedMessageRow = {
  id: string
  conversationId: string
  seq: number
  authorType: ChatAuthorType
  authorAgentId: string | null
  body: string
  visibility: 'public' | 'internal'
  deliveryState: ChatDeliveryState
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
  const [bumped] = await tx
    .update(conversation)
    .set({ messageSeq: sql`${conversation.messageSeq} + 1` })
    .where(eq(conversation.id, input.conversationId))
    .returning({ seq: conversation.messageSeq })

  if (!bumped) {
    throw new Error(`postMessage: conversation ${input.conversationId} not found`)
  }

  const [inserted] = await tx
    .insert(message)
    .values({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      seq: bumped.seq,
      authorType: input.authorType,
      authorAgentId: input.authorAgentId ?? null,
      body: input.body,
      visibility: input.visibility ?? 'public',
    })
    .returning()

  if (!inserted) {
    throw new Error('postMessage: message insert returned nothing')
  }

  await appendEvent(tx, {
    workspaceId: input.workspaceId,
    type: 'message_sent',
    conversationId: input.conversationId,
    actorId: input.actorId,
    actorType: input.authorType,
    payload: { seq: bumped.seq, author_type: input.authorType },
  })

  return inserted
}
