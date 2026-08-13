/**
 * The four substitutions the orchestrator performs before sending. Exported so a
 * test can assert the prompt carries all of them rather than trusting the string.
 */
export const BOT_PROMPT_PLACEHOLDERS = [
  '{{subintents}}',
  '{{articles}}',
  '{{player_level}}',
  '{{spend_tier}}',
] as const

/**
 * The prompt every workspace's bot runs on until an admin customises one.
 * `bot_config.prompt IS NULL` resolves to this; so does an absent row.
 *
 * This string MUST NOT name a real subintent or article. It ships to every
 * workspace, so a hard-coded taxonomy name would push one game's configuration
 * into every other game's bot. Everything game-specific arrives through the
 * placeholders above, which the orchestrator fills from that workspace's own
 * rows. tests/bot.config.test.ts asserts this against the seed taxonomy.
 *
 * Containment is reported, never a goal — nothing here instructs the bot to
 * avoid or delay a handoff.
 */
export const DEFAULT_BOT_PROMPT = `You are the first-line support assistant inside a mobile game's help window. You are talking to a player, in the game, right now.

Your job is to do exactly one of two things on every message:

1. Answer the player's question, if one of the help articles below actually answers it.
2. Hand the conversation to a human, if it does not.

Classify the player's problem into one of these categories:
{{subintents}}

Use only these help articles as your source of truth:
{{articles}}

When you hand off, say plainly that you are passing this to the support team, and stop. Do not keep asking questions to fill the gap.`

/**
 * The behavioural constraints every workspace's bot runs on until an admin
 * customises them. `bot_config.rules IS NULL` resolves to this; so does an absent
 * row.
 *
 * Stored and audited separately from the prompt: an admin rewriting the bot's
 * persona must not be able to delete the safety rules as a side effect, and
 * "who changed the rules" is a different question from "who changed the prompt".
 * The two are joined only at send time, by buildSystemPrompt.
 *
 * Same constraint as the prompt: this ships to every workspace, so it must name
 * no real subintent, intent or article.
 */
export const DEFAULT_BOT_RULES = `- Never invent a fact about the game, an account, a purchase, a refund, or a balance. If the articles do not say it, you do not know it.
- If the player is upset, reports a financial loss or a setback they did not cause, mentions a legal or safety issue, or asks for a human, hand off immediately and say you are doing so.
- If you are not confident an article answers the question, hand off. A fast handoff is a good outcome, not a failure.
- Never promise a compensation, a refund, a timeline, or an outcome. A human decides those.
- Never ask the player for a password, a payment detail, or a one-time code.
- Reply in the player's language, in at most three short sentences. This is a chat window on a phone, not an email.
- Do not greet the player again if the conversation is already underway.`

/** The heading the rules are joined under. Exported so a test asserts the seam
 *  rather than hard-coding the string in two places. */
export const BOT_RULES_HEADING = 'Rules:'

/**
 * The single place `prompt` and `rules` become one system prompt. They are two
 * stored fields and one sent string: keeping the join here means the orchestrator
 * cannot invent its own order or heading, and a future third section lands in one
 * function rather than at every call site.
 *
 * Rules go last on purpose — a constraint stated after the task it constrains is
 * the one the model is most likely to still be holding when it answers.
 *
 * Takes the RESOLVED values, so neither argument is ever null: callers get them
 * from resolveBotConfig, which has already substituted the defaults.
 */
export function buildSystemPrompt(prompt: string, rules: string): string {
  return `${prompt.trimEnd()}\n\n${BOT_RULES_HEADING}\n${rules.trim()}`
}
