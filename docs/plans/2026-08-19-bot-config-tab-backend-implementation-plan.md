# Bot Config Tab — Part 1: Backend (API & Data Layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This is Part 1 of 2.** It covers the schema, domain logic, service/controller/router, and audit-log rollback plumbing — everything needed for the `/agent/bot-config*` endpoints to work correctly, with no frontend changes. Part 2, `2026-08-19-bot-config-tab-frontend-implementation-plan.md` (Tasks 14–20 of the original combined plan), builds the three-tab admin console UI on top of this and performs the final full-stack validation against the spec. Complete this plan first — Part 2's frontend tasks call the endpoints this plan produces.

**Goal:** Replace the free-text `rules` column with a toggleable rule catalog, add deterministic per-workspace tool enable/disable, seed every workspace with a real "version 1" baseline row, and expose it all through `/agent/bot-config` (get/save), `/agent/bot-config/history` and the new `/agent/bot-config/rollback` endpoints — all with zero behavior change for a workspace that has never customised anything. (The three-tab admin console UI that consumes these endpoints is Part 2.)

**Architecture:** `bot_config.prompt`/`rules`/`tools_config` become `NOT NULL` columns with a real seeded baseline row per workspace (no more virtual NULL-resolves-to-default). `rules` becomes a `RuleEntry[]` jsonb array (catalog rules + admin-added custom rules); `tools_config` is a new `ToolToggle[]` jsonb array. `toolsForPhase` gains a second `enabledTools` parameter and filters the tool-calling array before it ever reaches the model — the determinism the spec requires. `change_log` (already used for prompt/is_provisioned) gains `'rules'` and `'tools_config'` field values and backs a new rollback endpoint. A fourth jsonb array, `limits_config` (`LimitToggle[]`), makes the previously hardcoded numeric ceilings — `MAX_BOT_MESSAGES`, `MAX_TOOL_CALLS_PER_TURN`, `MAX_ARTICLES_PER_TURN` — per-workspace editable, and adds a new, independent ceiling (`max_unhelped_replies`) that forces a handoff once N bot replies have passed since the last confirmed-helped resolution, without waiting for the raw message cap.

**Tech Stack:** Express 5 + Zod + Drizzle ORM (backend), Vitest.

## Global Constraints

- **Behavior parity is non-negotiable.** `buildSystemPrompt(DEFAULT_BOT_PROMPT, buildBaselineRules())` must render **character-for-character identical** to today's `` `${DEFAULT_BOT_PROMPT.trimEnd()}\n\nRules:\n${DEFAULT_BOT_RULES.trim()}` ``, `toolsForPhase(phase, <all 4 toggleable names>)` must be `deepEqual` (including order) to today's `toolsForPhase(phase)`, and `toolLoopDecider` run with `buildBaselineLimits()` resolved values must behave identically to today's hardcoded `MAX_BOT_MESSAGES=8` / `MAX_TOOL_CALLS_PER_TURN=6` / `MAX_ARTICLES_PER_TURN=3` — the new `max_unhelped_replies` ceiling is the one deliberate exception, since it is new behavior, not a parity-preserving refactor of an existing constant.
- **`enforcement` is never client-settable.** It is derived server-side from the catalog for builtin keys and hardcoded `'prompt'` for custom entries — it is not part of `RuleEntrySchema` and not stored in the `rules` jsonb column.
- **Locked rule keys are `handoff_immediate` and `no_credentials`.** (The spec's validation section names one of these `handoff_on_request` — that is a typo for `handoff_immediate`, the key actually defined in the catalog table. Use `handoff_immediate` everywhere in code.)
- **No hard deletes; `change_log` stays append-only.** A rollback is a new audited save, never a mutation of history (matches the codebase-wide rule in `CLAUDE.md`).
- **RLS convention: "not yours" and "not there" are indistinguishable.** The rollback endpoint returns `404` for both an unknown `change_log_id` and one belonging to another workspace (this plan deliberately does **not** implement the spec Testing section's literal "422 on cross-workspace id" — under RLS a cross-workspace row is invisible to a scoped read, so it cannot be distinguished from "unknown" without bypassing tenancy, which we do not do). `422` is reserved for a `change_log_id` that resolves but whose stored `field` doesn't match the request body's `field`.
- Every new endpoint gets registered in `backend/src/docs/openapi.ts` in the same task that adds the route.

## Execution / Validation Policy

**Per task:** the only automated check at the end of each task is running the relevant Vitest suite (`pnpm --filter @support/api test <file>` or `pnpm --filter @support/types test`, as scoped in each task's steps). **Do not run an AI/LLM-driven code review or "does this look right" pass per task** — a green test run is sufficient to move to the next task.

**There is no holistic spec-scope review at the end of this plan.** That review (originally "Task 20") requires the frontend to exist too, so it lives at the end of Part 2 (`2026-08-19-bot-config-tab-frontend-implementation-plan.md`) and walks the spec against the combined output of both plans.

---

### Task 1: Rules & tools catalog module

**Files:**
- Create: `backend/src/domain/bot/rulesCatalog.ts`
- Test: `backend/tests/bot.rulesCatalog.test.ts`

**Interfaces:**
- Produces: `RuleEntry` type (`{ key: string; text: string; enabled: boolean; locked: boolean; source: 'builtin' | 'custom' }`), `RuleEnforcement` (`'code' | 'prompt'`), `DEFAULT_BOT_RULES_CATALOG` (readonly array of `{ key, text, defaultEnabled: true, locked, enforcement }`), `LOCKED_RULE_KEYS: ReadonlySet<string>`, `BUILTIN_RULE_KEYS: ReadonlySet<string>`, `deriveEnforcement(entry: { key: string; source: 'builtin' | 'custom' }): RuleEnforcement`, `buildBaselineRules(): RuleEntry[]`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/bot.rulesCatalog.test.ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOT_RULES } from '../src/domain/bot/defaultPrompt.ts'
import {
  BUILTIN_RULE_KEYS,
  DEFAULT_BOT_RULES_CATALOG,
  LOCKED_RULE_KEYS,
  buildBaselineRules,
  deriveEnforcement,
} from '../src/domain/bot/rulesCatalog.ts'

describe('DEFAULT_BOT_RULES_CATALOG', () => {
  it('is a verbatim split of DEFAULT_BOT_RULES, in order, every entry enabled by default', () => {
    const rebuilt = DEFAULT_BOT_RULES_CATALOG.map((r) => `- ${r.text}`).join('\n')
    expect(rebuilt).toBe(DEFAULT_BOT_RULES)
    expect(DEFAULT_BOT_RULES_CATALOG.every((r) => r.defaultEnabled)).toBe(true)
  })

  it('has exactly 8 entries, matching today\'s catalog size', () => {
    expect(DEFAULT_BOT_RULES_CATALOG).toHaveLength(8)
  })

  it('locks exactly handoff_immediate and no_credentials', () => {
    expect(LOCKED_RULE_KEYS).toEqual(new Set(['handoff_immediate', 'no_credentials']))
  })

  it('marks no_invented_facts as code-enforced and every other builtin as prompt-enforced', () => {
    const byKey = new Map(DEFAULT_BOT_RULES_CATALOG.map((r) => [r.key, r.enforcement]))
    expect(byKey.get('no_invented_facts')).toBe('code')
    for (const [key, enforcement] of byKey) {
      if (key !== 'no_invented_facts') expect(enforcement).toBe('prompt')
    }
  })
})

describe('BUILTIN_RULE_KEYS', () => {
  it('contains every catalog key', () => {
    expect(BUILTIN_RULE_KEYS).toEqual(new Set(DEFAULT_BOT_RULES_CATALOG.map((r) => r.key)))
  })
})

describe('deriveEnforcement', () => {
  it('looks up a builtin key in the catalog', () => {
    expect(deriveEnforcement({ key: 'no_invented_facts', source: 'builtin' })).toBe('code')
    expect(deriveEnforcement({ key: 'no_regreet', source: 'builtin' })).toBe('prompt')
  })

  it('is always prompt for a custom entry, regardless of key', () => {
    expect(deriveEnforcement({ key: 'anything', source: 'custom' })).toBe('prompt')
  })
})

describe('buildBaselineRules', () => {
  it('returns one RuleEntry per catalog row, all enabled, source builtin, in catalog order', () => {
    const baseline = buildBaselineRules()
    expect(baseline).toHaveLength(8)
    expect(baseline.every((r) => r.enabled && r.source === 'builtin')).toBe(true)
    expect(baseline.map((r) => r.key)).toEqual(DEFAULT_BOT_RULES_CATALOG.map((r) => r.key))
  })

  it('marks locked entries locked and everything else unlocked', () => {
    const baseline = buildBaselineRules()
    const locked = baseline.filter((r) => r.locked).map((r) => r.key)
    expect(new Set(locked)).toEqual(LOCKED_RULE_KEYS)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test bot.rulesCatalog -- --run`
Expected: FAIL — `Cannot find module '../src/domain/bot/rulesCatalog.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/domain/bot/rulesCatalog.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/api test bot.rulesCatalog -- --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/bot/rulesCatalog.ts backend/tests/bot.rulesCatalog.test.ts
git commit -m "feat(bot-config): add rules catalog module"
```

---

### Task 2: Shared types for rules, tools, and rollback

**Files:**
- Modify: `packages/types/src/bot.ts`
- Test: `packages/types/tests/bot.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RuleEntrySchema`/`RuleEntryValue`, `TOGGLEABLE_TOOL_NAMES` (`['search_articles', 'classify', 'answer_from_article', 'confirm_resolution']`), `ToolToggleSchema`/`ToolToggleValue`, `LIMIT_KEYS` (`['max_bot_messages', 'max_tool_calls_per_turn', 'max_articles_per_turn', 'max_unhelped_replies']`), `LimitToggleSchema`/`LimitToggleValue`, updated `SaveBotConfigBody` (now takes `rules: RuleEntryValue[] | null`, `tools_config: ToolToggleValue[] | null`, `limits_config: LimitToggleValue[] | null`), `RollbackBotConfigBody` (`field` enum now includes `'limits_config'`), `RuleEntryView` (`RuleEntryValue & { enforcement: 'code' | 'prompt' }`), updated `BotConfigView` (`rules: RuleEntryView[]`, `tools_config: ToolToggleValue[]`, `enabled_tools: string[]`, `is_tools_customized: boolean`, `limits_config: LimitToggleValue[]`, `resolved_limits: Record<string, number>`, `is_limits_customized: boolean`).

**Note on bounds:** `LimitToggleSchema` validates shape only (`key` is one of `LIMIT_KEYS`, `value` is a positive integer) — it does **not** enforce the per-key min/max bounds from `LIMIT_CATALOG` (Task 6.5). Bounds are a domain concern, checked in `saveBotConfig` (Task 7.5) so the 422 error can name the offending key and its actual bound, the same reason `validateRules`/`validateToolsConfig` live in the domain layer rather than in Zod.

- [ ] **Step 1: Write the failing tests**

Replace the two `SaveBotConfigBody` tests that assert the old string-based `rules` shape, and add new ones, in `packages/types/tests/bot.test.ts`:

```ts
// Replace this existing test body:
it('accepts a single field on its own', () => {
  expect(SaveBotConfigBody.safeParse({ is_provisioned: true }).success).toBe(true)
  expect(SaveBotConfigBody.safeParse({ prompt: 'Be helpful.' }).success).toBe(true)
  expect(
    SaveBotConfigBody.safeParse({
      rules: [{ key: 'no_regreet', text: 'Do not greet twice.', enabled: true, locked: false, source: 'builtin' }],
    }).success,
  ).toBe(true)
})

// Replace this existing test body:
it('accepts explicit null as a reset for prompt, rules, tools_config and limits_config', () => {
  const parsed = SaveBotConfigBody.safeParse({ prompt: null, rules: null, tools_config: null, limits_config: null })
  expect(parsed.success).toBe(true)
  expect(parsed.data).toEqual({ prompt: null, rules: null, tools_config: null, limits_config: null })
})

// New describe block, appended at the end of the file:
describe('RuleEntrySchema (via SaveBotConfigBody.rules)', () => {
  it('rejects an entry carrying enforcement — it is never client-settable', () => {
    const parsed = SaveBotConfigBody.safeParse({
      rules: [{ key: 'k', text: 't', enabled: true, locked: false, source: 'custom', enforcement: 'code' }],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an entry with empty text', () => {
    const parsed = SaveBotConfigBody.safeParse({
      rules: [{ key: 'k', text: '', enabled: true, locked: false, source: 'custom' }],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('ToolToggleSchema (via SaveBotConfigBody.tools_config)', () => {
  it('accepts every toggleable tool name', () => {
    const parsed = SaveBotConfigBody.safeParse({
      tools_config: [
        { tool: 'search_articles', enabled: true },
        { tool: 'classify', enabled: true },
        { tool: 'answer_from_article', enabled: false },
        { tool: 'confirm_resolution', enabled: true },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an unknown tool name, including handoff', () => {
    expect(SaveBotConfigBody.safeParse({ tools_config: [{ tool: 'handoff', enabled: false }] }).success).toBe(false)
    expect(SaveBotConfigBody.safeParse({ tools_config: [{ tool: 'nope', enabled: true }] }).success).toBe(false)
  })
})

describe('LimitToggleSchema (via SaveBotConfigBody.limits_config)', () => {
  it('accepts every limit key', () => {
    const parsed = SaveBotConfigBody.safeParse({
      limits_config: [
        { key: 'max_bot_messages', value: 10 },
        { key: 'max_tool_calls_per_turn', value: 5 },
        { key: 'max_articles_per_turn', value: 2 },
        { key: 'max_unhelped_replies', value: 4 },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an unknown key', () => {
    expect(SaveBotConfigBody.safeParse({ limits_config: [{ key: 'nope', value: 5 }] }).success).toBe(false)
  })

  it('rejects a non-positive-integer value', () => {
    expect(SaveBotConfigBody.safeParse({ limits_config: [{ key: 'max_bot_messages', value: 0 }] }).success).toBe(
      false,
    )
    expect(
      SaveBotConfigBody.safeParse({ limits_config: [{ key: 'max_bot_messages', value: 2.5 }] }).success,
    ).toBe(false)
  })
})

describe('RollbackBotConfigBody', () => {
  it('accepts a valid rollback request', () => {
    expect(
      RollbackBotConfigBody.safeParse({ field: 'rules', change_log_id: '42', side: 'before' }).success,
    ).toBe(true)
  })

  it('accepts limits_config as a rollback field', () => {
    expect(
      RollbackBotConfigBody.safeParse({ field: 'limits_config', change_log_id: '42', side: 'before' }).success,
    ).toBe(true)
  })

  it('rejects an unknown field or side', () => {
    expect(RollbackBotConfigBody.safeParse({ field: 'nope', change_log_id: '1', side: 'before' }).success).toBe(false)
    expect(RollbackBotConfigBody.safeParse({ field: 'rules', change_log_id: '1', side: 'sideways' }).success).toBe(
      false,
    )
  })
})
```

Add the two new imports (`RollbackBotConfigBody`) to the top `import` line.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/types test bot -- --run`
Expected: FAIL — old `SaveBotConfigBody` still treats `rules` as `z.string().nullable().optional()`, so the array-shaped payloads fail parsing, and `RollbackBotConfigBody` doesn't exist.

- [ ] **Step 3: Write the implementation**

In `packages/types/src/bot.ts`, replace the whole file body from the `SaveBotConfigBody` export onward (keep the file's opening `import { z } from 'zod'` and its comment):

```ts
export const TOGGLEABLE_TOOL_NAMES = ['search_articles', 'classify', 'answer_from_article', 'confirm_resolution'] as const
export type ToggleableToolName = (typeof TOGGLEABLE_TOOL_NAMES)[number]

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
  .strict()
export type RuleEntryValue = z.infer<typeof RuleEntrySchema>

const ToolToggleSchema = z
  .object({
    tool: z.enum(TOGGLEABLE_TOOL_NAMES),
    enabled: z.boolean(),
  })
  .strict()
export type ToolToggleValue = z.infer<typeof ToolToggleSchema>

export const LIMIT_KEYS = ['max_bot_messages', 'max_tool_calls_per_turn', 'max_articles_per_turn', 'max_unhelped_replies'] as const
export type LimitKey = (typeof LIMIT_KEYS)[number]

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
  .strict()
export type LimitToggleValue = z.infer<typeof LimitToggleSchema>

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
    { message: 'At least one of is_provisioned, prompt, rules, tools_config or limits_config is required.' },
  )
export type SaveBotConfigBodyValue = z.infer<typeof SaveBotConfigBody>

export const RollbackBotConfigBody = z
  .object({
    field: z.enum(['prompt', 'rules', 'tools_config', 'limits_config']),
    change_log_id: z.string().min(1),
    side: z.enum(['before', 'after']),
  })
  .strict()
export type RollbackBotConfigBodyValue = z.infer<typeof RollbackBotConfigBody>

/**
 * `limit` is coerced because Express query values are always strings. The 200 cap
 * is the page ceiling; `cursor` is opaque and is validated by the server's cursor
 * decoder, not here — its format is not part of the contract.
 */
export const ChangeLogHistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
})
export type ChangeLogHistoryQueryValue = z.infer<typeof ChangeLogHistoryQuery>

export type RuleEntryView = RuleEntryValue & { enforcement: 'code' | 'prompt' }

/**
 * `prompt`, `rules`, `tools_config` are always populated — every workspace has a
 * real seeded row. `system_prompt` is the buildSystemPrompt join, the only
 * string the bot is actually sent. `enabled_tools` is the resolved set (as a
 * sorted array) — what `toolsForPhase` actually filters against. The three
 * `is_*_customized` flags are diffs against the current catalog baseline, not
 * null-checks (there is no more null state to check).
 */
export type BotConfigView = {
  is_provisioned: boolean
  prompt: string
  rules: RuleEntryView[]
  tools_config: ToolToggleValue[]
  enabled_tools: string[]
  limits_config: LimitToggleValue[]
  resolved_limits: Record<LimitKey, number>
  system_prompt: string
  is_prompt_customized: boolean
  is_rules_customized: boolean
  is_tools_customized: boolean
  is_limits_customized: boolean
  updated_at: string | null
}

export type ChangeLogActorView = { id: string; display_name: string; email: string }

/**
 * `field` is the COLUMN name — 'is_provisioned' | 'prompt' | 'rules' |
 * 'tools_config' — never an API field name, so the trail stays readable against
 * the schema.
 *
 * `before_value` null means the field had no value before (first time it was
 * ever set); `after_value` null means it was cleared back to the default. The
 * two nulls are different facts and must not be collapsed on display.
 *
 * `id` is a string because change_log.id is a bigserial: a JSON number cannot
 * hold it safely and a JS bigint cannot be serialised at all.
 */
export type ChangeLogEntryView = {
  id: string
  field: string
  before_value: unknown
  after_value: unknown
  actor: ChangeLogActorView
  changed_at: string
}

/** `next_cursor` null means this is the last page. */
export type ChangeLogHistoryResponse = {
  entries: ChangeLogEntryView[]
  next_cursor: string | null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/types test bot -- --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/bot.ts packages/types/tests/bot.test.ts
git commit -m "feat(bot-config): add rule/tool/rollback types"
```

---

### Task 3: Schema change — `bot_config.rules` becomes jsonb, add `tools_config`

**Files:**
- Modify: `backend/src/shared/db/schema/bot.ts`
- Create: `backend/drizzle/0008_bot_config_rules_and_tools.sql` (interim, hand-authored)
- Create: `backend/src/shared/db/migrations/backfillBotConfig.ts`
- Create: `backend/drizzle/0009_bot_config_finalize.sql` (final, hand-authored)
- Modify: `backend/package.json` (add `db:backfill-bot-config` script)

This task has no unit test of its own — it is exercised by Task 7's `resolveBotConfig`/`saveBotConfig` tests and the migration is verified by running it against the local dev database. Do these steps **in order**, on a database that already has `db:setup` applied (i.e. the `bot_config` table exists in its current shape).

**Ordering note:** Step 3's backfill script imports `getOrCreateSystemActor` (Task 4), `buildBaselineToolsConfig` (Task 6), and `buildBaselineLimits` (Task 6.5), none of which exist yet this early in the plan. Do Steps 1–2 now (they're pure SQL, no app-code dependency). Then do Task 1 (already before this task), Task 4, Task 6, and Task 6.5 before coming back to write and run Step 3 and Step 4 of this task. Steps 5–7 (finalize migration) then proceed normally, after the backfill has run.

- [ ] **Step 1: Generate the interim migration file**

Run: `pnpm --filter @support/api exec drizzle-kit generate --custom --name bot_config_rules_and_tools`

This creates an empty timestamped SQL file under `backend/drizzle/`. Rename/confirm it is `0008_bot_config_rules_and_tools.sql` (adjust the number to whatever drizzle-kit actually assigned) and replace its contents with:

```sql
-- Add the new columns now, nullable — the backfill script populates them before
-- the NOT NULL constraint lands in the finalize migration.
ALTER TABLE "bot_config" ADD COLUMN "tools_config" jsonb;
ALTER TABLE "bot_config" ADD COLUMN "limits_config" jsonb;

-- rules moves from free text to a structured RuleEntry[] array. The old column
-- is kept under a new name until the backfill script has read it — dropping it
-- in the same migration that adds the replacement would lose the one thing the
-- backfill needs to preserve (an admin's existing free-text customisation).
ALTER TABLE "bot_config" RENAME COLUMN "rules" TO "rules_legacy_text";
ALTER TABLE "bot_config" ADD COLUMN "rules" jsonb;
```

- [ ] **Step 2: Update the schema file to the interim shape and apply**

In `backend/src/shared/db/schema/bot.ts`, leave `prompt` and the renamed legacy column as-is for now — this migration is pure SQL, not schema-diff-driven, so `schema/bot.ts` does not need an interim edit. Apply it:

Run: `pnpm --filter @support/api db:setup`
Expected: the migration applies cleanly (no data assumptions yet — both new columns are nullable).

- [ ] **Step 3: Write the backfill script**

```ts
// backend/src/shared/db/migrations/backfillBotConfig.ts
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { getEnv } from '../../../env.ts'
import { loadRootEnv } from '../../../env/loadRootEnv.ts'
import { logger } from '../../logging/logger.ts'
import { DEFAULT_BOT_PROMPT } from '../../../domain/bot/defaultPrompt.ts'
import { buildBaselineRules, type RuleEntry } from '../../../domain/bot/rulesCatalog.ts'
import { buildBaselineToolsConfig } from '../../../domain/bot/tools.ts'
import { buildBaselineLimits } from '../../../domain/bot/limitsCatalog.ts'
import { getOrCreateSystemActor } from '../../../domain/bot/systemActor.ts'
import { appendChangeLog } from '../../changeLog/appendChangeLog.ts'
import { BOT_CONFIG_ENTITY_TYPE } from '../../../domain/bot/botConfig.ts'

type LegacyRow = { workspaceId: string; prompt: string | null; rulesLegacyText: string | null }

/**
 * One-time data migration, run manually between the interim and finalize
 * schema migrations (see docs/plans/2026-08-19-bot-config-tab-implementation-plan.md
 * Task 3). Idempotent: a row whose `rules` column is already populated is
 * skipped, so re-running this after a partial failure is safe.
 */
export async function backfillBotConfig(url: string = getEnv().MIGRATION_DATABASE_URL): Promise<void> {
  const pool = new Pool({ connectionString: url })
  const db = drizzle(pool)
  try {
    const rows = await db.execute<LegacyRow & { rules: unknown }>(
      `select workspace_id as "workspaceId", prompt, rules_legacy_text as "rulesLegacyText", rules
         from bot_config where rules is null`,
    )

    for (const row of rows.rows as (LegacyRow & { rules: unknown })[]) {
      await db.transaction(async (tx) => {
        const actorId = await getOrCreateSystemActor(tx)

        const afterPrompt = row.prompt ?? DEFAULT_BOT_PROMPT
        const baseline = buildBaselineRules()
        const afterRules: RuleEntry[] =
          row.rulesLegacyText === null
            ? baseline
            : [
                ...baseline,
                { key: `legacy-${randomUUID()}`, text: row.rulesLegacyText, enabled: true, locked: false, source: 'custom' },
              ]
        const afterTools = buildBaselineToolsConfig()
        const afterLimits = buildBaselineLimits()

        await tx.execute(
          `update bot_config set prompt = $2, rules = $3::jsonb, tools_config = $4::jsonb, limits_config = $5::jsonb where workspace_id = $1`,
          [row.workspaceId, afterPrompt, JSON.stringify(afterRules), JSON.stringify(afterTools), JSON.stringify(afterLimits)],
        )

        const changes = [
          ...(row.prompt === null ? [{ field: 'prompt', before: null, after: afterPrompt }] : []),
          { field: 'rules', before: row.rulesLegacyText, after: afterRules },
          { field: 'tools_config', before: null, after: afterTools },
          { field: 'limits_config', before: null, after: afterLimits },
        ]
        await appendChangeLog(tx, {
          workspaceId: row.workspaceId,
          entityType: BOT_CONFIG_ENTITY_TYPE,
          entityId: row.workspaceId,
          actorId,
          changes,
        })
      })
      logger.info('db', 'backfilled bot_config row', { workspaceId: row.workspaceId })
    }
  } finally {
    await pool.end()
  }
}

if (process.argv[1]?.endsWith('backfillBotConfig.ts')) {
  loadRootEnv(import.meta.url)
  await backfillBotConfig()
  logger.info('db', 'bot_config backfill complete')
}
```

Add to `backend/package.json` `scripts`:

```json
"db:backfill-bot-config": "node --experimental-strip-types src/shared/db/migrations/backfillBotConfig.ts"
```

(Per the ordering note above: Task 4 adds `getOrCreateSystemActor` in `backend/src/domain/bot/systemActor.ts`, Task 6 adds `buildBaselineToolsConfig` in `tools.ts`, and Task 6.5 adds `buildBaselineLimits` in `limitsCatalog.ts` — this script won't compile until all three land. Do Task 4, Task 6, and Task 6.5 before Step 4 below.)

- [ ] **Step 4: Run the backfill against the dev database**

Run: `pnpm --filter @support/api db:backfill-bot-config`
Expected: completes with one log line per pre-existing `bot_config` row (0 lines on a fresh database — fine).

- [ ] **Step 5: Generate and write the finalize migration**

Run: `pnpm --filter @support/api exec drizzle-kit generate --custom --name bot_config_finalize`, confirm it's `0009_bot_config_finalize.sql`, and write:

```sql
ALTER TABLE "bot_config" ALTER COLUMN "prompt" SET NOT NULL;
ALTER TABLE "bot_config" ALTER COLUMN "rules" SET NOT NULL;
ALTER TABLE "bot_config" ALTER COLUMN "tools_config" SET NOT NULL;
ALTER TABLE "bot_config" ALTER COLUMN "limits_config" SET NOT NULL;
ALTER TABLE "bot_config" DROP COLUMN "rules_legacy_text";
```

- [ ] **Step 6: Update the schema file to the final shape**

```ts
// backend/src/shared/db/schema/bot.ts
import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { workspace } from './identity.ts'

const tz = { withTimezone: true, mode: 'date' } as const

/**
 * What the orchestrator gates on, and the prompt it sends.
 *
 * Every workspace has a real row from the moment it's provisioned — see
 * seedBotConfig in domain/bot/botConfig.ts. `prompt`, `rules` and
 * `tools_config` are NOT NULL: there is no more virtual "resolve absent to
 * default" for these three columns. A genuinely absent bot_config ROW (a
 * workspace that predates seeding, or a test that never seeded one) still
 * resolves to the off state on the catalog baseline — that collapse lives in
 * resolveBotConfig, the only place it's allowed to happen.
 */
export const botConfig = pgTable('bot_config', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  isProvisioned: boolean('is_provisioned').notNull().default(false),
  prompt: text('prompt').notNull(),
  /** RuleEntry[] — the toggleable catalog plus any admin-added custom rules. */
  rules: jsonb('rules').notNull(),
  /** ToolToggle[] — one entry per TOOL_CATALOG name (never 'handoff'). */
  toolsConfig: jsonb('tools_config').notNull(),
  /** LimitToggle[] — one entry per LIMIT_CATALOG key; see domain/bot/limitsCatalog.ts. */
  limitsConfig: jsonb('limits_config').notNull(),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
})
```

Run: `pnpm --filter @support/api db:setup`
Expected: the finalize migration applies cleanly (every row already has non-null `prompt`/`rules`/`tools_config` from Step 4).

- [ ] **Step 7: Commit**

```bash
git add backend/src/shared/db/schema/bot.ts backend/drizzle/0008_bot_config_rules_and_tools.sql \
  backend/drizzle/0009_bot_config_finalize.sql backend/drizzle/meta backend/src/shared/db/migrations/backfillBotConfig.ts \
  backend/package.json
git commit -m "feat(bot-config): migrate rules to jsonb, add tools_config column"
```

---

### Task 4: System actor for seed-time audit rows

**Files:**
- Create: `backend/src/domain/bot/systemActor.ts`
- Test: `backend/tests/bot.systemActor.test.ts`

**Interfaces:**
- Produces: `SYSTEM_ACTOR_EMAIL`, `getOrCreateSystemActor(tx: Tx): Promise<string>`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/bot.systemActor.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { getOrCreateSystemActor, SYSTEM_ACTOR_EMAIL } from '../src/domain/bot/systemActor.ts'
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts'

describe('getOrCreateSystemActor', () => {
  let workspaceId: string

  beforeEach(async () => {
    await truncateAll()
    workspaceId = await seedWorkspace()
  })

  it('creates the system agent row on first call', async () => {
    const id = await withWorkspace(workspaceId, (tx) => getOrCreateSystemActor(tx))
    const { rows } = await ownerPool.query(`select email, display_name from agent where id = $1`, [id])
    expect(rows[0]).toEqual({ email: SYSTEM_ACTOR_EMAIL, display_name: 'System' })
  })

  it('returns the same id on a second call rather than inserting twice', async () => {
    const first = await withWorkspace(workspaceId, (tx) => getOrCreateSystemActor(tx))
    const second = await withWorkspace(workspaceId, (tx) => getOrCreateSystemActor(tx))
    expect(second).toBe(first)
    const { rows } = await ownerPool.query(`select count(*)::int as n from agent where email = $1`, [
      SYSTEM_ACTOR_EMAIL,
    ])
    expect(rows[0]).toEqual({ n: 1 })
  })
})

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test bot.systemActor -- --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/domain/bot/systemActor.ts
import { eq } from 'drizzle-orm'
import type { Tx } from '../../shared/db/withWorkspace.ts'
import { agent } from '../../shared/db/schema/index.ts'

/**
 * `change_log.actor_id` is NOT NULL with a real FK — "every row is a human
 * act" per the schema comment. Seeding a baseline is the one exception the
 * spec calls out ("actor: 'system'"), so it needs a real `agent` row to point
 * at rather than a nullable actor column that would quietly permit others.
 * `agent` is one of the two unscoped tables, so a single global row is correct.
 */
export const SYSTEM_ACTOR_EMAIL = 'system@internal.support'

export async function getOrCreateSystemActor(tx: Tx): Promise<string> {
  const [existing] = await tx.select({ id: agent.id }).from(agent).where(eq(agent.email, SYSTEM_ACTOR_EMAIL)).limit(1)
  if (existing) return existing.id

  const [created] = await tx
    .insert(agent)
    .values({ email: SYSTEM_ACTOR_EMAIL, displayName: 'System' })
    .onConflictDoNothing({ target: agent.email })
    .returning({ id: agent.id })
  if (created) return created.id

  // Lost a race with a concurrent seed — the row now exists, read it back.
  const [row] = await tx.select({ id: agent.id }).from(agent).where(eq(agent.email, SYSTEM_ACTOR_EMAIL)).limit(1)
  return row!.id
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/api test bot.systemActor -- --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/bot/systemActor.ts backend/tests/bot.systemActor.test.ts
git commit -m "feat(bot-config): add system actor for seed-time audit rows"
```

---

### Task 5: `buildSystemPrompt` takes `RuleEntry[]`

**Files:**
- Modify: `backend/src/domain/bot/defaultPrompt.ts`
- Modify: `backend/tests/bot.config.test.ts` (the `buildSystemPrompt` describe block)

**Interfaces:**
- Consumes: `RuleEntry` from `./rulesCatalog.ts`, `buildBaselineRules` for the parity test.
- Produces: `buildSystemPrompt(prompt: string, rules: RuleEntry[]): string`.

- [ ] **Step 1: Write the failing test**

Replace the existing `describe('buildSystemPrompt', ...)` block in `backend/tests/bot.config.test.ts` with:

```ts
describe('buildSystemPrompt', () => {
  const rule = (text: string, enabled = true): RuleEntry => ({
    key: text,
    text,
    enabled,
    locked: false,
    source: 'builtin',
  })

  it('sends the prompt and enabled rule texts as one string, prompt first and rules last', () => {
    const built = buildSystemPrompt('PROMPT BODY', [rule('RULE ONE')])
    expect(built).toContain('PROMPT BODY')
    expect(built).toContain('RULE ONE')
    expect(built.indexOf('PROMPT BODY')).toBeLessThan(built.indexOf(BOT_RULES_HEADING))
    expect(built.indexOf(BOT_RULES_HEADING)).toBeLessThan(built.indexOf('RULE ONE'))
  })

  it('omits a disabled rule entirely', () => {
    const built = buildSystemPrompt('P', [rule('KEEP ME'), rule('DROP ME', false)])
    expect(built).toContain('KEEP ME')
    expect(built).not.toContain('DROP ME')
  })

  it('renders each enabled rule as "- {text}", in array order', () => {
    const built = buildSystemPrompt('P', [rule('first'), rule('second')])
    const rulesBlock = built.slice(built.indexOf(BOT_RULES_HEADING))
    expect(rulesBlock.indexOf('- first')).toBeLessThan(rulesBlock.indexOf('- second'))
  })

  it('PARITY: an unmodified catalog baseline renders byte-identical to the old string-rules formula', () => {
    const built = buildSystemPrompt(DEFAULT_BOT_PROMPT, buildBaselineRules())
    const oldFormula = `${DEFAULT_BOT_PROMPT.trimEnd()}\n\n${BOT_RULES_HEADING}\n${DEFAULT_BOT_RULES.trim()}`
    expect(built).toBe(oldFormula)
  })

  it('keeps the placeholders intact — the orchestrator substitutes after the join', () => {
    const built = buildSystemPrompt(DEFAULT_BOT_PROMPT, buildBaselineRules())
    expect(built).toContain('{{subintents}}')
    expect(built).toContain('{{articles}}')
  })
})
```

Add `import { buildBaselineRules, type RuleEntry } from '../src/domain/bot/rulesCatalog.ts'` to the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test bot.config -- --run -t buildSystemPrompt`
Expected: FAIL — current `buildSystemPrompt(prompt: string, rules: string)` called with an array throws or mismatches.

- [ ] **Step 3: Write the implementation**

In `backend/src/domain/bot/defaultPrompt.ts`, replace the `buildSystemPrompt` function (keep `DEFAULT_BOT_PROMPT`, `DEFAULT_BOT_RULES`, `BOT_PROMPT_PLACEHOLDERS`, `BOT_RULES_HEADING` exactly as-is — `DEFAULT_BOT_RULES` stays exported permanently as the parity test's ground truth):

```ts
import type { RuleEntry } from './rulesCatalog.ts'

// ... (BOT_PROMPT_PLACEHOLDERS, DEFAULT_BOT_PROMPT, DEFAULT_BOT_RULES, BOT_RULES_HEADING unchanged above) ...

/**
 * The single place `prompt` and `rules` become one system prompt. Rules go
 * last on purpose — a constraint stated after the task it constrains is the
 * one the model is most likely to still be holding when it answers.
 *
 * Renders enabled entries in ARRAY order — callers (resolveBotConfig,
 * saveBotConfig) are responsible for that being catalog-declaration order
 * followed by custom entries in the order they were added. This function does
 * not reorder anything.
 */
export function buildSystemPrompt(prompt: string, rules: RuleEntry[]): string {
  const rulesBlock = rules
    .filter((r) => r.enabled)
    .map((r) => `- ${r.text}`)
    .join('\n')
  return `${prompt.trimEnd()}\n\n${BOT_RULES_HEADING}\n${rulesBlock.trim()}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/api test bot.config -- --run -t buildSystemPrompt`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/bot/defaultPrompt.ts backend/tests/bot.config.test.ts
git commit -m "feat(bot-config): buildSystemPrompt takes RuleEntry[]"
```

---

### Task 6: Tool catalog and deterministic `toolsForPhase`

**Files:**
- Modify: `backend/src/domain/bot/tools.ts`
- Create: `backend/tests/bot.tools.test.ts`

**Interfaces:**
- Produces: `TOOL_CATALOG` (readonly array of `{ name, lockable: true, defaultEnabled: true, consequence }`, names `search_articles`, `classify`, `answer_from_article`, `confirm_resolution`, in that order), `buildBaselineToolsConfig(): ToolToggle[]`, `type ToolToggle = { tool: string; enabled: boolean }`, updated `toolsForPhase(phase: ToolPhase, enabledTools: ReadonlySet<string>): unknown[]`.
- Consumes (by later tasks): nothing changes in `ALWAYS_AVAILABLE_TOOLS`/`CONFIRM_RESOLUTION_TOOL`/`TOOL_DEFS`/`searchArticles`/`resolveClassifyIndex` — keep those exactly as they are today.

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/bot.tools.test.ts
import { describe, expect, it } from 'vitest'
import { CONFIRM_RESOLUTION_TOOL_NAME, TOOL_CATALOG, buildBaselineToolsConfig, toolsForPhase } from '../src/domain/bot/tools.ts'

const ALL_TOGGLEABLE = new Set(TOOL_CATALOG.map((t) => t.name))

describe('TOOL_CATALOG', () => {
  it('lists exactly the 4 toggleable tools, excluding handoff, all default-enabled and lockable', () => {
    expect(TOOL_CATALOG.map((t) => t.name)).toEqual([
      'search_articles',
      'classify',
      'answer_from_article',
      CONFIRM_RESOLUTION_TOOL_NAME,
    ])
    expect(TOOL_CATALOG.every((t) => t.defaultEnabled && t.lockable)).toBe(true)
  })
})

describe('buildBaselineToolsConfig', () => {
  it('returns one enabled ToolToggle per catalog entry', () => {
    expect(buildBaselineToolsConfig()).toEqual(TOOL_CATALOG.map((t) => ({ tool: t.name, enabled: true })))
  })
})

describe('toolsForPhase (deterministic gating)', () => {
  it('PARITY: with every toggleable tool enabled, matches today\'s tool array exactly, in order', () => {
    const bot_article = toolsForPhase('bot_article', ALL_TOGGLEABLE)
    const agent_ask = toolsForPhase('agent_ask', ALL_TOGGLEABLE)
    expect(bot_article).toHaveLength(4)
    expect(agent_ask).toHaveLength(3)
    expect((bot_article[3] as { function: { name: string } }).function.name).toBe(CONFIRM_RESOLUTION_TOOL_NAME)
    expect((agent_ask.map((t) => (t as { function: { name: string } }).function.name))).toEqual([
      'search_articles',
      'classify',
      'answer_from_article',
    ])
  })

  it('drops a disabled tool without reordering the rest', () => {
    const enabled = new Set(['classify', 'answer_from_article', CONFIRM_RESOLUTION_TOOL_NAME])
    const names = toolsForPhase('bot_article', enabled).map((t) => (t as { function: { name: string } }).function.name)
    expect(names).toEqual(['classify', 'answer_from_article', CONFIRM_RESOLUTION_TOOL_NAME])
  })

  it('never drops handoff, even when the enabled set is empty', () => {
    const names = toolsForPhase('agent_ask', new Set()).map((t) => (t as { function: { name: string } }).function.name)
    expect(names).toEqual(['handoff'])
  })

  it('drops confirm_resolution outside bot_article regardless of the enabled set', () => {
    const names = toolsForPhase('agent_ask', ALL_TOGGLEABLE).map((t) => (t as { function: { name: string } }).function.name)
    expect(names).not.toContain(CONFIRM_RESOLUTION_TOOL_NAME)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test bot.tools -- --run`
Expected: FAIL — `TOOL_CATALOG`/`buildBaselineToolsConfig` don't exist, `toolsForPhase` takes one argument.

- [ ] **Step 3: Write the implementation**

In `backend/src/domain/bot/tools.ts`, keep everything above `toolsForPhase` unchanged (`ALWAYS_AVAILABLE_TOOLS`, `CONFIRM_RESOLUTION_TOOL`, `TOOL_DEFS`) and replace `toolsForPhase` and everything below it stays the same, but add before it:

```ts
export type ToolToggle = { tool: string; enabled: boolean }

/**
 * Declared in the same order ALWAYS_AVAILABLE_TOOLS already ships them, then
 * confirm_resolution — matches the doc's Tool gating section. `handoff` is
 * intentionally absent: always available, never configurable.
 */
export const TOOL_CATALOG = [
  {
    name: 'search_articles',
    lockable: true,
    defaultEnabled: true,
    consequence: 'Bot can never look anything up; every turn ends in classify-only or handoff.',
  },
  {
    name: 'classify',
    lockable: true,
    defaultEnabled: true,
    consequence: 'Conversations stay unclassified from the bot; agents classify manually.',
  },
  {
    name: ANSWER_FROM_ARTICLE_TOOL_NAME,
    lockable: true,
    defaultEnabled: true,
    consequence: 'Bot can search/classify but never answers itself — always hands off after searching.',
  },
  {
    name: CONFIRM_RESOLUTION_TOOL_NAME,
    lockable: true,
    defaultEnabled: true,
    consequence: 'Article answers are never confirmed by the player; bot_active exits only via handoff or the turn cap.',
  },
] as const

/** "Version 1" — every toggleable tool enabled, matching today's always-on behavior. */
export function buildBaselineToolsConfig(): ToolToggle[] {
  return TOOL_CATALOG.map((t) => ({ tool: t.name, enabled: true }))
}

/**
 * confirm_resolution is offered to the model only while confirm_phase =
 * 'bot_article' (spec 4 §3) AND it is enabled. `handoff`'s name is never
 * checked against `enabledTools` — it always passes the filter, so it stays
 * exactly where ALWAYS_AVAILABLE_TOOLS already puts it. Every other tool is
 * dropped only if its name isn't in `enabledTools`. Filter in place — never
 * reorder: a disabled tool is simply absent from the array sent to the model,
 * which is the entire determinism guarantee this function exists for.
 */
export function toolsForPhase(phase: ToolPhase, enabledTools: ReadonlySet<string>): unknown[] {
  const base = phase === 'bot_article' ? [...ALWAYS_AVAILABLE_TOOLS, CONFIRM_RESOLUTION_TOOL] : [...ALWAYS_AVAILABLE_TOOLS]
  return base.filter((t) => t.function.name === 'handoff' || enabledTools.has(t.function.name))
}
```

(Remove the old single-argument `toolsForPhase` definition it replaces.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/api test bot.tools -- --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/bot/tools.ts backend/tests/bot.tools.test.ts
git commit -m "feat(bot-config): deterministic tool gating via TOOL_CATALOG"
```

---

### Task 6.5: Limits catalog module

**Files:**
- Create: `backend/src/domain/bot/limitsCatalog.ts`
- Test: `backend/tests/bot.limitsCatalog.test.ts`

**Interfaces:**
- Produces: `LimitCatalogEntry` type (`{ key: LimitKey; label: string; consequence: string; defaultValue: number; min: number; max: number }`), `LIMIT_CATALOG` (readonly array, 4 entries in the order `max_bot_messages`, `max_tool_calls_per_turn`, `max_articles_per_turn`, `max_unhelped_replies`), `buildBaselineLimits(): LimitToggle[]`, `clampLimitBounds(key: LimitKey, value: number): { ok: true } | { ok: false; min: number; max: number }`.

This module is the numeric-limits analogue of `TOOL_CATALOG` (Task 6) — same shape, same reason: a single source of truth for defaults and bounds that both the seed/backfill path and the save-validation path (Task 7.5) read from, so a bound can never drift between "what a fresh workspace gets" and "what an admin is allowed to set."

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/bot.limitsCatalog.test.ts
import { describe, expect, it } from 'vitest'
import { LIMIT_CATALOG, buildBaselineLimits, clampLimitBounds } from '../src/domain/bot/limitsCatalog.ts'

describe('LIMIT_CATALOG', () => {
  it('lists exactly the 4 limit keys, in order, matching today\'s hardcoded constants as defaults', () => {
    expect(LIMIT_CATALOG.map((l) => l.key)).toEqual([
      'max_bot_messages',
      'max_tool_calls_per_turn',
      'max_articles_per_turn',
      'max_unhelped_replies',
    ])
    const byKey = new Map(LIMIT_CATALOG.map((l) => [l.key, l.defaultValue]))
    expect(byKey.get('max_bot_messages')).toBe(8)
    expect(byKey.get('max_tool_calls_per_turn')).toBe(6)
    expect(byKey.get('max_articles_per_turn')).toBe(3)
    expect(byKey.get('max_unhelped_replies')).toBe(3)
  })

  it('every entry has min <= defaultValue <= max', () => {
    for (const l of LIMIT_CATALOG) {
      expect(l.min).toBeLessThanOrEqual(l.defaultValue)
      expect(l.defaultValue).toBeLessThanOrEqual(l.max)
    }
  })
})

describe('buildBaselineLimits', () => {
  it('returns one LimitToggle per catalog entry, at its default value, in catalog order', () => {
    expect(buildBaselineLimits()).toEqual(LIMIT_CATALOG.map((l) => ({ key: l.key, value: l.defaultValue })))
  })
})

describe('clampLimitBounds', () => {
  it('accepts a value within [min, max]', () => {
    expect(clampLimitBounds('max_bot_messages', 8)).toEqual({ ok: true })
  })

  it('rejects a value outside [min, max], naming the actual bound', () => {
    const result = clampLimitBounds('max_bot_messages', 100)
    expect(result).toEqual({ ok: false, min: 3, max: 20 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test bot.limitsCatalog -- --run`
Expected: FAIL — `Cannot find module '../src/domain/bot/limitsCatalog.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/domain/bot/limitsCatalog.ts
import type { LimitKey, LimitToggleValue } from '@support/types'

export type LimitCatalogEntry = {
  key: LimitKey
  label: string
  consequence: string
  defaultValue: number
  min: number
  max: number
}

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
    consequence: 'Conversation force-hands-off once the bot has sent this many messages, regardless of progress.',
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
    consequence: 'Additional search_articles calls in the same turn are rejected with a limit-reached message.',
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
] as const

/** "Version 1" — what a freshly seeded or reset-to-default workspace's limits look like. */
export function buildBaselineLimits(): LimitToggleValue[] {
  return LIMIT_CATALOG.map((l) => ({ key: l.key, value: l.defaultValue }))
}

export function clampLimitBounds(
  key: LimitKey,
  value: number,
): { ok: true } | { ok: false; min: number; max: number } {
  const entry = LIMIT_CATALOG.find((l) => l.key === key)!
  if (value < entry.min || value > entry.max) return { ok: false, min: entry.min, max: entry.max }
  return { ok: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/api test bot.limitsCatalog -- --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/bot/limitsCatalog.ts backend/tests/bot.limitsCatalog.test.ts
git commit -m "feat(bot-config): add limits catalog module"
```

---

### Task 7: `resolveBotConfig` / `saveBotConfig` / `seedBotConfig` rewrite

**Files:**
- Modify: `backend/src/domain/bot/botConfig.ts`
- Modify: `backend/tests/bot.config.test.ts` (the `resolveBotConfig`/`saveBotConfig` describe blocks, plus new `seedBotConfig` block)
- Modify: `backend/tests/helpers/db.ts` (`seedBotConfig` test helper — now inserts jsonb)

**Interfaces:**
- Consumes: `RuleEntry`, `BUILTIN_RULE_KEYS`, `LOCKED_RULE_KEYS`, `buildBaselineRules` from `./rulesCatalog.ts`; `ToolToggle`, `TOOL_CATALOG`, `buildBaselineToolsConfig` from `./tools.ts`; `LIMIT_CATALOG`, `buildBaselineLimits`, `clampLimitBounds` from `./limitsCatalog.ts` (Task 6.5); `getOrCreateSystemActor` from `./systemActor.ts`; `buildSystemPrompt`, `DEFAULT_BOT_PROMPT` from `./defaultPrompt.ts`.
- Produces: `ResolvedBotConfig` (`{ isProvisioned, prompt, rules: RuleEntry[], toolsConfig: ToolToggle[], enabledTools: ReadonlySet<string>, limitsConfig: LimitToggle[], resolvedLimits: Record<LimitKey, number>, systemPrompt }`), `resolveBotConfig(tx, workspaceId)`, `EmptyBotPrompt` (unchanged), `InvalidRulesPayload`, `InvalidToolsPayload`, `InvalidLimitsPayload`, `BotConfigSave` (`{ workspaceId, actorId, isProvisioned?, prompt?: string | null, rules?: RuleEntry[] | null, toolsConfig?: ToolToggle[] | null, limitsConfig?: LimitToggle[] | null }`), `saveBotConfig(tx, input)`, `seedBotConfig(tx, workspaceId): Promise<ResolvedBotConfig>`, `BOT_CONFIG_ENTITY_TYPE` (unchanged).

- [ ] **Step 1: Update the test helper first** (other tests depend on it)

```ts
// backend/tests/helpers/db.ts — replace seedBotConfig
export async function seedBotConfig(args: {
  workspaceId: string
  isProvisioned?: boolean
  prompt?: string
  rules?: unknown[]
  toolsConfig?: unknown[]
}): Promise<void> {
  await ownerPool.query(
    `insert into bot_config (workspace_id, is_provisioned, prompt, rules, tools_config)
     values ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [
      args.workspaceId,
      args.isProvisioned ?? false,
      args.prompt ?? 'RAW SEEDED PROMPT',
      JSON.stringify(args.rules ?? []),
      JSON.stringify(args.toolsConfig ?? []),
    ],
  )
}
```

- [ ] **Step 2: Rewrite `backend/tests/bot.config.test.ts`'s `resolveBotConfig`/`saveBotConfig` blocks and add `seedBotConfig`**

Replace the `describe('resolveBotConfig', ...)` and `describe('saveBotConfig', ...)` blocks with:

```ts
describe('resolveBotConfig', () => {
  let workspaceId: string

  beforeEach(async () => {
    await truncateAll()
    workspaceId = await seedWorkspace()
  })

  it('resolves an absent row to off, with the catalog baseline prompt/rules/tools', async () => {
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(resolved.isProvisioned).toBe(false)
    expect(resolved.prompt).toBe(DEFAULT_BOT_PROMPT)
    expect(resolved.rules).toEqual(buildBaselineRules())
    expect(resolved.toolsConfig).toEqual(buildBaselineToolsConfig())
    expect(resolved.enabledTools).toEqual(new Set(TOOL_CATALOG.map((t) => t.name)))
    expect(resolved.systemPrompt).toBe(buildSystemPrompt(DEFAULT_BOT_PROMPT, buildBaselineRules()))
  })

  it('returns a stored prompt, rules and tools_config verbatim', async () => {
    const rules = [{ key: 'no_regreet', text: 'Do not greet twice.', enabled: false, locked: false, source: 'builtin' }]
    const toolsConfig = [{ tool: 'search_articles', enabled: false }]
    await seedBotConfig({ workspaceId, isProvisioned: true, prompt: 'MY PROMPT', rules, toolsConfig })
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(resolved.prompt).toBe('MY PROMPT')
    expect(resolved.rules).toEqual(rules)
    expect(resolved.toolsConfig).toEqual(toolsConfig)
    expect(resolved.enabledTools).toEqual(new Set())
  })

  it('cannot tell an absent row from is_provisioned = false — one resolver, one answer', async () => {
    const absent = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    await seedBotConfig({ workspaceId, isProvisioned: false, prompt: DEFAULT_BOT_PROMPT, rules: buildBaselineRules(), toolsConfig: buildBaselineToolsConfig() })
    const present = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(present).toEqual(absent)
  })

  it('never leaks another workspace config', async () => {
    const otherWorkspaceId = await seedWorkspace()
    await seedBotConfig({ workspaceId: otherWorkspaceId, isProvisioned: true, prompt: 'theirs' })
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(resolved.prompt).toBe(DEFAULT_BOT_PROMPT)
    expect(resolved.isProvisioned).toBe(false)
  })
})

describe('saveBotConfig', () => {
  let workspaceId: string
  let actorId: string

  beforeEach(async () => {
    await truncateAll()
    workspaceId = await seedWorkspace()
    actorId = await seedAgent()
  })

  it('creates the row on first save and upserts on the second rather than erroring', async () => {
    const first = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, isProvisioned: true, prompt: 'v1' }),
    )
    expect(first).toMatchObject({ isProvisioned: true, prompt: 'v1' })

    const second = await withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, prompt: 'v2' }))
    expect(second).toMatchObject({ isProvisioned: true, prompt: 'v2' })

    const { rows } = await ownerPool.query(`select count(*)::int as n from bot_config where workspace_id = $1`, [
      workspaceId,
    ])
    expect(rows[0]).toEqual({ n: 1 })
  })

  it('leaves an omitted field alone, and resets to the catalog baseline on an explicit null', async () => {
    const customRules = [...buildBaselineRules().slice(0, 1)]
    await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, prompt: 'custom', rules: customRules.length ? undefined : undefined }),
    )
    const cleared = await withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, prompt: null }))
    expect(cleared.prompt).toBe(DEFAULT_BOT_PROMPT)
  })

  it('rejects an empty or whitespace-only prompt instead of storing one', async () => {
    for (const blank of ['', '   ', '\n\t']) {
      await expect(
        withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, prompt: blank })),
      ).rejects.toThrow(EmptyBotPrompt)
    }
  })

  it('rejects a payload where a locked rule key is missing or disabled', async () => {
    const withoutLocked = buildBaselineRules().filter((r) => r.key !== 'no_credentials')
    await expect(
      withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, rules: withoutLocked })),
    ).rejects.toThrow(InvalidRulesPayload)

    const disabledLocked = buildBaselineRules().map((r) => (r.key === 'no_credentials' ? { ...r, enabled: false } : r))
    await expect(
      withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, rules: disabledLocked })),
    ).rejects.toThrow(InvalidRulesPayload)
  })

  it('rejects a payload missing any other builtin key, even an unlocked one', async () => {
    const withoutBuiltin = buildBaselineRules().filter((r) => r.key !== 'no_regreet')
    await expect(
      withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, rules: withoutBuiltin })),
    ).rejects.toThrow(InvalidRulesPayload)
  })

  it('rejects a rule set with zero enabled entries', async () => {
    const allDisabled = buildBaselineRules().map((r) => ({ ...r, enabled: false }))
    await expect(
      withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, rules: allDisabled })),
    ).rejects.toThrow(InvalidRulesPayload)
  })

  it('rejects a custom rule that reuses a builtin key', async () => {
    const reused = [...buildBaselineRules(), { key: 'no_regreet', text: 'dup', enabled: true, locked: false, source: 'custom' as const }]
    await expect(
      withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, rules: reused })),
    ).rejects.toThrow(InvalidRulesPayload)
  })

  it('accepts an added custom rule, appended after the catalog', async () => {
    const withCustom = [...buildBaselineRules(), { key: 'custom-1', text: 'No emoji.', enabled: true, locked: false, source: 'custom' as const }]
    const saved = await withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, rules: withCustom }))
    expect(saved.rules.at(-1)).toEqual({ key: 'custom-1', text: 'No emoji.', enabled: true, locked: false, source: 'custom' })
    expect(saved.systemPrompt).toContain('No emoji.')
  })

  it('rejects tools_config missing a catalog tool', async () => {
    const missingOne = buildBaselineToolsConfig().slice(1)
    await expect(
      withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, toolsConfig: missingOne })),
    ).rejects.toThrow(InvalidToolsPayload)
  })

  it('disabling a tool removes it from enabledTools', async () => {
    const toggled = buildBaselineToolsConfig().map((t) => (t.tool === 'search_articles' ? { ...t, enabled: false } : t))
    const saved = await withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, toolsConfig: toggled }))
    expect(saved.enabledTools.has('search_articles')).toBe(false)
    expect(saved.enabledTools.has('classify')).toBe(true)
  })

  it('bumps updated_at on a real change without touching created_at', async () => {
    await withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, prompt: 'v1' }))
    const before = await ownerPool.query<{ created_at: Date; updated_at: Date }>(
      `select created_at, updated_at from bot_config where workspace_id = $1`,
      [workspaceId],
    )
    await withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, prompt: 'v2' }))
    const after = await ownerPool.query<{ created_at: Date; updated_at: Date }>(
      `select created_at, updated_at from bot_config where workspace_id = $1`,
      [workspaceId],
    )
    expect(after.rows[0]!.created_at.getTime()).toBe(before.rows[0]!.created_at.getTime())
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThanOrEqual(before.rows[0]!.updated_at.getTime())
  })
})

describe('seedBotConfig', () => {
  let workspaceId: string

  beforeEach(async () => {
    await truncateAll()
    workspaceId = await seedWorkspace()
  })

  it('creates a real row with the catalog baseline and one change_log entry per field, attributed to the system actor', async () => {
    const resolved = await withWorkspace(workspaceId, (tx) => seedBotConfig(tx, workspaceId))
    expect(resolved.prompt).toBe(DEFAULT_BOT_PROMPT)
    expect(resolved.rules).toEqual(buildBaselineRules())
    expect(resolved.toolsConfig).toEqual(buildBaselineToolsConfig())

    const { rows } = await ownerPool.query<{ field: string; before_value: unknown; actor_id: string }>(
      `select field, before_value, actor_id from change_log where entity_type = 'bot_config' and entity_id = $1 order by field`,
      [workspaceId],
    )
    expect(rows.map((r) => r.field)).toEqual(['prompt', 'rules', 'tools_config'])
    expect(rows.every((r) => r.before_value === null)).toBe(true)
    const { rows: agentRows } = await ownerPool.query(`select email from agent where id = $1`, [rows[0]!.actor_id])
    expect(agentRows[0]).toEqual({ email: SYSTEM_ACTOR_EMAIL })
  })

  it('is a no-op when a row already exists', async () => {
    await withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId: await seedAgent(), prompt: 'already customised' }))
    const resolved = await withWorkspace(workspaceId, (tx) => seedBotConfig(tx, workspaceId))
    expect(resolved.prompt).toBe('already customised')
    const { rows } = await ownerPool.query(`select count(*)::int as n from bot_config where workspace_id = $1`, [workspaceId])
    expect(rows[0]).toEqual({ n: 1 })
  })
})
```

Update the file's top imports to add: `buildBaselineRules` and `RuleEntry`-typed helpers from `../src/domain/bot/rulesCatalog.ts`; `TOOL_CATALOG`, `buildBaselineToolsConfig` from `../src/domain/bot/tools.ts`; `SYSTEM_ACTOR_EMAIL` from `../src/domain/bot/systemActor.ts`; and `InvalidRulesPayload`, `InvalidToolsPayload`, `seedBotConfig` from `../src/domain/bot/botConfig.ts`.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @support/api test bot.config -- --run`
Expected: FAIL — current `botConfig.ts` still uses the old nullable-string model.

- [ ] **Step 4: Write the implementation**

```ts
// backend/src/domain/bot/botConfig.ts
import { eq } from 'drizzle-orm'
import type { Tx } from '../../shared/db/withWorkspace.ts'
import { botConfig } from '../../shared/db/schema/index.ts'
import { buildSystemPrompt, DEFAULT_BOT_PROMPT } from './defaultPrompt.ts'
import { BUILTIN_RULE_KEYS, LOCKED_RULE_KEYS, buildBaselineRules, type RuleEntry } from './rulesCatalog.ts'
import { TOOL_CATALOG, buildBaselineToolsConfig, type ToolToggle } from './tools.ts'
import { appendChangeLog } from '../../shared/changeLog/appendChangeLog.ts'

export type ResolvedBotConfig = {
  isProvisioned: boolean
  prompt: string
  rules: RuleEntry[]
  toolsConfig: ToolToggle[]
  /** Derived from toolsConfig — what toolsForPhase actually filters against. */
  enabledTools: ReadonlySet<string>
  systemPrompt: string
}

function resolved(isProvisioned: boolean, prompt: string, rules: RuleEntry[], toolsConfig: ToolToggle[]): ResolvedBotConfig {
  return {
    isProvisioned,
    prompt,
    rules,
    toolsConfig,
    enabledTools: new Set(toolsConfig.filter((t) => t.enabled).map((t) => t.tool)),
    systemPrompt: buildSystemPrompt(prompt, rules),
  }
}

/**
 * The one place an absent row collapses to the off state on the catalog
 * baseline. Every caller goes through here. Unlike before this migration, a
 * PRESENT row's prompt/rules/tools_config are never null — the NOT NULL
 * columns guarantee that — so this function's only remaining job is the
 * absent-row case.
 */
export async function resolveBotConfig(tx: Tx, workspaceId: string): Promise<ResolvedBotConfig> {
  const [row] = await tx
    .select({ isProvisioned: botConfig.isProvisioned, prompt: botConfig.prompt, rules: botConfig.rules, toolsConfig: botConfig.toolsConfig })
    .from(botConfig)
    .where(eq(botConfig.workspaceId, workspaceId))
    .limit(1)

  if (!row) return resolved(false, DEFAULT_BOT_PROMPT, buildBaselineRules(), buildBaselineToolsConfig())
  return resolved(row.isProvisioned, row.prompt, row.rules as RuleEntry[], row.toolsConfig as ToolToggle[])
}

export const BOT_CONFIG_ENTITY_TYPE = 'bot_config'

export class EmptyBotPrompt extends Error {
  readonly field: 'prompt'
  constructor() {
    super('Bot prompt cannot be empty — pass null to reset it to the default')
    this.name = 'EmptyBotPrompt'
    this.field = 'prompt'
  }
}

export class InvalidRulesPayload extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRulesPayload'
  }
}

export class InvalidToolsPayload extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidToolsPayload'
  }
}

/** Save-time domain validation beyond Zod's shape check (spec "API / types"). */
function validateRules(rules: readonly RuleEntry[]): void {
  const byKey = new Map(rules.map((r) => [r.key, r]))

  for (const key of BUILTIN_RULE_KEYS) {
    const entry = byKey.get(key)
    if (!entry) throw new InvalidRulesPayload(`Rules payload is missing builtin rule "${key}".`)
    if (LOCKED_RULE_KEYS.has(key) && !entry.enabled) {
      throw new InvalidRulesPayload(`"${key}" is a locked rule and cannot be disabled.`)
    }
  }

  for (const rule of rules) {
    if (rule.source === 'custom' && BUILTIN_RULE_KEYS.has(rule.key)) {
      throw new InvalidRulesPayload(`Custom rule cannot reuse builtin key "${rule.key}".`)
    }
  }

  if (!rules.some((r) => r.enabled)) {
    throw new InvalidRulesPayload('At least one rule must remain enabled.')
  }
}

function validateToolsConfig(toolsConfig: readonly ToolToggle[]): void {
  const names = new Set(toolsConfig.map((t) => t.tool))
  for (const t of TOOL_CATALOG) {
    if (!names.has(t.name)) throw new InvalidToolsPayload(`tools_config is missing "${t.name}".`)
  }
}

export type BotConfigSave = {
  workspaceId: string
  actorId: string
  isProvisioned?: boolean
  /** Omitted means leave alone; explicit null resets to DEFAULT_BOT_PROMPT. */
  prompt?: string | null
  /** Omitted means leave alone; explicit null resets to the catalog baseline. */
  rules?: RuleEntry[] | null
  /** Omitted means leave alone; explicit null resets to the catalog baseline. */
  toolsConfig?: ToolToggle[] | null
}

/**
 * The only way `bot_config` is written for an ordinary edit. `seedBotConfig`
 * below is the only OTHER writer, and it never calls this — see its own
 * before_value semantics.
 */
export async function saveBotConfig(tx: Tx, input: BotConfigSave): Promise<ResolvedBotConfig> {
  if (typeof input.prompt === 'string' && input.prompt.trim() === '') throw new EmptyBotPrompt()
  if (input.rules) validateRules(input.rules)
  if (input.toolsConfig) validateToolsConfig(input.toolsConfig)

  const [existing] = await tx
    .select({ isProvisioned: botConfig.isProvisioned, prompt: botConfig.prompt, rules: botConfig.rules, toolsConfig: botConfig.toolsConfig })
    .from(botConfig)
    .where(eq(botConfig.workspaceId, input.workspaceId))
    .limit(1)

  const beforeProvisioned = existing?.isProvisioned ?? false
  const beforePrompt = existing?.prompt ?? DEFAULT_BOT_PROMPT
  const beforeRules = (existing?.rules as RuleEntry[] | undefined) ?? buildBaselineRules()
  const beforeTools = (existing?.toolsConfig as ToolToggle[] | undefined) ?? buildBaselineToolsConfig()

  const afterProvisioned = input.isProvisioned ?? beforeProvisioned
  const afterPrompt = input.prompt === undefined ? beforePrompt : input.prompt ?? DEFAULT_BOT_PROMPT
  const afterRules = input.rules === undefined ? beforeRules : input.rules ?? buildBaselineRules()
  const afterTools = input.toolsConfig === undefined ? beforeTools : input.toolsConfig ?? buildBaselineToolsConfig()

  await tx
    .insert(botConfig)
    .values({ workspaceId: input.workspaceId, isProvisioned: afterProvisioned, prompt: afterPrompt, rules: afterRules, toolsConfig: afterTools })
    .onConflictDoUpdate({
      target: botConfig.workspaceId,
      set: { isProvisioned: afterProvisioned, prompt: afterPrompt, rules: afterRules, toolsConfig: afterTools, updatedAt: new Date() },
    })

  await appendChangeLog(tx, {
    workspaceId: input.workspaceId,
    entityType: BOT_CONFIG_ENTITY_TYPE,
    entityId: input.workspaceId,
    actorId: input.actorId,
    changes: [
      { field: 'is_provisioned', before: beforeProvisioned, after: afterProvisioned },
      { field: 'prompt', before: beforePrompt, after: afterPrompt },
      { field: 'rules', before: beforeRules, after: afterRules },
      { field: 'tools_config', before: beforeTools, after: afterTools },
    ],
  })

  return resolved(afterProvisioned, afterPrompt, afterRules, afterTools)
}

/**
 * Materialises the catalog baseline into a real row — "version 1" (spec
 * "Seeding / baseline"). A workspace that already has a row is left
 * untouched. Deliberately does NOT call saveBotConfig: a first save's
 * before-values collapse to the baseline (nothing observably changed), which
 * would make appendChangeLog drop every field as a no-op — but the seed's
 * before_value must be `null` (genuinely never set), not "collapsed to
 * baseline", so the History panel shows a real "version 1" row.
 */
export async function seedBotConfig(tx: Tx, workspaceId: string): Promise<ResolvedBotConfig> {
  const [existing] = await tx.select({ workspaceId: botConfig.workspaceId }).from(botConfig).where(eq(botConfig.workspaceId, workspaceId)).limit(1)
  if (existing) return resolveBotConfig(tx, workspaceId)

  const { getOrCreateSystemActor } = await import('./systemActor.ts')
  const actorId = await getOrCreateSystemActor(tx)

  const prompt = DEFAULT_BOT_PROMPT
  const rules = buildBaselineRules()
  const toolsConfig = buildBaselineToolsConfig()

  await tx.insert(botConfig).values({ workspaceId, isProvisioned: false, prompt, rules, toolsConfig })

  await appendChangeLog(tx, {
    workspaceId,
    entityType: BOT_CONFIG_ENTITY_TYPE,
    entityId: workspaceId,
    actorId,
    changes: [
      { field: 'prompt', before: null, after: prompt },
      { field: 'rules', before: null, after: rules },
      { field: 'tools_config', before: null, after: toolsConfig },
    ],
  })

  return resolved(false, prompt, rules, toolsConfig)
}
```

(The `await import('./systemActor.ts')` is a static-looking dynamic import used only to sidestep a circular-import risk between `botConfig.ts` and `systemActor.ts`; check whether a plain top-level `import { getOrCreateSystemActor } from './systemActor.ts'` compiles and has no cycle — `systemActor.ts` only imports `drizzle-orm` and the schema, so it does not import `botConfig.ts` and a top-level import is safe. Use the plain top-level import instead of the dynamic one shown above.)

**Apply the same shape a fourth time, for `limits_config` (Task 6.5's catalog):**

- Import `LIMIT_CATALOG`, `buildBaselineLimits`, `clampLimitBounds`, `type LimitKey` from `./limitsCatalog.ts`.
- `ResolvedBotConfig` gains `limitsConfig: LimitToggle[]` and `resolvedLimits: Record<LimitKey, number>`. Extend the `resolved(...)` helper to take `limitsConfig` and compute `resolvedLimits` as `Object.fromEntries(limitsConfig.map((l) => [l.key, l.value])) as Record<LimitKey, number>`.
- `resolveBotConfig`'s select also fetches `botConfig.limitsConfig`; the absent-row branch passes `buildBaselineLimits()`; the present-row branch casts `row.limitsConfig as LimitToggle[]`.
- Add `export class InvalidLimitsPayload extends Error { ... }`, same shape as `InvalidToolsPayload`.
- Add `validateLimitsConfig(limitsConfig: readonly LimitToggle[]): void`, mirroring `validateToolsConfig`: every `LIMIT_CATALOG` key must be present (`InvalidLimitsPayload` naming the missing key), and every present entry's value must satisfy `clampLimitBounds(key, value)` — on a bounds failure, throw `InvalidLimitsPayload` naming the key and the `{ min, max }` `clampLimitBounds` returned (e.g. `` `"max_bot_messages" must be between 3 and 20.` ``).
- `BotConfigSave` gains `limitsConfig?: LimitToggle[] | null` (omitted = leave alone, explicit `null` = reset to baseline), same as `toolsConfig`.
- `saveBotConfig`: call `if (input.limitsConfig) validateLimitsConfig(input.limitsConfig)` alongside the existing rules/tools validation; select `botConfig.limitsConfig` in the `existing` query; compute `beforeLimits`/`afterLimits` the same way `beforeTools`/`afterTools` are computed; include `limitsConfig: afterLimits` in both the `.values(...)` and `.onConflictDoUpdate(...).set(...)` calls; append a `{ field: 'limits_config', before: beforeLimits, after: afterLimits }` entry to the `changes` array; pass `afterLimits` into the final `resolved(...)` call.
- `seedBotConfig`: compute `const limitsConfig = buildBaselineLimits()`; include it in `.values(...)`; append `{ field: 'limits_config', before: null, after: limitsConfig }` to its `changes` array; pass it into the final `resolved(...)` call.

Add a matching test block to `backend/tests/bot.config.test.ts` (`describe('resolveBotConfig / saveBotConfig — limits_config', ...)`) covering: an absent row resolves to `buildBaselineLimits()` with `resolvedLimits` matching every default; a stored `limits_config` resolves verbatim into `resolvedLimits`; saving a value outside a key's bound throws `InvalidLimitsPayload` naming the bound; saving with a missing key throws `InvalidLimitsPayload`; `seedBotConfig` writes a `limits_config` change-log row with `before: null`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @support/api test bot.config -- --run`
Expected: PASS. Also now run the backfill script per Task 3 Step 4's deferred instruction: `pnpm --filter @support/api db:backfill-bot-config`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain/bot/botConfig.ts backend/tests/bot.config.test.ts backend/tests/helpers/db.ts
git commit -m "feat(bot-config): rewrite resolve/save/seed for jsonb rules and tools_config"
```

---

### Task 8: Thread `enabledTools` through `contextAssembly` and `toolLoop`

**Files:**
- Modify: `backend/src/domain/bot/contextAssembly.ts`
- Modify: `backend/src/domain/bot/toolLoop.ts`
- Create: `backend/tests/bot.toolLoop.determinism.test.ts`

**Interfaces:**
- Consumes: `resolveBotConfig` (now returns `enabledTools`), `toolsForPhase(phase, enabledTools)`.
- Produces: `BuildMessagesResult` gains `enabledTools: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/bot.toolLoop.determinism.test.ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { toolLoopDecider } from '../src/domain/bot/toolLoop.ts'
import * as openaiClient from '../src/domain/bot/openaiClient.ts'
import { saveBotConfig } from '../src/domain/bot/botConfig.ts'
import { buildBaselineToolsConfig } from '../src/domain/bot/tools.ts'
import { closeOwnerPool, seedAgent, seedConversation, seedMessage, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

describe('toolLoopDecider — deterministic tool gating', () => {
  let workspaceId: string
  let conversationId: string

  beforeEach(async () => {
    await truncateAll()
    workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    conversationId = await seedConversation({ workspaceId, playerId })
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player', body: 'help' })
    const actorId = await seedAgent()
    const toolsConfig = buildBaselineToolsConfig().map((t) => (t.tool === 'search_articles' ? { ...t, enabled: false } : t))
    await withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, isProvisioned: true, toolsConfig }))
  })

  it('never sends a disabled tool\'s schema to the model, regardless of prompt/rules content', async () => {
    const callModelSpy = vi.spyOn(openaiClient, 'callModel').mockResolvedValue({
      text: null,
      toolCalls: [{ id: '1', name: 'handoff', arguments: JSON.stringify({ reason: 'asked_for_person' }) }],
    })

    await toolLoopDecider({
      workspaceId,
      conversationId,
      subintentId: null,
      confirmPhase: 'none',
      botMessageCount: 0,
      lastPlayerMessageAt: new Date(),
      history: [],
    })

    expect(callModelSpy).toHaveBeenCalledTimes(1)
    const toolsSent = callModelSpy.mock.calls[0]![1] as { function: { name: string } }[]
    expect(toolsSent.map((t) => t.function.name)).not.toContain('search_articles')
  })
})

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test bot.toolLoop.determinism -- --run`
Expected: FAIL — `toolsForPhase(input.confirmPhase)` is still called with one argument, so `enabledTools` is never applied (`search_articles` still present), and `buildMessages` doesn't expose `enabledTools` yet.

- [ ] **Step 3: Write the implementation**

In `backend/src/domain/bot/contextAssembly.ts`:

```ts
export type BuildMessagesResult = {
  messages: ChatMessage[]
  subintentOptions: SubintentOption[]
  catalogueArticleCount: number
  /** What toolsForPhase filters against — carried out so toolLoop doesn't re-resolve config. */
  enabledTools: ReadonlySet<string>
}
```

and in `buildMessages`, change the return statement's final line:

```ts
  return { messages, subintentOptions, catalogueArticleCount: catalogue.count, enabledTools: config.enabledTools }
```

In `backend/src/domain/bot/toolLoop.ts`, change:

```ts
const { messages, subintentOptions } = await buildMessages(tx, input)
```

to:

```ts
const { messages, subintentOptions, enabledTools } = await buildMessages(tx, input)
```

and change the `callModel` call site:

```ts
const response = await callModel(conversationMessages, toolsForPhase(input.confirmPhase))
```

to:

```ts
const response = await callModel(conversationMessages, toolsForPhase(input.confirmPhase, enabledTools))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/api test bot.toolLoop.determinism -- --run`
Expected: PASS

Also run the full bot test suite to catch any other `toolsForPhase`/`buildMessages` callers that broke:

Run: `pnpm --filter @support/api test bot -- --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/bot/contextAssembly.ts backend/src/domain/bot/toolLoop.ts backend/tests/bot.toolLoop.determinism.test.ts
git commit -m "feat(bot-config): thread enabledTools from resolveBotConfig into toolLoop"
```

- [ ] **Step 6: Thread `resolvedLimits` the same way, and replace the three hardcoded ceilings**

Today `toolLoop.ts:34–35` hardcode `MAX_TOOL_CALLS_PER_TURN = 6` and `MAX_BOT_MESSAGES = 8` as module constants, and `tools.ts:28` hardcodes `MAX_ARTICLES_PER_TURN = 3`; `toolLoop.ts:63` checks `input.botMessageCount >= MAX_BOT_MESSAGES` for the `turn_cap` handoff, `toolLoop.ts:92`'s while loop guards on `toolCallCount < MAX_TOOL_CALLS_PER_TURN`, and `toolLoop.ts:128–131` checks `searchCallCount > MAX_ARTICLES_PER_TURN`. All three become per-workspace values read from `resolvedLimits` (Task 7.5) instead of module constants:

- `BuildMessagesResult` (and `buildMessages`'s return statement from Step 3 above) also carries `resolvedLimits: Record<LimitKey, number>` — same pattern as `enabledTools`, sourced from the same `config` object already in scope (`config.resolvedLimits`).
- `toolLoopDecider`'s input type gains `resolvedLimits: Record<LimitKey, number>`, destructured from `buildMessages`'s result the same way `enabledTools` is destructured in Step 3.
- Delete the `MAX_TOOL_CALLS_PER_TURN` and `MAX_BOT_MESSAGES` module constants from `toolLoop.ts`; replace every read of them with `resolvedLimits.max_tool_calls_per_turn` / `resolvedLimits.max_bot_messages`.
- Delete the `MAX_ARTICLES_PER_TURN` module constant from `tools.ts`; `toolLoop.ts`'s `searchCallCount` check reads `resolvedLimits.max_articles_per_turn` instead (threaded in the same way).
- Extend `backend/tests/bot.toolLoop.determinism.test.ts` with a case that saves `limits_config` with `max_bot_messages` set to a non-default value (e.g. 4) and asserts the decider forces a `turn_cap` handoff at that lower count rather than at 8 — this is the parity-breaking case that proves the constant was actually replaced, not just left dead in the module alongside the new field.

- [ ] **Step 7: Add the `max_unhelped_replies` ceiling — a new, independent handoff trigger**

This is new behavior, not a refactor of an existing constant (see Global Constraints). "Unhelped" is derived the same way `botMessageCount` already is — no new stored counter:

- In `backend/src/domain/bot/orchestrator.ts`, next to the existing `const botMessageCount = rows.filter((r) => r.authorType === 'bot').length` (around line 38), add `unhelpedReplyCount`: count bot messages whose `occurredAt`/sequence is **after** the conversation's most recent `conversation_resolved` event (or all bot messages, if there is no such event yet). Query the `event` table for the latest `conversation_resolved` row for this conversation (same query style as `contextAssembly.ts`'s `bot_article_offered` / `bot_article_rejected` lookups), then filter the already-fetched `rows` by timestamp against it.
- Pass `unhelpedReplyCount` into the decider's input alongside `botMessageCount`.
- In `toolLoopDecider`, add a check evaluated **before** the existing `turn_cap` check: `if (input.unhelpedReplyCount >= resolvedLimits.max_unhelped_replies) return { kind: 'handoff', reason: 'unhelped_cap', subintentId: null }`. Ordering matters — whichever ceiling is lower fires first, and `max_unhelped_replies` defaults lower (3) than `max_bot_messages` (8), so it is expected to fire first under default config.
- Add `'unhelped_cap'` to the `HandoffReason` union (wherever `'turn_cap'`, `'article_rejected'`, etc. are declared) and to `applyBotTurn.ts`'s handling of `bot_handoff` events — it needs no special payload beyond the existing `{ reason, assigned_agent_id }` shape.
- New test in `backend/tests/bot.toolLoop.determinism.test.ts` (or a new `bot.toolLoop.unhelpedCap.test.ts` if the file is getting large): seed a conversation with `max_unhelped_replies = 2`, simulate two bot replies with no `conversation_resolved` event between them, and assert the third decider call returns `{ kind: 'handoff', reason: 'unhelped_cap' }` without calling the model. A second test: seed a `conversation_resolved` event between two bot replies and confirm the counter reset — a third bot reply after that does NOT trigger `unhelped_cap` even though the conversation has sent more than `max_unhelped_replies` messages in total.

- [ ] **Step 8: Run and commit**

Run: `pnpm --filter @support/api test bot -- --run`
Expected: PASS

```bash
git add backend/src/domain/bot/contextAssembly.ts backend/src/domain/bot/toolLoop.ts backend/src/domain/bot/tools.ts backend/src/domain/bot/orchestrator.ts backend/src/domain/bot/applyBotTurn.ts backend/tests/bot.toolLoop.determinism.test.ts
git commit -m "feat(bot-config): configurable turn/tool/article ceilings and new unhelped_cap handoff"
```

---

### Task 9: `getChangeLogEntryById` for rollback lookups

**Files:**
- Modify: `backend/src/shared/changeLog/readChangeLog.ts`
- Test: `backend/tests/changeLog.getEntry.test.ts`

**Interfaces:**
- Produces: `getChangeLogEntryById(tx: Tx, input: { workspaceId: string; entityType: string; entityId: string; id: string }): Promise<ChangeLogRow | null>`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/changeLog.getEntry.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { getChangeLogEntryById } from '../src/shared/changeLog/readChangeLog.ts'
import { appendChangeLog } from '../src/shared/changeLog/appendChangeLog.ts'
import { closeOwnerPool, seedAgent, seedWorkspace, truncateAll } from './helpers/db.ts'

describe('getChangeLogEntryById', () => {
  let workspaceId: string
  let actorId: string

  beforeEach(async () => {
    await truncateAll()
    workspaceId = await seedWorkspace()
    actorId = await seedAgent()
  })

  it('returns the row scoped to workspace, entity type and entity id', async () => {
    let id = ''
    await withWorkspace(workspaceId, async (tx) => {
      await appendChangeLog(tx, { workspaceId, entityType: 'bot_config', entityId: workspaceId, actorId, changes: [{ field: 'prompt', before: null, after: 'x' }] })
    })
    const { ownerPool } = await import('./helpers/db.ts')
    const { rows } = await ownerPool.query(`select id from change_log where workspace_id = $1`, [workspaceId])
    id = String(rows[0]!.id)

    const entry = await withWorkspace(workspaceId, (tx) => getChangeLogEntryById(tx, { workspaceId, entityType: 'bot_config', entityId: workspaceId, id }))
    expect(entry).toMatchObject({ id, field: 'prompt', beforeValue: null, afterValue: 'x' })
  })

  it('returns null for an id that does not exist', async () => {
    const entry = await withWorkspace(workspaceId, (tx) => getChangeLogEntryById(tx, { workspaceId, entityType: 'bot_config', entityId: workspaceId, id: '999999' }))
    expect(entry).toBeNull()
  })

  it('returns null for a non-numeric id rather than throwing', async () => {
    const entry = await withWorkspace(workspaceId, (tx) => getChangeLogEntryById(tx, { workspaceId, entityType: 'bot_config', entityId: workspaceId, id: 'not-a-number' }))
    expect(entry).toBeNull()
  })

  it('returns null for a real id belonging to another workspace — indistinguishable from unknown', async () => {
    const otherWorkspaceId = await seedWorkspace()
    const otherActorId = await seedAgent()
    await withWorkspace(otherWorkspaceId, async (tx) => {
      await appendChangeLog(tx, { workspaceId: otherWorkspaceId, entityType: 'bot_config', entityId: otherWorkspaceId, actorId: otherActorId, changes: [{ field: 'prompt', before: null, after: 'y' }] })
    })
    const { ownerPool } = await import('./helpers/db.ts')
    const { rows } = await ownerPool.query(`select id from change_log where workspace_id = $1`, [otherWorkspaceId])
    const otherId = String(rows[0]!.id)

    const entry = await withWorkspace(workspaceId, (tx) => getChangeLogEntryById(tx, { workspaceId, entityType: 'bot_config', entityId: workspaceId, id: otherId }))
    expect(entry).toBeNull()
  })
})

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test changeLog.getEntry -- --run`
Expected: FAIL — `getChangeLogEntryById` doesn't exist.

- [ ] **Step 3: Write the implementation**

Append to `backend/src/shared/changeLog/readChangeLog.ts`:

```ts
/**
 * A single audit row by id, scoped to workspace + entity — the rollback
 * endpoint's lookup. Returns null both for a genuinely unknown id and for one
 * belonging to another workspace: under RLS those are indistinguishable from
 * inside a scoped transaction, matching this codebase's "expect 404 not 403"
 * convention (see CLAUDE.md Tenancy).
 */
export async function getChangeLogEntryById(
  tx: Tx,
  input: { workspaceId: string; entityType: string; entityId: string; id: string },
): Promise<ChangeLogRow | null> {
  if (!/^\d{1,19}$/.test(input.id)) return null

  const [row] = await tx
    .select({
      id: changeLog.id,
      field: changeLog.field,
      beforeValue: changeLog.beforeValue,
      afterValue: changeLog.afterValue,
      changedAt: changeLog.changedAt,
      actorId: agent.id,
      actorDisplayName: agent.displayName,
      actorEmail: agent.email,
    })
    .from(changeLog)
    .innerJoin(agent, eq(agent.id, changeLog.actorId))
    .where(
      and(
        eq(changeLog.workspaceId, input.workspaceId),
        eq(changeLog.entityType, input.entityType),
        eq(changeLog.entityId, input.entityId),
        eq(changeLog.id, sql`${input.id}::bigint`),
      ),
    )
    .limit(1)

  if (!row) return null
  return {
    id: String(row.id),
    field: row.field,
    beforeValue: row.beforeValue,
    afterValue: row.afterValue,
    changedAt: row.changedAt,
    actor: { id: row.actorId, displayName: row.actorDisplayName, email: row.actorEmail },
  }
}
```

(`and`, `eq`, `sql`, `agent`, `changeLog` are already imported at the top of this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/api test changeLog.getEntry -- --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/shared/changeLog/readChangeLog.ts backend/tests/changeLog.getEntry.test.ts
git commit -m "feat(bot-config): add getChangeLogEntryById for rollback lookups"
```

---

### Task 10: `botConfigService.ts` — view with enforcement, diffed customized flags, rollback

**Files:**
- Modify: `backend/src/agent/services/botConfigService.ts`

**Interfaces:**
- Consumes: `resolveBotConfig`, `saveBotConfig`, `seedBotConfig`, `deriveEnforcement`, `getChangeLogEntryById`, `buildBaselineLimits` (Task 6.5).
- Produces: `saveBotConfigForAgent` (extended input), `rollbackBotConfigForAgent(ctx, input)`, `ChangeLogEntryNotFound`, `ChangeLogFieldMismatch`. `getBotConfigView`/`listBotConfigHistory` keep their existing signatures.

There is no standalone unit test file for this task — it's exercised end-to-end by Task 12's `agent.botConfig.test.ts` HTTP tests. Write the code, then move on; Task 12 is where `pnpm test` gives you the pass/fail signal for this file.

- [ ] **Step 1: Write the implementation**

```ts
// backend/src/agent/services/botConfigService.ts
import { eq, isDeepStrictEqual } from 'drizzle-orm'
import { isDeepStrictEqual as deepEqual } from 'node:util'
import type { BotConfigView, ChangeLogHistoryResponse } from '@support/types'
import { botConfig } from '../../shared/db/schema/index.ts'
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts'
import { BOT_CONFIG_ENTITY_TYPE, resolveBotConfig, saveBotConfig } from '../../domain/bot/botConfig.ts'
import { DEFAULT_BOT_PROMPT } from '../../domain/bot/defaultPrompt.ts'
import { buildBaselineRules, deriveEnforcement, type RuleEntry } from '../../domain/bot/rulesCatalog.ts'
import { buildBaselineToolsConfig, type ToolToggle } from '../../domain/bot/tools.ts'
import { buildBaselineLimits, type LimitToggle } from '../../domain/bot/limitsCatalog.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'
import type { ChangeLogCursor } from '../../shared/changeLog/cursor.ts'
import { getChangeLogEntryById, readChangeLog } from '../../shared/changeLog/readChangeLog.ts'

async function readUpdatedAt(tx: Tx, workspaceId: string): Promise<Date | null> {
  const [row] = await tx.select({ updatedAt: botConfig.updatedAt }).from(botConfig).where(eq(botConfig.workspaceId, workspaceId)).limit(1)
  return row?.updatedAt ?? null
}

/** Shared by the read and the save so one response shape cannot drift from the other. */
async function view(tx: Tx, workspaceId: string): Promise<BotConfigView> {
  const resolved = await resolveBotConfig(tx, workspaceId)
  const updatedAt = await readUpdatedAt(tx, workspaceId)

  return {
    is_provisioned: resolved.isProvisioned,
    prompt: resolved.prompt,
    rules: resolved.rules.map((r) => ({ ...r, enforcement: deriveEnforcement(r) })),
    tools_config: resolved.toolsConfig,
    enabled_tools: [...resolved.enabledTools].sort(),
    limits_config: resolved.limitsConfig,
    resolved_limits: resolved.resolvedLimits,
    system_prompt: resolved.systemPrompt,
    // "Customised" is a diff against the current catalog baseline, not a
    // null-check — prompt/rules/tools_config/limits_config are NOT NULL now.
    is_prompt_customized: resolved.prompt !== DEFAULT_BOT_PROMPT,
    is_rules_customized: !deepEqual(resolved.rules, buildBaselineRules()),
    is_tools_customized: !deepEqual(resolved.toolsConfig, buildBaselineToolsConfig()),
    is_limits_customized: !deepEqual(resolved.limitsConfig, buildBaselineLimits()),
    updated_at: updatedAt?.toISOString() ?? null,
  }
}

export async function getBotConfigView(ctx: AgentContext): Promise<BotConfigView> {
  return withWorkspace(ctx.workspaceId, (tx) => view(tx, ctx.workspaceId))
}

export type BotConfigSaveInput = {
  isProvisioned?: boolean
  prompt?: string | null
  rules?: RuleEntry[] | null
  toolsConfig?: ToolToggle[] | null
  limitsConfig?: LimitToggle[] | null
}

export async function saveBotConfigForAgent(ctx: AgentContext, input: BotConfigSaveInput): Promise<BotConfigView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    await saveBotConfig(tx, {
      workspaceId: ctx.workspaceId,
      actorId: ctx.agentId,
      isProvisioned: input.isProvisioned,
      prompt: input.prompt,
      rules: input.rules,
      toolsConfig: input.toolsConfig,
      limitsConfig: input.limitsConfig,
    })
    return view(tx, ctx.workspaceId)
  })
}

export async function listBotConfigHistory(
  ctx: AgentContext,
  input: {
    limit: number
    cursor?: ChangeLogCursor
    field?: 'prompt' | 'rules' | 'tools_config' | 'limits_config' | 'is_provisioned'
  },
): Promise<ChangeLogHistoryResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const page = await readChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: BOT_CONFIG_ENTITY_TYPE,
      entityId: ctx.workspaceId,
      limit: input.limit,
      cursor: input.cursor,
    })

    const filtered = input.field ? page.rows.filter((r) => r.field === input.field) : page.rows

    return {
      entries: filtered.map((row) => ({
        id: row.id,
        field: row.field,
        before_value: row.beforeValue,
        after_value: row.afterValue,
        actor: { id: row.actor.id, display_name: row.actor.displayName, email: row.actor.email },
        changed_at: row.changedAt.toISOString(),
      })),
      next_cursor: page.nextCursor,
    }
  })
}

export class ChangeLogEntryNotFound extends Error {
  constructor() {
    super('No matching change_log entry.')
    this.name = 'ChangeLogEntryNotFound'
  }
}

export class ChangeLogFieldMismatch extends Error {
  constructor(actual: string, requested: string) {
    super(`change_log_id refers to field "${actual}", not "${requested}".`)
    this.name = 'ChangeLogFieldMismatch'
  }
}

/**
 * Restores a prior change_log value as the new current value — a normal,
 * newly-audited save, never a mutation of history (spec "Versioning /
 * history / rollback").
 */
export async function rollbackBotConfigForAgent(
  ctx: AgentContext,
  input: { field: 'prompt' | 'rules' | 'tools_config' | 'limits_config'; changeLogId: string; side: 'before' | 'after' },
): Promise<BotConfigView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const entry = await getChangeLogEntryById(tx, {
      workspaceId: ctx.workspaceId,
      entityType: BOT_CONFIG_ENTITY_TYPE,
      entityId: ctx.workspaceId,
      id: input.changeLogId,
    })
    if (!entry) throw new ChangeLogEntryNotFound()
    if (entry.field !== input.field) throw new ChangeLogFieldMismatch(entry.field, input.field)

    const value = input.side === 'before' ? entry.beforeValue : entry.afterValue
    const save =
      input.field === 'prompt'
        ? { prompt: value as string | null }
        : input.field === 'rules'
          ? { rules: value as RuleEntry[] | null }
          : input.field === 'tools_config'
            ? { toolsConfig: value as ToolToggle[] | null }
            : { limitsConfig: value as LimitToggle[] | null }

    await saveBotConfig(tx, { workspaceId: ctx.workspaceId, actorId: ctx.agentId, ...save })
    return view(tx, ctx.workspaceId)
  })
}
```

(Drop the unused `isDeepStrictEqual` import from `drizzle-orm` if the linter flags it — only the `node:util` one is used; keep just `import { isDeepStrictEqual } from 'node:util'` and drop the drizzle-orm re-import shown above.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @support/api typecheck`
Expected: no new errors from this file (controller/router in the next task will still reference the old shapes until Task 11 lands — that's expected and fixed there).

- [ ] **Step 3: Commit**

```bash
git add backend/src/agent/services/botConfigService.ts
git commit -m "feat(bot-config): service layer for enforcement view, diffed customized flags, rollback"
```

---

### Task 11: Controller + router — extended save, `field` filter, rollback endpoint

**Files:**
- Modify: `backend/src/agent/controllers/botConfigController.ts`
- Modify: `backend/src/agent/routers/botConfigRouter.ts`

**Interfaces:**
- Consumes: `SaveBotConfigBody`, `RollbackBotConfigBody`, `ChangeLogHistoryQuery` from `@support/types`; `EmptyBotPrompt`, `InvalidRulesPayload`, `InvalidToolsPayload`, `InvalidLimitsPayload` from `../../domain/bot/botConfig.ts`; `ChangeLogEntryNotFound`, `ChangeLogFieldMismatch`, `rollbackBotConfigForAgent` from the service.
- Produces: `rollbackBotConfigHandler`.

- [ ] **Step 1: Write the implementation**

```ts
// backend/src/agent/controllers/botConfigController.ts
import type { RequestHandler } from 'express'
import { ChangeLogHistoryQuery, RollbackBotConfigBody, SaveBotConfigBody } from '@support/types'
import { sendError } from '../../errors.ts'
import { EmptyBotPrompt, InvalidRulesPayload, InvalidToolsPayload, InvalidLimitsPayload } from '../../domain/bot/botConfig.ts'
import { decodeChangeLogCursor } from '../../shared/changeLog/cursor.ts'
import {
  ChangeLogEntryNotFound,
  ChangeLogFieldMismatch,
  getBotConfigView,
  listBotConfigHistory,
  rollbackBotConfigForAgent,
  saveBotConfigForAgent,
} from '../services/botConfigService.ts'

export const getBotConfigHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await getBotConfigView(req.agent!))
}

export const saveBotConfigHandler: RequestHandler = async (req, res) => {
  const body = SaveBotConfigBody.safeParse(req.body)
  if (!body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'At least one of is_provisioned, prompt, rules, tools_config or limits_config is required.',
    )
    return
  }

  try {
    res.status(200).json(
      await saveBotConfigForAgent(req.agent!, {
        isProvisioned: body.data.is_provisioned,
        prompt: body.data.prompt,
        rules: body.data.rules,
        toolsConfig: body.data.tools_config,
        limitsConfig: body.data.limits_config,
      }),
    )
  } catch (error) {
    if (
      error instanceof EmptyBotPrompt ||
      error instanceof InvalidRulesPayload ||
      error instanceof InvalidToolsPayload ||
      error instanceof InvalidLimitsPayload
    ) {
      sendError(res, 422, 'invalid_request', error.message)
      return
    }
    throw error
  }
}

const HISTORY_FIELDS = new Set(['prompt', 'rules', 'tools_config', 'limits_config', 'is_provisioned'])

export const getBotConfigHistoryHandler: RequestHandler = async (req, res) => {
  const query = ChangeLogHistoryQuery.safeParse(req.query)
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'limit must be an integer between 1 and 200.')
    return
  }

  const rawField = req.query.field
  if (rawField !== undefined && (typeof rawField !== 'string' || !HISTORY_FIELDS.has(rawField))) {
    sendError(res, 422, 'invalid_request', 'field must be one of prompt, rules, tools_config, limits_config, is_provisioned.')
    return
  }

  const cursor = query.data.cursor === undefined ? undefined : decodeChangeLogCursor(query.data.cursor)
  if (cursor === null) {
    sendError(res, 422, 'invalid_request', 'cursor is not a valid page cursor.')
    return
  }

  res.status(200).json(
    await listBotConfigHistory(req.agent!, {
      limit: query.data.limit,
      cursor,
      field: rawField as 'prompt' | 'rules' | 'tools_config' | 'limits_config' | 'is_provisioned' | undefined,
    }),
  )
}

export const rollbackBotConfigHandler: RequestHandler = async (req, res) => {
  const body = RollbackBotConfigBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'field, change_log_id and side are required.')
    return
  }

  try {
    res.status(200).json(
      await rollbackBotConfigForAgent(req.agent!, {
        field: body.data.field,
        changeLogId: body.data.change_log_id,
        side: body.data.side,
      }),
    )
  } catch (error) {
    if (error instanceof ChangeLogEntryNotFound) {
      sendError(res, 404, 'not_found', error.message)
      return
    }
    if (
      error instanceof ChangeLogFieldMismatch ||
      error instanceof InvalidRulesPayload ||
      error instanceof InvalidToolsPayload ||
      error instanceof InvalidLimitsPayload ||
      error instanceof EmptyBotPrompt
    ) {
      sendError(res, 422, 'invalid_request', error.message)
      return
    }
    throw error
  }
}
```

```ts
// backend/src/agent/routers/botConfigRouter.ts — add one line
import {
  getBotConfigHandler,
  getBotConfigHistoryHandler,
  rollbackBotConfigHandler,
  saveBotConfigHandler,
} from '../controllers/botConfigController.ts'

// ... existing router setup unchanged ...
botConfigRouter.post('/bot-config/rollback', requireAdminRole, rollbackBotConfigHandler)
```

Add `not_found` to `ErrorCode` in `backend/src/errors.ts` if it is not already there (it already is — confirmed in the codebase read).

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @support/api typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add backend/src/agent/controllers/botConfigController.ts backend/src/agent/routers/botConfigRouter.ts
git commit -m "feat(bot-config): rollback endpoint and field-filtered history"
```

---

### Task 12: Rewrite `agent.botConfig.test.ts` (HTTP-level tests)

**Files:**
- Modify: `backend/tests/agent.botConfig.test.ts`

This is the task where Tasks 10–11 actually get their pass/fail signal.

- [ ] **Step 1: Write the failing tests**

Replace the whole file's body (keep the file's setup boilerplate: `app`, `beforeAll`/`afterAll`, `seedAgentWithRole`) with tests updated for the new shapes, plus new rollback tests. Key replacements:

```ts
import { DEFAULT_BOT_PROMPT, buildSystemPrompt } from '../src/domain/bot/defaultPrompt.ts'
import { buildBaselineRules } from '../src/domain/bot/rulesCatalog.ts'
import { buildBaselineToolsConfig } from '../src/domain/bot/tools.ts'
import { seedBotConfig as seedBotConfigRaw, /* other existing helper imports unchanged */ } from './helpers/db.ts'

describe('GET /bot-config', () => {
  it('resolves an absent row to the off state on the catalog baseline', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    const res = await request(app).get('/bot-config').set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.is_provisioned).toBe(false)
    expect(res.body.prompt).toBe(DEFAULT_BOT_PROMPT)
    expect(res.body.rules).toHaveLength(8)
    expect(res.body.rules.find((r: { key: string }) => r.key === 'no_invented_facts').enforcement).toBe('code')
    expect(res.body.tools_config).toHaveLength(4)
    expect(res.body.enabled_tools.sort()).toEqual(['answer_from_article', 'classify', 'confirm_resolution', 'search_articles'])
    expect(res.body.system_prompt).toBe(buildSystemPrompt(DEFAULT_BOT_PROMPT, buildBaselineRules()))
    expect(res.body.is_prompt_customized).toBe(false)
    expect(res.body.is_rules_customized).toBe(false)
    expect(res.body.is_tools_customized).toBe(false)
    expect(res.body.updated_at).toBeNull()
  })

  it('refuses a plain agent with 403', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'agent')
    await request(app).get('/bot-config').set('Authorization', `Bearer ${token}`).expect(403)
  })
})

describe('POST /bot-config', () => {
  it('rejects a rules payload missing a locked builtin key', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')
    const withoutLocked = buildBaselineRules().filter((r) => r.key !== 'no_credentials')

    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ rules: withoutLocked })
      .expect(422)
    expect(res.body.error.message).toContain('no_credentials')
  })

  it('accepts an added custom rule and renders it in system_prompt', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')
    const rules = [...buildBaselineRules(), { key: 'custom-1', text: 'Never mention competitor games.', enabled: true, locked: false, source: 'custom' }]

    const res = await request(app).post('/bot-config').set('Authorization', `Bearer ${token}`).send({ rules }).expect(200)
    expect(res.body.system_prompt).toContain('Never mention competitor games.')
    expect(res.body.is_rules_customized).toBe(true)
  })

  it('disabling a tool removes it from enabled_tools and is reflected in is_tools_customized', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')
    const toolsConfig = buildBaselineToolsConfig().map((t) => (t.tool === 'classify' ? { ...t, enabled: false } : t))

    const res = await request(app).post('/bot-config').set('Authorization', `Bearer ${token}`).send({ tools_config: toolsConfig }).expect(200)
    expect(res.body.enabled_tools).not.toContain('classify')
    expect(res.body.is_tools_customized).toBe(true)
  })

  it('rejects tools_config missing a catalog tool', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')
    const missingOne = buildBaselineToolsConfig().slice(1)

    await request(app).post('/bot-config').set('Authorization', `Bearer ${token}`).send({ tools_config: missingOne }).expect(422)
  })

  it('writes one audit row per changed field, attributed to the caller', async () => {
    const workspaceId = await seedWorkspace()
    const { agentId, token } = await seedAgentWithRole(workspaceId, 'admin')

    await request(app).post('/bot-config').set('Authorization', `Bearer ${token}`).send({ is_provisioned: true, prompt: 'Custom prompt' }).expect(200)

    const { rows } = await ownerPool.query<{ field: string; actor_id: string }>(
      `select field, actor_id from change_log where entity_type = 'bot_config' and entity_id = $1 order by field`,
      [workspaceId],
    )
    expect(rows.map((row) => row.field)).toEqual(['is_provisioned', 'prompt'])
    expect(rows.every((row) => row.actor_id === agentId)).toBe(true)
  })

  // keep the existing "refuses a team lead", "refuses a plain agent", "writes only the caller workspace row" tests, updated only where they `.send({ prompt: ... })` with a still-valid payload — no shape change needed for those.
})

describe('POST /bot-config/rollback', () => {
  it('restores a prior prompt value and writes a new, forward audit row', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')
    await request(app).post('/bot-config').set('Authorization', `Bearer ${token}`).send({ prompt: 'First' }).expect(200)
    await request(app).post('/bot-config').set('Authorization', `Bearer ${token}`).send({ prompt: 'Second' }).expect(200)

    const history = await request(app).get('/bot-config/history?field=prompt').set('Authorization', `Bearer ${token}`).expect(200)
    const firstChangeId = history.body.entries.find((e: { after_value: unknown }) => e.after_value === 'First').id

    const res = await request(app)
      .post('/bot-config/rollback')
      .set('Authorization', `Bearer ${token}`)
      .send({ field: 'prompt', change_log_id: firstChangeId, side: 'after' })
      .expect(200)
    expect(res.body.prompt).toBe('First')

    const { rows } = await ownerPool.query<{ count: string }>(`select count(*)::text as count from change_log where entity_id = $1 and field = 'prompt'`, [workspaceId])
    expect(rows[0]!.count).toBe('3') // First, Second, and the rollback-to-First
  })

  it('404s on an unknown change_log_id', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')
    await request(app)
      .post('/bot-config/rollback')
      .set('Authorization', `Bearer ${token}`)
      .send({ field: 'prompt', change_log_id: '999999999', side: 'after' })
      .expect(404)
  })

  it('404s on a change_log_id belonging to another workspace', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const { token: tokenB } = await seedAgentWithRole(workspaceB, 'admin')
    await request(app).post('/bot-config').set('Authorization', `Bearer ${tokenB}`).send({ prompt: 'B prompt' }).expect(200)
    const historyB = await request(app).get('/bot-config/history').set('Authorization', `Bearer ${tokenB}`).expect(200)
    const idFromB = historyB.body.entries[0].id

    const { token: tokenA } = await seedAgentWithRole(workspaceA, 'admin')
    await request(app)
      .post('/bot-config/rollback')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ field: 'prompt', change_log_id: idFromB, side: 'after' })
      .expect(404)
  })

  it('422s when the change_log_id\'s stored field does not match the request field', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')
    await request(app).post('/bot-config').set('Authorization', `Bearer ${token}`).send({ prompt: 'X' }).expect(200)
    const history = await request(app).get('/bot-config/history?field=prompt').set('Authorization', `Bearer ${token}`).expect(200)
    const promptChangeId = history.body.entries[0].id

    await request(app)
      .post('/bot-config/rollback')
      .set('Authorization', `Bearer ${token}`)
      .send({ field: 'rules', change_log_id: promptChangeId, side: 'after' })
      .expect(422)
  })

  it('refuses a team lead with 403', async () => {
    const workspaceId = await seedWorkspace()
    const { token: adminToken } = await seedAgentWithRole(workspaceId, 'admin')
    await request(app).post('/bot-config').set('Authorization', `Bearer ${adminToken}`).send({ prompt: 'X' }).expect(200)
    const history = await request(app).get('/bot-config/history').set('Authorization', `Bearer ${adminToken}`).expect(200)
    const { token: leadToken } = await seedAgentWithRole(workspaceId, 'team_lead')

    await request(app)
      .post('/bot-config/rollback')
      .set('Authorization', `Bearer ${leadToken}`)
      .send({ field: 'prompt', change_log_id: history.body.entries[0].id, side: 'after' })
      .expect(403)
  })
})
```

Keep the rest of the existing `GET /bot-config/history` describe block as-is (it still applies — history paging didn't change shape) plus add one test for the new `field=` filter:

```ts
it('filters by field when ?field= is given', async () => {
  const workspaceId = await seedWorkspace()
  const { token } = await seedAgentWithRole(workspaceId, 'admin')
  await request(app).post('/bot-config').set('Authorization', `Bearer ${token}`).send({ is_provisioned: true, prompt: 'First' }).expect(200)

  const res = await request(app).get('/bot-config/history?field=prompt').set('Authorization', `Bearer ${token}`).expect(200)
  expect(res.body.entries.every((e: { field: string }) => e.field === 'prompt')).toBe(true)
})
```

Also add `limits_config`/`resolved_limits` coverage alongside the existing `rules`/`tools_config` tests:

```ts
it('GET resolves limits_config to the catalog defaults and rejects an out-of-bound save', async () => {
  const workspaceId = await seedWorkspace()
  const { token } = await seedAgentWithRole(workspaceId, 'admin')

  const get = await request(app).get('/bot-config').set('Authorization', `Bearer ${token}`).expect(200)
  expect(get.body.limits_config).toHaveLength(4)
  expect(get.body.resolved_limits).toEqual({
    max_bot_messages: 8,
    max_tool_calls_per_turn: 6,
    max_articles_per_turn: 3,
    max_unhelped_replies: 3,
  })
  expect(get.body.is_limits_customized).toBe(false)

  const badSave = await request(app)
    .post('/bot-config')
    .set('Authorization', `Bearer ${token}`)
    .send({ limits_config: [{ key: 'max_bot_messages', value: 999 }] })
    .expect(422)
  expect(badSave.body.error).toMatch(/max_bot_messages/)
})

it('rolls back limits_config the same way as tools_config', async () => {
  const workspaceId = await seedWorkspace()
  const { token } = await seedAgentWithRole(workspaceId, 'admin')
  const original = await request(app).get('/bot-config').set('Authorization', `Bearer ${token}`).expect(200)

  await request(app)
    .post('/bot-config')
    .set('Authorization', `Bearer ${token}`)
    .send({ limits_config: original.body.limits_config.map((l: { key: string; value: number }) => (l.key === 'max_unhelped_replies' ? { ...l, value: 5 } : l)) })
    .expect(200)

  const history = await request(app).get('/bot-config/history?field=limits_config').set('Authorization', `Bearer ${token}`).expect(200)
  const changeLogId = history.body.entries[0].id

  const restored = await request(app)
    .post('/bot-config/rollback')
    .set('Authorization', `Bearer ${token}`)
    .send({ field: 'limits_config', change_log_id: changeLogId, side: 'before' })
    .expect(200)
  expect(restored.body.resolved_limits.max_unhelped_replies).toBe(3)
})
```

- [ ] **Step 2: Run test to verify it fails, then passes after Tasks 10–11's code**

Run: `pnpm --filter @support/api test agent.botConfig -- --run`
Expected: FAIL first (if Tasks 10–11 haven't landed yet in your branch) or PASS immediately (if you're doing this after them, as this plan's ordering assumes). Either way, end state must be PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/agent.botConfig.test.ts
git commit -m "test(bot-config): HTTP tests for rules/tools payloads and rollback endpoint"
```

---

### Task 13: `seed.ts` and `openapi.ts` wiring

**Files:**
- Modify: `backend/src/shared/db/seed.ts`
- Modify: `backend/src/docs/openapi.ts`

- [ ] **Step 1: Wire `seedBotConfig` into the dev seed**

In `backend/src/shared/db/seed.ts`, after the workspace insert (around the `insert into workspace` call found at line 47), add a call that provisions the bot config baseline for that seeded workspace, using the same connection/transaction pattern the rest of `seed.ts` already uses (read the file's existing structure — it likely uses `ownerPool` or a `drizzle` instance directly, not `withWorkspace`, since seeding predates any authenticated request). Wrap the call in the appropriate transaction helper already used by that file, and call:

```ts
import { seedBotConfig } from '../../domain/bot/botConfig.ts'
// ... after the workspace row is inserted and its id is known ...
await withWorkspace(workspaceId, (tx) => seedBotConfig(tx, workspaceId))
```

(`withWorkspace` sets the RLS session variable required for the insert; import it the same way other domain-layer scripts do, e.g. `backend/src/shared/db/migrations/backfillBotConfig.ts` from Task 3 does not use `withWorkspace` because it runs as `MIGRATION_DATABASE_URL`'s owner role outside RLS — `seed.ts` should match whatever pattern it already uses elsewhere in the same file for RLS-scoped inserts; if it currently writes directly via the owner pool for every table, insert `bot_config` the same way instead of introducing `withWorkspace` — mirror the file's existing convention rather than this snippet literally.)

- [ ] **Step 2: Run the dev seed against a fresh local database**

Run: `pnpm --filter @support/api db:seed`
Expected: completes with no errors; `bot_config` has one row for the demo workspace.

- [ ] **Step 3: Update `backend/src/docs/openapi.ts`**

Replace the three `registry.registerPath` blocks for `/agent/bot-config` (GET), `/agent/bot-config` (POST) and `/agent/bot-config/history` (GET) — currently lines 1064–1122 — with:

```ts
registry.registerPath({
  method: 'get',
  path: '/agent/bot-config',
  summary: 'Agent Get Bot Config',
  description:
    'The resolved bot config for this workspace: is_provisioned, prompt, the toggleable rules catalog (with derived enforcement), tools_config, enabled_tools, limits_config, resolved_limits, the joined system_prompt, and which fields are customised relative to the catalog baseline. An absent row resolves to the off state on the catalog baseline. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: {
    200: { description: 'Resolved bot config' },
    403: { description: 'Forbidden — Team Lead or Admin role required' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/agent/bot-config',
  summary: 'Agent Save Bot Config',
  description:
    'Partial upsert of this workspace bot config, audited field-by-field into change_log in the same transaction. An omitted key is left alone; an explicit null on prompt, rules, tools_config or limits_config resets it to the catalog baseline. Locked rules cannot be disabled or removed, every builtin rule key must be present, at least one rule must stay enabled, tools_config must name every catalog tool, and limits_config must name every catalog limit with a value inside its min/max bound. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            is_provisioned: z.boolean().optional().openapi({ example: true }),
            prompt: z.string().nullable().optional().openapi({ example: 'You are the first-line support assistant…' }),
            rules: z
              .array(
                z.object({
                  key: z.string(),
                  text: z.string(),
                  enabled: z.boolean(),
                  locked: z.boolean(),
                  source: z.enum(['builtin', 'custom']),
                }),
              )
              .nullable()
              .optional(),
            tools_config: z
              .array(z.object({ tool: z.string(), enabled: z.boolean() }))
              .nullable()
              .optional(),
            limits_config: z
              .array(z.object({ key: z.string(), value: z.number().int().positive() }))
              .nullable()
              .optional()
              .openapi({
                example: [
                  { key: 'max_bot_messages', value: 8 },
                  { key: 'max_tool_calls_per_turn', value: 6 },
                  { key: 'max_articles_per_turn', value: 3 },
                  { key: 'max_unhelped_replies', value: 3 },
                ],
              }),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Resolved bot config after the save' },
    403: { description: 'Forbidden — admin role required' },
    422: { description: 'Nothing to change, an unknown field, an empty prompt, or an invalid rules/tools_config/limits_config payload' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/agent/bot-config/history',
  summary: 'Agent Get Bot Config Audit Trail',
  description:
    'This workspace bot-config change_log rows, newest first, cursor-paged, optionally filtered to one field. `field` on the query string narrows the page; `field` on each entry is the database column name. `before_value` null means the field had no value before; `after_value` null means it was reset to the catalog baseline. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional().openapi({ example: 50 }),
      cursor: z.string().optional().openapi({ description: 'Opaque next_cursor from the previous page' }),
      field: z.enum(['prompt', 'rules', 'tools_config', 'limits_config', 'is_provisioned']).optional(),
    }),
  },
  responses: {
    200: { description: 'Audit trail page' },
    403: { description: 'Forbidden — Team Lead or Admin role required' },
    422: { description: 'Invalid limit, cursor or field' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/agent/bot-config/rollback',
  summary: 'Agent Rollback Bot Config Field',
  description:
    'Restores a prior change_log value for one field as the new current value. This is itself a new, audited save — history is never mutated. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            field: z.enum(['prompt', 'rules', 'tools_config', 'limits_config']),
            change_log_id: z.string(),
            side: z.enum(['before', 'after']),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Resolved bot config after the rollback' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'No matching change_log entry for this workspace' },
    422: { description: 'change_log_id does not belong to the requested field, or the restored value fails validation' },
  },
})
```

- [ ] **Step 4: Confirm the OpenAPI doc builds**

Run: `pnpm --filter @support/api typecheck` (the openapi module is plain TS, so a build/typecheck catches a malformed schema) and then start the dev server and load `http://localhost:4000/docs/json`, confirming it returns valid JSON including the four `/agent/bot-config*` paths.

- [ ] **Step 5: Commit**

```bash
git add backend/src/shared/db/seed.ts backend/src/docs/openapi.ts
git commit -m "feat(bot-config): seed dev workspace baseline, update OpenAPI docs"
```


---

**End of Part 1.** Continue with `2026-08-19-bot-config-tab-frontend-implementation-plan.md` (Part 2) for the admin console UI and final spec-scope validation.
