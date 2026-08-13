/**
 * The one question both paths ask. A constant, not model output and not
 * agent-authored: the player's Yes/No is only meaningful as an answer to a
 * question whose wording the code controls (spec 4 §3's whole safety argument).
 * The agent path posts it; the bot phrases its own ask inside the reply that
 * accompanies offer_article, and shares only the banner.
 */
export const RESOLUTION_CHECK_MESSAGE = 'Did this solve it?'
