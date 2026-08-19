# Bot Config Tab — Prompt, Rules, Tools

## Context

`docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md` and the product spec
(`Docs/Customer Support Tool - CRM v2.txt`, "Bot settings") define four admin tabs: Prompt,
Rules, Forms, Knowledge. Forms and Knowledge are out of scope here (Forms already has its own
admin surface; Knowledge/sync is separate work). This spec covers **Prompt + Rules + a new Tools
tab**, replacing the current free-text `rules` column with a structured, toggleable rule list,
and adding deterministic per-workspace tool enable/disable.

The existing `bot_config` table (`backend/src/shared/db/schema/bot.ts`) already has `prompt` and
`rules` as nullable `text`, an `is_provisioned` flag, and a `change_log`-backed audit trail
(`backend/src/agent/services/botConfigService.ts`). This spec changes the shape of `rules`, adds
`tools_config`, and reuses `change_log` for version history — no new versioning table.

## Goals

- Rules tab matches the doc: a list of individually toggleable rules, two locked always-on, plus
  free-text custom rules, all required-non-empty before provisioning.
- Tool enable/disable is **deterministic**: a disabled tool is never included in the tool-calling
  array sent to the model. Nothing relies on the model choosing to comply with a prompt sentence.
- Prompt and rules keep "history + rollback," implemented by restoring a prior `change_log` value
  rather than a new snapshot table — consistent with this codebase's append-only/event style.
- No behavior change for any workspace that has never touched bot config: `rules IS NULL` and
  `tools_config IS NULL` must resolve to exactly today's behavior.

## Data model

`backend/src/shared/db/schema/bot.ts`:

```ts
export const botConfig = pgTable('bot_config', {
  workspaceId: uuid('workspace_id').primaryKey().references(() => workspace.id, { onDelete: 'restrict' }),
  isProvisioned: boolean('is_provisioned').notNull().default(false),
  prompt: text('prompt'),               // unchanged: NULL -> DEFAULT_BOT_PROMPT
  rules: jsonb('rules'),                // CHANGED: was text, now RuleEntry[] | null
  toolsConfig: jsonb('tools_config'),   // NEW: ToolToggle[] | null
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
})
```

```ts
type RuleEntry = {
  key: string          // stable id; builtin keys match DEFAULT_BOT_RULES catalog entries
  text: string          // rendered into the prompt's rules block, verbatim
  enabled: boolean
  locked: boolean        // true only for the 2 built-in hard-constraint rules
  source: 'builtin' | 'custom'
  enforcement: 'code' | 'prompt'  // display-only; see "Enforcement honesty" below
}

type ToolToggle = {
  tool: string          // one of TOOL_DEFS names, excluding 'handoff'
  enabled: boolean
}
```

`rules IS NULL` and `toolsConfig IS NULL` both mean "never customised" and resolve to the
built-in defaults, same as `prompt IS NULL` does today.

## Built-in rule catalog

`domain/bot/defaultPrompt.ts`'s `DEFAULT_BOT_RULES` (currently one 8-line string) becomes a typed
array, `DEFAULT_BOT_RULES_CATALOG: RuleEntry[]`, sourced from the doc's Rules screen:

| key | text | default enabled | locked | enforcement |
|---|---|---|---|---|
| `articles_only` | Answer only from published help articles | on | no | `code` — already guaranteed by `scoreGrounding`/`isGrounded` (≥90% grounded) regardless of prompt wording |
| `no_promises` | Never promise a refund, a credit, or a timeline | on | no | `prompt` |
| `handoff_on_request` | Hand off immediately if the player asks for a person | on | **yes** | `prompt` |
| `no_credentials` | Never ask for a password, card number, or personal ID | on | **yes** | `prompt` |
| `handoff_after_three` | Hand off if the player has not been helped after three replies | on | no | `code` — already guaranteed by `MAX_BOT_MESSAGES` turn-cap in `toolLoop.ts` |
| `reply_in_language` | Reply in the language the player wrote in | off | no | `prompt` |

`enforcement` is informational only, shown as a badge in the UI ("always enforced in code — this
toggle only controls the wording sent to the model" vs "enforced by prompt instruction only").
Toggling `articles_only` or `handoff_after_three` off does **not** weaken the underlying code
guard; it only removes that sentence from the rendered rules block. This is stated explicitly in
the UI so admins aren't misled into thinking they've disabled a safety check.

Locked rules (`handoff_on_request`, `no_credentials`) cannot be disabled or removed — the save
endpoint rejects a payload where a locked key has `enabled: false` or is missing, and rejects any
rule set with zero enabled entries (mirrors today's "empty rules" rejection).

Custom rules (`source: 'custom'`) are free text, admin-authored, `enforcement: 'prompt'` always,
never locked, deletable.

`buildSystemPrompt(prompt, rules)` renders enabled entries (locked + custom + toggled-on) as a
bullet list in a fixed order (locked first, then builtin, then custom) and joins it after the
prompt exactly as today — the resulting `system_prompt` string shape is unchanged, so nothing
downstream (grounding, tests expecting rules-after-prompt ordering) is affected beyond the source
of the bullet text.

## Tool gating (deterministic)

`domain/bot/tools.ts`:

```ts
export const TOOL_CATALOG = [
  { name: 'search_articles', lockable: true, consequence: 'Bot can never look anything up; every turn ends in classify-only or handoff.' },
  { name: 'classify', lockable: true, consequence: 'Conversations stay unclassified from the bot; agents classify manually.' },
  { name: 'answer_from_article', lockable: true, consequence: 'Bot can search/classify but never answers itself — always hands off after searching.' },
  { name: 'confirm_resolution', lockable: true, consequence: 'Article answers are never confirmed by the player; bot_active exits only via handoff or the turn cap.' },
  // handoff is intentionally absent: always available, never configurable.
] as const

export function toolsForPhase(phase: ToolPhase, enabledTools: ReadonlySet<string>): unknown[] {
  const base = [...ALWAYS_AVAILABLE_TOOLS, ...(phase === 'bot_article' ? [CONFIRM_RESOLUTION_TOOL] : [])]
  return [
    HANDOFF_TOOL, // always included, unconditionally
    ...base.filter((t) => t.name === HANDOFF_TOOL.name || enabledTools.has(t.name)),
  ]
}
```

`resolveBotConfig` gains `enabledTools: Set<string>`, computed from `toolsConfig` (all-enabled if
`NULL`). `toolLoop.ts` passes this into `toolsForPhase` instead of calling it with just `phase`.
A disabled tool is absent from the array passed to `openaiClient` — the model has no schema for
it and cannot emit a call to it. No prompt wording is used to suppress a tool; there is nothing
to "beg" the model to avoid.

## Versioning / history / rollback

No new table. `change_log` already stores `(field, before_value, after_value, actor, changed_at)`
per save, append-only. This spec adds:

- `field` values `'rules'` and `'tools_config'` alongside the existing `'prompt'` /
  `'is_provisioned'` — `before_value`/`after_value` are now the JSON array, not a string, for
  `rules`.
- `GET /bot-config/history?field=` (extends the existing `GET /bot-config/history`) filtered per
  field for the tab-scoped History panel.
- `POST /bot-config/rollback` (admin only), body `{ field: 'prompt' | 'rules' | 'tools_config', change_log_id: string, side: 'before' | 'after' }`
  — looks up that `change_log` row, calls `saveBotConfig` with the chosen side's value as the new
  current value. This produces a **new** `change_log` entry (restore is itself an audited change,
  never a mutation of history), consistent with "nothing is ever deleted" elsewhere in this
  codebase.

## API / types

`packages/types/src/bot.ts`:

```ts
const RuleEntrySchema = z.object({
  key: z.string(),
  text: z.string().min(1),
  enabled: z.boolean(),
  locked: z.boolean(),
  source: z.enum(['builtin', 'custom']),
}).strict()

const ToolToggleSchema = z.object({
  tool: z.enum(TOGGLEABLE_TOOL_NAMES), // excludes 'handoff'
  enabled: z.boolean(),
}).strict()
```

`enforcement` is never client-settable — it's not part of `RuleEntrySchema`. The server derives
it by looking up `key` in `DEFAULT_BOT_RULES_CATALOG` (`code`/`prompt` per that table) for builtin
rules, and hardcodes `prompt` for any `source: 'custom'` entry, before returning `BotConfigView`.
This keeps an admin from mislabeling a rule as code-enforced when it isn't.

```ts
export const SaveBotConfigBody = z.object({
  is_provisioned: z.boolean().optional(),
  prompt: z.string().nullable().optional(),
  rules: z.array(RuleEntrySchema).nullable().optional(),
  tools_config: z.array(ToolToggleSchema).nullable().optional(),
}).strict()
  .refine(body => Object.values(body).some(v => v !== undefined))
```

Save-time domain validation (`saveBotConfig`, not just Zod shape):
- Reject if any locked builtin key (`handoff_on_request`, `no_credentials`) is missing or has
  `enabled: false`.
- Reject if the resulting rule list has zero enabled entries.
- Reject unknown builtin `key` values not in `DEFAULT_BOT_RULES_CATALOG` and not `source: 'custom'`.
- Reject unknown `tool` names not in `TOOL_CATALOG`.
- No validation blocks disabling `search_articles` while `answer_from_article` stays enabled —
  the UI warns about the dead-tool consequence, but the save is a policy choice, not an error.

`BotConfigView` gains `enabled_tools: string[]` (resolved, for the read view) and `rules` becomes
the resolved `RuleEntry[]` instead of a string; `is_rules_customized` stays as-is (row is non-null).

## Frontend

New `frontend/src/surfaces/agent-console/pages/BotConfig/` with three tabs under one shell
(Prompt / Rules / Tools), each with its own Save button per the doc's per-tab save pattern:

- **Prompt**: textarea, placeholder reference (read-only list), "Reset to default" (shown only
  when customised), "Test with a message" (dry-run endpoint, reuses `toolLoopDecider` against
  draft content), History panel with Restore.
- **Rules**: toggle rows — locked rows render a lock icon and a disabled switch fixed to on;
  each row shows its `enforcement` badge (`code` / `prompt`); "Add a rule" free-text input at the
  bottom for custom entries; count summary ("N active · 2 cannot be switched off") matching the
  doc; History panel with Restore.
- **Tools**: toggle rows per `TOOL_CATALOG` entry with the consequence copy shown inline when a
  toggle is off; `handoff` rendered as a static "always on" row, no switch; History panel with
  Restore.

No existing frontend code to preserve here — no Bot Config UI exists today (confirmed: no
`bot-config` route, no `botConfig` imports under `frontend/`).

## Testing

- `backend/tests/bot.config.test.ts`: update for `DEFAULT_BOT_RULES_CATALOG` shape; add cases for
  locked-rule rejection, empty-rules rejection, `enforcement` tagging, and `toolsForPhase`
  filtering (each tool individually disabled removes it from the returned array; `handoff` never
  removable).
- `backend/tests/agent.botConfig.test.ts`: update save/read tests for the new `rules`/
  `tools_config` shapes; add rollback endpoint tests (restore before/after value creates a new
  audit row, admin-only, 404 on unknown `change_log_id`, 422 on cross-workspace id).
- New: a `toolLoop` test asserting a disabled tool's name never appears in the payload passed to
  `openaiClient`, independent of prompt/rules content — the determinism guarantee this whole
  feature exists for.

## Out of scope

- Forms and Knowledge tabs (separate specs / already-built admin surfaces).
- Any code-level content scanning (e.g. regex-detecting card numbers in the bot's own draft
  reply) to backstop the two locked rules — they remain prompt-enforced only, matching the doc.
- Migrating existing workspaces' free-text `rules` values — this is a schema type change on a
  nullable column; any workspace with a non-null legacy string value needs a one-time migration
  step (wrap the existing string as a single `source: 'custom', enforcement: 'prompt', locked: false`
  entry) called out for the implementation plan, not designed in depth here.
