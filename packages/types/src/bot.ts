import { z } from 'zod';

/**
 * NOT part of the frozen SDK contract — ships with the server, same as
 * articles.ts. Shared by the agent console and OpenAPI.
 */

export const TOGGLEABLE_TOOL_NAMES = [
  'search_articles',
  'classify',
  'answer_from_article',
  'confirm_resolution',
  'player_declared_resolved',
] as const;
export type ToggleableToolName = (typeof TOGGLEABLE_TOOL_NAMES)[number];

/**
 * `enforcement` is deliberately absent: it's never client-settable — the server
 * derives it from the catalog (builtin) or hardcodes 'prompt' (custom) — so
 * including it here would let an admin mislabel a rule as code-enforced.
 */
const RuleEntrySchema = z
  .object({
    key: z.string().min(1),
    text: z.string().min(1),
    enabled: z.boolean(),
    locked: z.boolean(),
    source: z.enum(['builtin', 'custom']),
  })
  .strict();
export type RuleEntryValue = z.infer<typeof RuleEntrySchema>;

const ToolToggleSchema = z
  .object({
    tool: z.enum(TOGGLEABLE_TOOL_NAMES),
    enabled: z.boolean(),
  })
  .strict();
export type ToolToggleValue = z.infer<typeof ToolToggleSchema>;

export const LIMIT_KEYS = [
  'max_bot_messages',
  'max_tool_calls_per_turn',
  'max_articles_per_turn',
  'max_unhelped_replies',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

/**
 * Shape-only validation. Per-key min/max bounds live in `LIMIT_CATALOG`
 * (Task 6.5) and are enforced in `saveBotConfig` (Task 7.5), not here — same
 * split as `validateRules`/`validateToolsConfig`, so a bound violation's 422
 * can name the offending key's actual allowed range.
 */
const LimitToggleSchema = z
  .object({
    key: z.enum(LIMIT_KEYS),
    value: z.number().int().positive(),
  })
  .strict();
export type LimitToggleValue = z.infer<typeof LimitToggleSchema>;

/**
 * A partial save: an omitted key means "leave this field alone", and an explicit
 * null on `prompt` / `rules` / `tools_config` / `limits_config` means "reset to
 * the catalog baseline". Mirrors the `BotConfigSave` contract in
 * backend/src/domain/bot/botConfig.ts, so the two cannot drift.
 *
 * No `.min(1)` on `prompt`: an empty or whitespace-only value is rejected by the
 * domain's `EmptyBotPrompt`, which names the offending COLUMN.
 *
 * `.strict()` so a typo'd key is a 422 rather than a silently ignored no-op save.
 */
export const SaveBotConfigBody = z
  .object({
    is_provisioned: z.boolean().optional(),
    prompt: z.string().nullable().optional(),
    rules: z.array(RuleEntrySchema).nullable().optional(),
    tools_config: z.array(ToolToggleSchema).nullable().optional(),
    limits_config: z.array(LimitToggleSchema).nullable().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.is_provisioned !== undefined ||
      body.prompt !== undefined ||
      body.rules !== undefined ||
      body.tools_config !== undefined ||
      body.limits_config !== undefined,
    {
      message:
        'At least one of is_provisioned, prompt, rules, tools_config or limits_config is required.',
    },
  );
export type SaveBotConfigBodyValue = z.infer<typeof SaveBotConfigBody>;

export const TestBotTurnBody = z
  .object({
    config: z.object({
      prompt: z.string().min(1),
      rules: z.array(RuleEntrySchema),
      tools_config: z.array(ToolToggleSchema),
      limits_config: z.array(LimitToggleSchema),
    }),
    subintent_id: z.string().nullable(),
    confirm_phase: z.enum([
      'none',
      'bot_article',
      'agent_ask',
      'form',
      'inactivity_ask',
      'player_stated',
    ]),
    history: z.array(
      z.object({
        author_type: z.enum(['player', 'bot']),
        body: z.string(),
      }),
    ),
    player_message: z.string().min(1),
  })
  .strict();

export type TestBotTurnBodyValue = z.infer<typeof TestBotTurnBody>;

export type BotTestTurnHandoffReason =
  | 'asked_for_person'
  | 'article_rejected'
  | 'no_article'
  | 'sensitive'
  | 'unsure'
  | 'turn_cap'
  | 'unhelped_cap';

export type BotTestTurnUnavailableReason =
  'not_provisioned' | 'error' | 'timeout' | 'invalid_response';

export type BotTestTurnSearch = { query: string; results: { id: string; title: string }[] };

export type BotTestTurnDecision = (
  | { kind: 'noop' }
  | {
      kind: 'answer';
      reply: string;
      subintent_id: string | null;
      article_id?: string;
      grounding?: { score: number; ungrounded: string[] };
    }
  | { kind: 'resolve'; subintent_id: string | null }
  | { kind: 'handoff'; reason: BotTestTurnHandoffReason; subintent_id: string | null }
  | { kind: 'unavailable'; reason: BotTestTurnUnavailableReason }
  | { kind: 'confirm_player_resolution'; subintent_id: string | null; quoted_text: string }
) & { searches?: BotTestTurnSearch[] };

export type RuleEntryView = RuleEntryValue & { enforcement: 'code' | 'prompt' };

/**
 * `prompt`, `rules`, `tools_config` are always populated — every workspace has a
 * real seeded row. `system_prompt` is the buildSystemPrompt join, the only
 * string the bot is actually sent. `enabled_tools` is the resolved set (as a
 * sorted array) — what `toolsForPhase` actually filters against. The three
 * `is_*_customized` flags are diffs against the current catalog baseline, not
 * null-checks (there is no more null state to check).
 */
export type BotConfigView = {
  is_provisioned: boolean;
  prompt: string;
  rules: RuleEntryView[];
  tools_config: ToolToggleValue[];
  enabled_tools: string[];
  limits_config: LimitToggleValue[];
  resolved_limits: Record<LimitKey, number>;
  system_prompt: string;
  is_prompt_customized: boolean;
  is_rules_customized: boolean;
  is_tools_customized: boolean;
  is_limits_customized: boolean;
  updated_at: string | null;
};

export type BotConfigVersionActorView = { id: string; display_name: string; email: string };

export const BOT_CONFIG_VERSIONED_FIELDS = [
  'prompt',
  'rules',
  'tools_config',
  'limits_config',
] as const;
export type BotConfigVersionedField = (typeof BOT_CONFIG_VERSIONED_FIELDS)[number];

/** One row in the version list — no full snapshot payload, kept light for paging. */
export type BotConfigVersionSummaryView = {
  version: number;
  actor: BotConfigVersionActorView;
  changed_fields: BotConfigVersionedField[];
  created_at: string;
};

/** `next_cursor` null means this is the last page. Cursor is the last-seen version number. */
export type BotConfigVersionsListResponse = {
  versions: BotConfigVersionSummaryView[];
  next_cursor: number | null;
};

/** Full snapshot for one version — fetched on demand when a row is expanded. */
export type BotConfigVersionSnapshotView = BotConfigVersionSummaryView & {
  prompt: string;
  rules: RuleEntryValue[];
  tools_config: ToolToggleValue[];
  limits_config: LimitToggleValue[];
};

export const BotConfigVersionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});
export type BotConfigVersionsQueryValue = z.infer<typeof BotConfigVersionsQuery>;

export const RollbackBotConfigVersionBody = z
  .object({
    version: z.number().int().positive(),
  })
  .strict();
export type RollbackBotConfigVersionBodyValue = z.infer<typeof RollbackBotConfigVersionBody>;
