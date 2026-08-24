import type { ConversationStatusValue, ResolutionSourceValue } from '@support/types';

/** The statuses that mean this ticket is over. Everything else is still live. */
const FINISHED: ReadonlySet<ConversationStatusValue> = new Set(['resolved', 'closed']);

const LIVE_LABEL: Record<Exclude<ConversationStatusValue, 'resolved' | 'closed'>, string> = {
  new: 'New',
  bot_active: 'With the bot',
  open: 'Open',
  awaiting_player: 'Awaiting player',
  escalated: 'Escalated',
};

function reopenSuffix(reopenCount: number): string {
  if (reopenCount <= 0) return '';
  if (reopenCount === 1) return ' · reopened once';
  if (reopenCount === 2) return ' · reopened twice';
  return ` · reopened ${reopenCount} times`;
}

export function ticketOutcome(
  status: ConversationStatusValue,
  resolutionSource: ResolutionSourceValue | null,
  resolvedByAgentName: string | null,
  reopenCount: number,
): string {
  // Status gates this, not resolution_source alone. A live ticket has no
  // outcome yet, and a reopened one keeps the source of the resolution that was
  // undone — reading either as an outcome labels an open ticket "Closed" or
  // "Resolved by Sam" while an agent is still working it.
  if (!FINISHED.has(status)) {
    return `${LIVE_LABEL[status as keyof typeof LIVE_LABEL]}${reopenSuffix(reopenCount)}`;
  }
  if (resolutionSource === null) return `Closed${reopenSuffix(reopenCount)}`;
  const by = resolutionSource === 'agent' ? (resolvedByAgentName ?? 'an agent') : 'the bot';
  return `Resolved by ${by}${reopenSuffix(reopenCount)}`;
}
