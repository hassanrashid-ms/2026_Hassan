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
- The built-in prompt and rule catalog are **seeded as real rows** — a concrete "version 1"
  baseline every workspace actually has in the database — rather than a virtual default computed
  from `NULL`. Every workspace starts identical and every edit is a diff against a real prior row.
- Rules that carry a code/tool-level guard (the built-in catalog) are seeded in code and can never
  be deleted, only toggled (or, for the 2 hard-locked ones, not even that). Admins can freely add
  and remove their own custom rules, but a custom rule can never claim a code guard — there is no
  way to know what a free-text rule is supposed to enforce, so only the catalog rules discussed in
  this spec ever get `enforcement: 'code'`.

## Data model

`backend/src/shared/db/schema/bot.ts`:

```ts
export const botConfig = pgTable('bot_config', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  isProvisioned: boolean('is_provisioned').notNull().default(false),
  prompt: text('prompt').notNull(), // CHANGED: was nullable, now always a real value
  rules: jsonb('rules').notNull(), // CHANGED: was nullable text, now RuleEntry[], always populated
  toolsConfig: jsonb('tools_config').notNull(), // NEW: ToolToggle[], always populated
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
});
```

This is a deliberate change from the current nullable/"resolve to default" model: `prompt`,
`rules`, and `toolsConfig` are now `NOT NULL` everywhere. There is no more virtual default —
every workspace has a real, concrete baseline row from the moment it's provisioned. "Reset to
default" becomes "overwrite with the catalog baseline," a normal save like any other, not a
special NULL-out case.

```ts
type RuleEntry = {
  key: string; // stable id; builtin keys match DEFAULT_BOT_RULES catalog entries
  text: string; // rendered into the prompt's rules block, verbatim
  enabled: boolean;
  locked: boolean; // true only for the 2 built-in hard-constraint rules
  source: 'builtin' | 'custom';
  enforcement: 'code' | 'prompt'; // display-only; see "Enforcement honesty" below
};

type ToolToggle = {
  tool: string; // one of TOOL_DEFS names, excluding 'handoff'
  enabled: boolean;
};
```

Every `RuleEntry` with `source: 'builtin'` must always be present in the stored array — the save
path rejects a payload missing a catalog key, the same way it rejects a locked key being disabled.
Only `source: 'custom'` entries can be added or removed freely. "Customised" is no longer a
null-check; it's computed by diffing the stored value against the current catalog baseline (see
Seeding, below).

## Built-in rule catalog

**Behavior parity is the hard constraint here.** `docs/specs/...` mockup text and the product doc's
Rules screen show _illustrative_ rule wording (6 short rules, one off by default) — that is not
what `DEFAULT_BOT_RULES` actually says today. The earlier draft of this spec mistakenly used the
doc's illustrative wording as the catalog. That is now corrected: the catalog is a **verbatim
split of the real `DEFAULT_BOT_RULES` string**, in its current order, all enabled by default,
because that string is what every workspace's bot has been running on. The doc's screen only
supplies the _shape_ (toggleable list, some locked, custom rules addable) — never the wording or
the defaults, which come from the actual shipped constant:

| key                               | text (verbatim from `DEFAULT_BOT_RULES`)                                                                                                                                                                                                                                                                                         | default enabled | locked  | enforcement                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `no_invented_facts`               | Never invent a fact about the game, an account, a purchase, a refund, or a balance. If the articles do not say it, you do not know it.                                                                                                                                                                                           | on              | no      | `code` — backed by `scoreGrounding`/`isGrounded` (≥90% grounded), independent of this sentence being present |
| `handoff_immediate`               | If the player asks for a human, mentions a legal or safety issue, or is upset with you rather than with the game, hand off immediately, without searching first.                                                                                                                                                                 | on              | **yes** | `prompt`                                                                                                     |
| `search_before_financial_handoff` | If the player reports a financial loss or a setback they did not cause, search before you hand off. A published article on the exact problem is faster than a queue, and answering from it costs the player nothing — they can still say it did not help, which hands them off. Never resolve or dismiss the complaint yourself. | on              | no      | `prompt`                                                                                                     |
| `handoff_after_empty_search`      | If a search comes back with nothing that answers the question, hand off. A fast handoff is a good outcome, not a failure — but "fast" means after one search, not instead of one.                                                                                                                                                | on              | no      | `prompt`                                                                                                     |
| `no_promises`                     | Never promise a compensation, a refund, a timeline, or an outcome. A human decides those.                                                                                                                                                                                                                                        | on              | no      | `prompt`                                                                                                     |
| `no_credentials`                  | Never ask the player for a password, a payment detail, or a one-time code.                                                                                                                                                                                                                                                       | on              | **yes** | `prompt`                                                                                                     |
| `language_and_length`             | Reply in the player's language. Keep an ordinary reply to at most three short sentences — this is a chat window on a phone, not an email. An answer drawn from an article may run longer when its steps need the room: never drop or merge a step to fit, and never pad past what the article says.                              | on              | no      | `prompt`                                                                                                     |
| `no_regreet`                      | Do not greet the player again if the conversation is already underway.                                                                                                                                                                                                                                                           | on              | no      | `prompt`                                                                                                     |

All 8 default to `enabled: true` — today there is no on/off distinction, every bullet always
ships. `handoff_immediate` and `no_credentials` are the 2 locked rules (closest existing match to
the doc's "reach a person" / "never ask for credentials" hard constraints). There is currently no
rule or code path resembling the doc's "hand off after three replies" toggle — `MAX_BOT_MESSAGES`
in `toolLoop.ts` is an unrelated technical turn cap, not tied to any rule sentence, and this spec
does not add one (that would be new behavior, not parity).

`enforcement` is informational only, shown as a badge in the UI ("always enforced in code — this
toggle only controls the wording sent to the model" vs "enforced by prompt instruction only").
Toggling `no_invented_facts` off does **not** weaken `scoreGrounding`'s 90% threshold; it only
removes that sentence from the rendered rules block. This is stated explicitly in the UI so admins
aren't misled into thinking they've disabled a safety check.

Locked rules (`handoff_immediate`, `no_credentials`) cannot be disabled or removed — the save
endpoint rejects a payload where a locked key has `enabled: false` or is missing, and rejects any
rule set with zero enabled entries (mirrors today's "empty rules" rejection).

Custom rules (`source: 'custom'`) are free text, admin-authored, `enforcement: 'prompt'` always,
never locked, deletable.

`buildSystemPrompt(prompt, rules)` renders enabled entries **in catalog declaration order** (the
order in the table above — not reordered by locked/unlocked), each as `- {text}`, one per line,
with any enabled custom entries appended after the catalog ones in the order they were added. On
an unmodified, freshly-seeded workspace this produces the exact same 8 lines, in the exact same
order, that `DEFAULT_BOT_RULES` produces today — byte-for-byte. Reordering locked rules to the
front (as an earlier draft proposed) is explicitly rejected: it would change the rendered prompt
for every workspace on day one, which is exactly the behavior change this task must avoid.

## Tool gating (deterministic)

`domain/bot/tools.ts`:

```ts
export const TOOL_CATALOG = [
  // Declared in the same order as ALWAYS_AVAILABLE_TOOLS today: search_articles,
  // classify, answer_from_article, handoff (locked, listed for completeness but
  // never filtered), then confirm_resolution when the phase includes it.
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
    name: 'answer_from_article',
    lockable: true,
    defaultEnabled: true,
    consequence:
      'Bot can search/classify but never answers itself — always hands off after searching.',
  },
  // handoff is intentionally absent from the toggleable list: always available, never configurable.
  {
    name: 'confirm_resolution',
    lockable: true,
    defaultEnabled: true,
    consequence:
      'Article answers are never confirmed by the player; bot_active exits only via handoff or the turn cap.',
  },
] as const;

export function toolsForPhase(phase: ToolPhase, enabledTools: ReadonlySet<string>): unknown[] {
  const base = [
    ...ALWAYS_AVAILABLE_TOOLS,
    ...(phase === 'bot_article' ? [CONFIRM_RESOLUTION_TOOL] : []),
  ];
  // Filter in place — DO NOT reorder. handoff's name is never checked against
  // enabledTools, so it always passes the filter and stays exactly where
  // ALWAYS_AVAILABLE_TOOLS already puts it (today: 4th). Every other tool is
  // dropped only if its name isn't in enabledTools.
  return base.filter((t) => t.function.name === 'handoff' || enabledTools.has(t.function.name));
}
```

`resolveBotConfig` gains `enabledTools: Set<string>`, read directly off the now-always-populated
`toolsConfig`. On a freshly-seeded, never-touched workspace `enabledTools` contains all 4
toggleable names, so `toolsForPhase` returns the identical array, in the identical order, that
`toolsForPhase(phase)` returns today — the filter is a no-op until an admin actually disables
something. `toolLoop.ts` passes this into `toolsForPhase` instead of calling it with just `phase`.
A disabled tool is absent from the array passed to `openaiClient` — the model has no schema for it
and cannot emit a call to it. No prompt wording is used to suppress a tool; there is nothing to
"beg" the model to avoid.

## Seeding / baseline (version 1)

Every workspace gets a real `bot_config` row the moment it's provisioned, not a lazily-resolved
default:

- **New workspaces**: workspace-creation flow calls `seedBotConfig(workspaceId)`, inserting
  `prompt: DEFAULT_BOT_PROMPT`, `rules: DEFAULT_BOT_RULES_CATALOG`, `tools_config:` all tools
  enabled. This insert also writes one `change_log` entry per field, `actor: 'system'`,
  `before_value: null`, `after_value: <baseline>` — this is what "version 1" means concretely:
  the first entry in each field's history is always the seed, visible in the History panel like
  any other change, just attributed to the system instead of an admin.
- **Existing workspaces**: a one-time backfill migration runs the same `seedBotConfig` for every
  `bot_config` row that predates this change (today's `NULL` `prompt`/`rules` rows), so no
  workspace is left on the old virtual-default path. A workspace that had already customised its
  `prompt` (non-null today) is seeded only for the still-`NULL` `tools_config` column — the
  existing custom prompt is left untouched and gets no synthetic "version 1" entry, since it
  already has real history. A workspace with a non-null legacy free-text `rules` value is migrated
  by seeding the full builtin catalog at its defaults _plus_ one extra `source: 'custom'` entry
  wrapping the old free-text value verbatim, so no admin's existing customisation is silently
  dropped — the old text simply becomes one custom rule alongside the new toggleable catalog.
- `DEFAULT_BOT_RULES_CATALOG` and `DEFAULT_BOT_PROMPT` remain the single source of truth in code
  (`domain/bot/defaultPrompt.ts`) for what "baseline" means; the seed just materialises them into
  a row. "Reset to default" (Prompt tab) and "Restore catalog defaults" (Rules tab) both just call
  `saveBotConfig` with these same constants — ordinary saves, not a special code path.

### Behavior parity guarantee

This migration must produce **zero change** in what the bot says or which tools it can call, for
every workspace that hasn't touched its config. Concretely, for a freshly seeded/backfilled row:

- `buildSystemPrompt(resolved.prompt, resolved.rules)` (new signature, taking `RuleEntry[]`) must
  return a string **identical, character for character**, to today's
  `buildSystemPrompt(DEFAULT_BOT_PROMPT, DEFAULT_BOT_RULES)` (old signature, taking the raw
  string). This is the reason the catalog above is a verbatim split of the real constant in its
  real order, not the doc's illustrative rewrite.
- `toolsForPhase(phase, enabledTools)` with `enabledTools` = all 4 toggleable names must return an
  array `deepEqual` (including order) to today's `toolsForPhase(phase)`.
- `resolveBotConfig` for a freshly seeded row must report `is_provisioned`, `system_prompt`, and
  `enabled_tools` such that a bot turn run against it makes the exact same tool calls, in the
  exact same circumstances, as the same turn run against today's code. This is the thing to
  actually verify, not just the string/array equality above — see Testing.

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
const RuleEntrySchema = z
  .object({
    key: z.string(),
    text: z.string().min(1),
    enabled: z.boolean(),
    locked: z.boolean(),
    source: z.enum(['builtin', 'custom']),
  })
  .strict();

const ToolToggleSchema = z
  .object({
    tool: z.enum(TOGGLEABLE_TOOL_NAMES), // excludes 'handoff'
    enabled: z.boolean(),
  })
  .strict();
```

`enforcement` is never client-settable — it's not part of `RuleEntrySchema`. The server derives
it by looking up `key` in `DEFAULT_BOT_RULES_CATALOG` (`code`/`prompt` per that table) for builtin
rules, and hardcodes `prompt` for any `source: 'custom'` entry, before returning `BotConfigView`.
This keeps an admin from mislabeling a rule as code-enforced when it isn't.

```ts
export const SaveBotConfigBody = z
  .object({
    is_provisioned: z.boolean().optional(),
    prompt: z.string().nullable().optional(),
    rules: z.array(RuleEntrySchema).nullable().optional(),
    tools_config: z.array(ToolToggleSchema).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.values(body).some((v) => v !== undefined));
```

Save-time domain validation (`saveBotConfig`, not just Zod shape):

- Reject if any locked builtin key (`handoff_on_request`, `no_credentials`) is missing or has
  `enabled: false`.
- Reject if any `source: 'builtin'` key from `DEFAULT_BOT_RULES_CATALOG` is missing from the
  payload entirely — builtins can be toggled but never deleted, whether or not they're locked.
- Reject if the resulting rule list has zero enabled entries.
- Reject a payload where an entry with `source: 'custom'` claims `enforcement: 'code'` or reuses
  a builtin `key` — custom rules are always `prompt`-enforced and get their own generated key.
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

- **Parity test (write this first, before any refactor lands):** a snapshot test that captures
  `buildSystemPrompt(DEFAULT_BOT_PROMPT, DEFAULT_BOT_RULES)`'s current output _before_ touching any
  code, then asserts the new `buildSystemPrompt(seeded.prompt, seeded.rules)` produces the
  identical string post-migration. Same for `toolsForPhase('bot_article')` and
  `toolsForPhase('agent_ask')` (or whatever the non-confirm phase value is) — capture today's
  array, assert deep+order equality against the seeded-workspace result. This test is the actual
  enforcement mechanism for "no behavior change," not just a description in this doc.
- `backend/tests/bot.config.test.ts`: update for `DEFAULT_BOT_RULES_CATALOG` shape; add cases for
  locked-rule rejection, builtin-key-deletion rejection, empty-rules rejection, `enforcement`
  tagging, and `toolsForPhase` filtering (each tool individually disabled removes it from the
  returned array without reordering the rest; `handoff` never removable).
- `backend/tests/agent.botConfig.test.ts`: update save/read tests for the new `rules`/
  `tools_config` shapes; add rollback endpoint tests (restore before/after value creates a new
  audit row, admin-only, 404 on unknown `change_log_id`, 422 on cross-workspace id); add a seeding
  test asserting a brand-new workspace's `GET /bot-config` response is identical to today's
  never-provisioned-workspace response (same `system_prompt`, same tool availability implied).
- New: a `toolLoop` test asserting a disabled tool's name never appears in the payload passed to
  `openaiClient`, independent of prompt/rules content — the determinism guarantee this whole
  feature exists for.

## Out of scope

- Forms and Knowledge tabs (separate specs / already-built admin surfaces).
- Any code-level content scanning (e.g. regex-detecting card numbers in the bot's own draft
  reply) to backstop the two locked rules — they remain prompt-enforced only, matching the doc.
- Detailed migration script content for converting a workspace's existing free-text `rules`
  value into `RuleEntry[]` (wrap as one `source: 'custom'` entry alongside the seeded catalog) —
  the shape of this is described under Seeding, above; exact migration code is for the
  implementation plan.
