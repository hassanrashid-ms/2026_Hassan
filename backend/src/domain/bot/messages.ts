// backend/src/domain/bot/messages.ts
import type { UnavailableReason } from './botTurn.ts'

/**
 * The player-facing handoff lines. Server-owned, never model output: the bot's
 * only job on a handoff is to call the `handoff` tool, and the words the player
 * reads are picked from here. A rewritten workspace prompt, or a player's own
 * injected instruction, therefore cannot reach this text.
 *
 * A list rather than one constant so a player who hands off twice in a session
 * is not answered by the same sentence verbatim — the repetition is what makes
 * a support tool feel broken. They stay interchangeable in meaning: every line
 * says a human is coming and nothing else. None of them apologises, promises a
 * wait time, or characterises the problem, because the same list serves a clean
 * handoff and a bot crash, and the player must not be able to tell which they
 * got (see `applyBotTurn`'s `unavailable` branch).
 */
export const HANDOFF_PLAYER_MESSAGES = [
  "You're being connected to our support team.",
  "I'm passing this to our support team now.",
  'Connecting you with a member of our support team.',
  "Our support team will take it from here — they'll reply in this chat.",
  "I'm handing this over to a human on our support team.",
] as const

/**
 * Random rather than round-robin: a counter would have to live somewhere, and
 * the only honest place for it is the database — a write on every handoff, and
 * a shared row every workspace contends on, to solve a problem nobody has. The
 * only property that matters is that consecutive handoffs usually differ.
 *
 * Callers must not cache the result across messages: the `unavailable` branch
 * posts one public line and one internal note, and reusing a pick there is
 * fine, but two separate handoffs must each draw again.
 */
export function pickHandoffMessage(): string {
  return HANDOFF_PLAYER_MESSAGES[Math.floor(Math.random() * HANDOFF_PLAYER_MESSAGES.length)]!
}

/** The agent-only note for an `unavailable` outcome whose reason is not silent. */
export function botFailureNote(reason: UnavailableReason): string {
  return `Bot could not respond (\`${reason}\`). Handed off unclassified.`
}
