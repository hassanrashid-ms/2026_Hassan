import type { ChatMessage } from '../components/types.ts'

export type PendingMessage = ChatMessage & { tempId: string }

/**
 * A pending (optimistic) message disappears once the server's own list
 * contains a message with the same author and body appended after it — an
 * id-based match isn't available until the send response lands, and matching
 * on body/author is the same fallback StrictMode-safe code elsewhere in this
 * codebase reaches for when there is no id yet to compare.
 */
export function reconcilePending(serverMessages: ChatMessage[], pending: PendingMessage[]): ChatMessage[] {
  const stillPending = pending.filter(
    (p) => !serverMessages.some((m) => m.authorType === p.authorType && m.body === p.body),
  )
  return [...serverMessages, ...stillPending]
}
