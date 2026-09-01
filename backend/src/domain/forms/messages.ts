/**
 * The one trace the card leaves in the transcript. Server-owned for the same
 * reason HANDOFF_PLAYER_MESSAGES is: no prompt edit and no player-injected
 * instruction may rewrite what the player is told about their own handoff.
 *
 * A map keyed by outcome rather than a random pick, because unlike the handoff
 * line these three are not interchangeable — the whole point is that the player
 * can see which of the three happened. None promises a wait, none apologises,
 * and none is empty: postMessage refuses a blank body at the choke point, and a
 * blank system card would record nothing anywhere.
 */
export const FORM_SUMMARY_MESSAGES = {
  completed: 'Thanks — your answers are with the team now.',
  partial: 'Thanks — what you answered is with the team now.',
  skipped: 'No problem — this is with the team now.',
} as const;

export function formSummaryMessage(status: keyof typeof FORM_SUMMARY_MESSAGES): string {
  return FORM_SUMMARY_MESSAGES[status];
}
