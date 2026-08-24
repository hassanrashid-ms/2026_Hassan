import type { ChatMessage } from '@/features/chat/components/types';

/**
 * Whether to render "Bot is typing…" under the thread.
 *
 * Split out on the ticketOutcome.ts pattern: it is the piece with real
 * branching, and ChatBubbles renders through Virtuoso, which lays out nothing in
 * jsdom — so this is the only place the rule is testable at all.
 *
 * The load-bearing condition is `deliveryState`. The optimistic bubble is
 * appended in the send mutation's onMutate, i.e. on the click, so keying off
 * "the last message is the player's" alone claimed the bot was composing a reply
 * to a message that had not left the device yet. 'sending' means the POST is
 * still in flight and 'failed' means it never landed; in neither case is there
 * anything on the server for the bot to be answering.
 */
export function showBotTyping(args: {
  lastMessage: ChatMessage | undefined;
  status: string | undefined;
  settled: boolean;
  confirmPending: boolean;
  hasActiveForm: boolean;
}): boolean {
  const { lastMessage, status, settled, confirmPending, hasActiveForm } = args;
  if (status !== 'bot_active') return false;
  if (settled || confirmPending || hasActiveForm) return false;
  if (lastMessage?.authorType !== 'player') return false;
  return lastMessage.deliveryState !== 'sending' && lastMessage.deliveryState !== 'failed';
}
