// backend/src/domain/bot/messages.ts
import type { UnavailableReason } from './botTurn.ts'

/**
 * Identical on every handoff, deliberate or failed — a crash must be
 * indistinguishable from a clean handoff to the player. A fixed constant, not
 * model output, so a rewritten prompt or a player's own injected instruction
 * cannot reach it.
 */
export const HANDOFF_PLAYER_MESSAGE = "You're being connected to our support team."

/** The agent-only note for an `unavailable` outcome whose reason is not silent. */
export function botFailureNote(reason: UnavailableReason): string {
  return `Bot could not respond (\`${reason}\`). Handed off unclassified.`
}
