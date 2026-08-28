/**
 * The one question both paths ask. A constant, not model output and not
 * agent-authored: the player's Yes/No is only meaningful as an answer to a
 * question whose wording the code controls (spec 4 §3's whole safety argument).
 * The agent path posts it; the bot phrases its own ask inside the reply that
 * accompanies answer_from_article, and shares only the banner.
 */
export const RESOLUTION_CHECK_MESSAGE = 'Did this solve it?';

/**
 * The answer a Yes on the agent's ask posts on the player's behalf. Paired with
 * RESOLUTION_DECLINE_MESSAGE: an agent watching the thread has to see which way
 * the player answered, and a status badge flipping to `resolved` in the inbox
 * is not the transcript saying so.
 *
 * Only the agent path posts it. The bot's Yes goes through applyBotTurn's
 * `resolve`, which the model's own confirm_resolution tool also reaches — the
 * two must keep writing exactly the same rows.
 */
export const RESOLUTION_CONFIRM_MESSAGE = 'Yes, my issue is resolved.';

/**
 * The answer a No on the agent's ask posts on the player's behalf. Tapping No
 * used to write nothing a human could see: the phase flipped back and the
 * agent's transcript stayed exactly as it was, reading as if the player had
 * never answered. A fixed constant for the same reason the question is one —
 * the transcript records an answer to a known question, not free text.
 */
export const RESOLUTION_DECLINE_MESSAGE = "No, I'm still having issues.";

/**
 * Posted by the bot itself when player_declared_resolved fires (applyBotTurn's
 * `confirm_player_resolution` case), moving confirm_phase to 'player_stated'.
 * The player just said, in their own words, that this is resolved — but the
 * tool never resolves anything on its own, so this double-checks in the same
 * fixed wording every time, same reasoning as RESOLUTION_CHECK_MESSAGE: the
 * banner's Yes/No is only meaningful as an answer to a question the code
 * controls, not free text the model could phrase differently turn to turn.
 */
export const RESOLUTION_SELF_CHECK_MESSAGE =
  "Just to confirm — you'd like me to mark this as resolved and close the ticket?";
