import type { LimitKey, LimitToggleValue } from '@support/types';

export type LimitCatalogEntry = {
  key: LimitKey;
  label: string;
  consequence: string;
  defaultValue: number;
  min: number;
  max: number;
};

/**
 * Defaults are today's hardcoded constants (MAX_BOT_MESSAGES=8,
 * MAX_TOOL_CALLS_PER_TURN=6, MAX_ARTICLES_PER_TURN=3 in toolLoop.ts/tools.ts) —
 * changing them here would be a behavior change, not a parity refactor.
 * `max_unhelped_replies` is the one genuinely new ceiling: it has no prior
 * constant to match, and defaults to 3 per the design conversation that added
 * it (see docs/plans/2026-08-19-bot-config-tab-backend-implementation-plan.md).
 */
export const LIMIT_CATALOG: readonly LimitCatalogEntry[] = [
  {
    key: 'max_bot_messages',
    label: 'Max bot messages per conversation',
    consequence:
      'Conversation force-hands-off once the bot has sent this many messages, regardless of progress.',
    defaultValue: 8,
    min: 3,
    max: 20,
  },
  {
    key: 'max_tool_calls_per_turn',
    label: 'Max tool calls per turn',
    consequence: 'The model is cut off mid-turn once it hits this many tool calls in one turn.',
    defaultValue: 6,
    min: 2,
    max: 15,
  },
  {
    key: 'max_articles_per_turn',
    label: 'Max article searches per turn',
    consequence:
      'Additional search_articles calls in the same turn are rejected with a limit-reached message.',
    defaultValue: 3,
    min: 1,
    max: 10,
  },
  {
    key: 'max_unhelped_replies',
    label: 'Max unhelped replies before handoff',
    consequence:
      'Conversation hands off once this many bot replies have passed since the last confirmed-helped resolution, even if the raw message cap has not been hit.',
    defaultValue: 3,
    min: 1,
    max: 8,
  },
] as const;

/** "Version 1" — what a freshly seeded or reset-to-default workspace's limits look like. */
export function buildBaselineLimits(): LimitToggleValue[] {
  return LIMIT_CATALOG.map((l) => ({ key: l.key, value: l.defaultValue }));
}

export function clampLimitBounds(
  key: LimitKey,
  value: number,
): { ok: true } | { ok: false; min: number; max: number } {
  const entry = LIMIT_CATALOG.find((l) => l.key === key)!;
  if (value < entry.min || value > entry.max) return { ok: false, min: entry.min, max: entry.max };
  return { ok: true };
}
