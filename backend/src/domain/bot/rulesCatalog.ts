import { DEFAULT_BOT_RULES } from './defaultPrompt.ts'

export type RuleEnforcement = 'code' | 'prompt'

export type RuleEntry = {
  key: string
  text: string
  enabled: boolean
  locked: boolean
  source: 'builtin' | 'custom'
}

type CatalogRule = {
  key: string
  text: string
  defaultEnabled: true
  locked: boolean
  enforcement: RuleEnforcement
}

/**
 * Verbatim split of DEFAULT_BOT_RULES, in its shipped order — the doc's
 * illustrative rule wording is NOT the catalog. See
 * docs/specs/2026-08-19-bot-config-tab-design.md "Built-in rule catalog".
 */
export const DEFAULT_BOT_RULES_CATALOG: readonly CatalogRule[] = [
  {
    key: 'no_invented_facts',
    text: 'Never invent a fact about the game, an account, a purchase, a refund, or a balance. If the articles do not say it, you do not know it.',
    defaultEnabled: true,
    locked: false,
    enforcement: 'code',
  },
  {
    key: 'handoff_immediate',
    text: 'If the player asks for a human, mentions a legal or safety issue, or is upset with you rather than with the game, hand off immediately, without searching first.',
    defaultEnabled: true,
    locked: true,
    enforcement: 'prompt',
  },
  {
    key: 'search_before_financial_handoff',
    text: 'If the player reports a financial loss or a setback they did not cause, search before you hand off. A published article on the exact problem is faster than a queue, and answering from it costs the player nothing — they can still say it did not help, which hands them off. Never resolve or dismiss the complaint yourself.',
    defaultEnabled: true,
    locked: false,
    enforcement: 'prompt',
  },
  {
    key: 'handoff_after_empty_search',
    text: 'If a search comes back with nothing that answers the question, hand off. A fast handoff is a good outcome, not a failure — but "fast" means after one search, not instead of one.',
    defaultEnabled: true,
    locked: false,
    enforcement: 'prompt',
  },
  {
    key: 'no_promises',
    text: 'Never promise a compensation, a refund, a timeline, or an outcome. A human decides those.',
    defaultEnabled: true,
    locked: false,
    enforcement: 'prompt',
  },
  {
    key: 'no_credentials',
    text: 'Never ask the player for a password, a payment detail, or a one-time code.',
    defaultEnabled: true,
    locked: true,
    enforcement: 'prompt',
  },
  {
    key: 'language_and_length',
    text: "Reply in the player's language. Keep an ordinary reply to at most three short sentences — this is a chat window on a phone, not an email. An answer drawn from an article may run longer when its steps need the room: never drop or merge a step to fit, and never pad past what the article says.",
    defaultEnabled: true,
    locked: false,
    enforcement: 'prompt',
  },
  {
    key: 'no_regreet',
    text: 'Do not greet the player again if the conversation is already underway.',
    defaultEnabled: true,
    locked: false,
    enforcement: 'prompt',
  },
] as const

export const LOCKED_RULE_KEYS: ReadonlySet<string> = new Set(
  DEFAULT_BOT_RULES_CATALOG.filter((r) => r.locked).map((r) => r.key),
)

export const BUILTIN_RULE_KEYS: ReadonlySet<string> = new Set(DEFAULT_BOT_RULES_CATALOG.map((r) => r.key))

/** enforcement is display-only and never stored — always re-derived from the catalog. */
export function deriveEnforcement(entry: { key: string; source: 'builtin' | 'custom' }): RuleEnforcement {
  if (entry.source === 'custom') return 'prompt'
  return DEFAULT_BOT_RULES_CATALOG.find((r) => r.key === entry.key)?.enforcement ?? 'prompt'
}

/** "Version 1" — what a freshly seeded or reset-to-default workspace's rules look like. */
export function buildBaselineRules(): RuleEntry[] {
  return DEFAULT_BOT_RULES_CATALOG.map((r) => ({
    key: r.key,
    text: r.text,
    enabled: true,
    locked: r.locked,
    source: 'builtin' as const,
  }))
}
