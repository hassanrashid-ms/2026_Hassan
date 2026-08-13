import type { ChatMessage } from '../components/types.ts'

/**
 * `serverId` is filled in by the sender's onSuccess, from the id the POST
 * returned. Until then the message exists only on this client.
 */
export type PendingMessage = ChatMessage & { tempId: string; serverId?: string }

/**
 * A pending (optimistic) message disappears once the refetched server list
 * contains the exact message the send created — matched by id.
 *
 * This used to match on author + body instead, which silently broke the whole
 * optimistic display for repeated text: sending "hi" into a thread that already
 * contained an earlier "hi" from the same author matched immediately, so the
 * bubble was filtered out in the same render it was added and nothing appeared
 * until the server round trip finished. Ids are what the server actually
 * promises to be unique.
 */
export function reconcilePending(serverMessages: ChatMessage[], pending: PendingMessage[]): ChatMessage[] {
  const serverIds = new Set(serverMessages.map((m) => m.id))
  // No serverId yet means the send is still in flight — there is nothing it
  // could have been reconciled against.
  const stillPending = pending.filter((p) => !(p.serverId !== undefined && serverIds.has(p.serverId)))
  return [...serverMessages, ...stillPending]
}
