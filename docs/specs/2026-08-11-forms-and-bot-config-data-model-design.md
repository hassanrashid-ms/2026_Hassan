# Forms and bot-config data model — design

**Date:** 2026-08-11
**Status:** Accepted
**Scope:** Data model only. Six new tables, two new enums, one FK added to `subintent`, one
additive unique key on `conversation`, two grant revokes.

---

## What this slice is

The storage shape the bot orchestrator reads and writes when it offers a form and when it decides
whether to run at all. Nothing else.

Forms are **structured, Google-Form-style UIs opened in a modal** — not questions asked
turn-by-turn in the thread. That supersession is recorded in `docs/project-overview.md`
(2026-08-10) and is the premise for everything below; the conversational design in
`docs/specs/2026-08-04-database-and-schema-design.md` §Forms is history.

### In scope

| Thing | Why here |
|---|---|
| `form`, `form_version` | The questions, versioned, so old answers stay readable |
| `form_submission` | One offer of one form on one conversation, and its outcome |
| `form_answer` | Append-only answers |
| `bot_config` | What the orchestrator gates on (`is_provisioned`), plus the `prompt` and `rules` it joins into the system prompt |
| `change_log` | Full audit: who changed which field, when, from what to what |
| `subintent.form_id` → real FK | The column already exists as a bare uuid; the parent table now exists |
| `conversation` UNIQUE (`workspace_id`, `id`) | Composite-FK parent key, additive only |
| `form_field_type`, `form_status` enums | Closed sets |
| `@support/types` field + answer-value schemas | The SDK↔server contract for the modal |
| `DEFAULT_BOT_PROMPT` / `DEFAULT_BOT_RULES` | The fallbacks `bot_config.prompt` and `.rules` resolve to |
| `buildSystemPrompt` | The single join site: two stored fields → one system prompt |
| `appendChangeLog` | The single choke point that writes audit rows |
| `REVOKE UPDATE, DELETE` on `form_answer` and `change_log` | Append-only, enforced not conventional |

### Out of scope — named so nobody wonders

- **The admin form-builder UI and its authoring workflow.** Nothing in this slice mints a
  `form_version` row or bumps a version. Seed data and Drizzle Studio are how forms exist until
  that spec lands.
- **The player-facing modal**, and the system message/card that reports the outcome in the thread.
- **The orchestrator's gating logic and event emission.** This slice defines what it reads; the
  orchestrator slice defines when.
- **The `attachment` table.** So `attachment.form_answer_id` (which `project-overview.md` says must
  exist) waits for the chat-attachments slice, and an `attachment` answer is declared but not
  writable — see *Field types* below.
- **`rule` and `rule_firing`.** The committed spec's *"the bot cannot be provisioned with an empty
  rule set"* invariant therefore cannot be enforced yet. Recorded, not implemented.
- **Audit writers other than `bot_config`.** The `change_log` table is generic, but the only thing
  this slice can audit is a bot-config save, because nothing here edits a form. The builder spec
  wires `form` / `form_version` audit into the same table with no schema change. Do not add
  `entity_type` values for writers that do not exist.
- **The audit-trail read API and UI.** The table and its writer land here; the admin screen that
  displays the history does not.
- **No `subintent_id` on `form_submission`.** Which subintent triggered a form is answered through
  the conversation at read time. The submission freezes `form_id` + `form_version` only.
- **No column for "which article was offered."** That stays in the `article_shown` /
  `article_rejected` events with the id in the payload — a fact in time, not a live pointer.

---

## Design decisions

### 1 · Fields live in a versioned jsonb array, not a `form_field` table

The committed spec models fields as `form_field` rows under a `form_version`, with
`form_answer.form_field_id` as an FK. This slice stores them as a validated jsonb array on
`form_version` and keys answers by a text `field_key`.

**Why.** A modal renders the entire field list in one shot, so there is never a per-field join to
save. A stable string key survives field reordering and relabelling without touching a single
answer row. And the authoring flow that would copy N `form_field` rows on every version mint is
owned by a different spec, so the table would exist unpopulated by anything but seed data.

**What is given up.** Nothing at the database layer stops an answer naming a `field_key` absent
from its version's `fields`. That check moves to the submission service. It is one guard in one
place, which is the trade accepted here.

This is a deviation from the committed schema spec; recorded in
`docs/decisions/spec-contradictions.md`.

### 2 · The current version is derived, not pointed at

There is no `current_version` column on `form`. The current version of a form is the highest
`version` with `published_at IS NOT NULL`. A pointer column would be a second source of truth that
can drift from the rows it points at; the schema spec already rejects a cursor column on the same
reasoning ("the bot's position is derivable — so no cursor column is needed").

`UNIQUE (form_id, version)` serves that lookup.

### 3 · A form is offered once per conversation

`UNIQUE (conversation_id, form_id)`. There is no re-offer path:

- Player submits → terminal. Player skips → terminal. Both are final.
- A reclassified conversation does **not** auto-offer its new subintent's form. The agent asks
  manually.

This is what makes `form_version` safe as a plain int snapshot: set at insert, never updated, so
the questions an answer was collected under can never be rewritten under it.

### 4 · Answers are append-only and self-describing

Corrections are made by adding a second row for the same `field_key`; newest `created_at` wins.
Never an in-place update — enforced by `REVOKE UPDATE ON form_answer FROM support_app`, the same
way the `event` spine is enforced, not by convention.

Each answer snapshots the field's declared `field_type` alongside `value`. `value` is therefore
interpretable without resolving the version, and a field retyped in some later version can never
make an old answer misread. This follows the existing rule that payload values are snapshotted,
never live pointers.

**Unanswered means no row.** There is no null `value` and no empty-answer sentinel, so `value` is
`NOT NULL` and "what's missing" is derived: the version's field keys minus the answered keys.

### 5 · Composite tenancy FKs on every new scoped→scoped FK

Per `docs/decisions/2026-08-04-composite-foreign-keys-for-tenancy.md` (Accepted): Postgres runs
referential-integrity checks with row security suspended, so a plain FK lets workspace A parent a
row on workspace B's row. Every FK below between two scoped tables carries `workspace_id`.

This matters concretely here: `form_submission.form_id` is a **client-supplied id** — the webview
says "open form X" — which is exactly the vector that ADR describes.

**Existing FKs are not converted.** This slice is additive: it adds the composite keys the new
tables need, including one on `conversation`, and leaves the seven FKs the ADR lists for the
eventual migration `002`. The ADR's requirement that new tables be "authored with composite FKs
from the start" is satisfied; its retrofit half is untouched.

FKs to `workspace` and `agent` stay single-column — those two tables are unscoped, so there is no
tenant to cross.

### 6 · Audit is a `change_log` table, not reused `event` rows

Editing a bot's prompt or turning its bot on is an administrative act that must be attributable.
`change_log` records **who changed which field, when, and from what to what** — field-level
granularity, so one save that edits the prompt and flips `is_provisioned` writes two rows.

`event` was considered and rejected as the home for this. It would have needed no new plumbing —
`appendEvent` already accepts a null `conversationId` and `sessionId`, and `event` is already
`REVOKE`-enforced — but two things ruled it out:

- **`event.actor_id` has no foreign key, deliberately**: the column holds an agent id or a player
  id depending on `actor_type`. An audit trail whose actor is unverifiable at the database layer is
  a weak audit trail. `change_log.actor_id` is `NOT NULL` with a real FK to `agent`.
- **`event` is the conversation/session reporting spine.** Admin config rows would have both
  `conversation_id` and `session_id` null, matching no existing index, and would silently enter any
  metric that aggregates event types without filtering — bot containment reads that table.

**`change_log` is the only home for a config change.** A `bot_config` edit does not also write an
`event`; two audit homes diverge.

### 7 · `last_sync_*` is not audit, and has no job here

The committed spec's `last_synced_at` / `last_sync_outcome` / `last_sync_error` on `bot_config` are
operational status — one row's worth of "did the last push to a bot provider succeed", overwritten
each time, with no actor and no before/after. They could not answer "who changed the prompt" even
if kept.

They are dropped because **nothing pushes bot config anywhere**: the orchestrator reads
`bot_config` from Postgres on every message, and the only external sync in the system is article
publishing to Weaviate (`docs/specs/2026-08-07-weaviate-faq-search-design.md`). Re-add them in the
slice that introduces an actual push, with a consumer.

---

## Schema

New Drizzle files, all exported from `schema/index.ts`:

| File | Tables |
|---|---|
| `backend/src/shared/db/schema/forms.ts` | `form`, `form_version`, `form_submission`, `form_answer` |
| `backend/src/shared/db/schema/bot.ts` | `bot_config` |
| `backend/src/shared/db/schema/audit.ts` | `change_log` |

`change_log` gets its own file rather than sitting in `bot.ts`: it is a general-purpose audit table
whose only current writer happens to be bot config, and filing it under `bot` would invite the next
slice to add a second audit table somewhere else.

### Enums — `schema/enums.ts`

```ts
export const formFieldType = pgEnum('form_field_type', [
  'short_text', 'long_text', 'number', 'date', 'time', 'choice', 'attachment',
])
export const formStatus = pgEnum('form_status', ['in_progress', 'completed', 'partial', 'skipped'])
```

`form_field_type` is the canonical list. It types the real `form_answer.field_type` column, and the
Zod union that validates `form_version.fields` is derived from the same array so the two cannot
drift.

### `form`

```
id            uuid pk default gen_random_uuid()
workspace_id  uuid not null -> workspace(id) restrict
name          text not null
created_by    uuid null -> agent(id) restrict
archived_at   timestamptz null
created_at    timestamptz not null default now()

UNIQUE (workspace_id, name)
UNIQUE (workspace_id, id)        -- composite-FK parent key
```

`created_by` is nullable and unset in this slice — the builder that would populate it ships later.
Same precedent as `subintent.default_priority`: the column exists so the later work needs no
migration.

`archived_at` retires a form from new use without deleting it.

### `form_version`

```
id            uuid pk default gen_random_uuid()
workspace_id  uuid not null -> workspace(id) restrict
form_id       uuid not null
version       integer not null
fields        jsonb not null default '[]'::jsonb
published_at  timestamptz null           -- null = draft
published_by  uuid null -> agent(id) restrict
created_at    timestamptz not null default now()

UNIQUE (form_id, version)
FK (workspace_id, form_id) -> form (workspace_id, id) ON DELETE RESTRICT
```

A version row is immutable once `published_at` is set. Nothing in this slice enforces that — the
authoring spec owns it — but no code here may update a published version's `fields`.

### `form_submission`

```
id               uuid pk default gen_random_uuid()
workspace_id     uuid not null -> workspace(id) restrict
conversation_id  uuid not null
form_id          uuid not null
form_version     integer not null      -- snapshot; set at insert, never updated
status           form_status not null default 'in_progress'
started_at       timestamptz not null default now()
submitted_at     timestamptz null

UNIQUE (conversation_id, form_id)
UNIQUE (workspace_id, id)              -- composite-FK parent key
FK (workspace_id, conversation_id) -> conversation (workspace_id, id) ON DELETE RESTRICT
FK (workspace_id, form_id)         -> form (workspace_id, id)         ON DELETE RESTRICT
FK (form_id, form_version)         -> form_version (form_id, version) ON DELETE RESTRICT
```

The third FK turns the version snapshot from a resolvable convention into an enforced one: a
submission cannot claim a version that does not exist.

### `form_answer`

```
id                  uuid pk default gen_random_uuid()
workspace_id        uuid not null -> workspace(id) restrict
form_submission_id  uuid not null
field_key           text not null
field_type          form_field_type not null    -- snapshot of the field's declared type
value               jsonb not null
created_at          timestamptz not null default now()

FK (workspace_id, form_submission_id) -> form_submission (workspace_id, id) ON DELETE RESTRICT
INDEX (form_submission_id, field_key, created_at)
```

No unique key on `(form_submission_id, field_key)` — multiple rows per field is the correction
mechanism, not an error.

### `bot_config`

```
workspace_id    uuid pk -> workspace(id) restrict
is_provisioned  boolean not null default false
prompt          text null
rules           text null
created_at      timestamptz not null default now()
updated_at      timestamptz not null default now()
```

**`prompt` and `rules` are two stored columns and one sent string.** They are stored apart so an
admin can rewrite the bot's persona without touching the safety rules, and so "who changed the
rules" is a separately auditable question from "who changed the prompt" — two `change_log` fields,
not one. They are joined only at send time, by `buildSystemPrompt(prompt, rules)` in
`backend/src/domain/bot/defaultPrompt.ts`, which is the single place the order and the `Rules:`
heading are decided. Never concatenate them before storage: a merged column cannot be edited or
audited as two fields again.

Both carry identical NULL semantics: NULL means never customized and resolves to `DEFAULT_BOT_PROMPT`
/ `DEFAULT_BOT_RULES` respectively. `DEFAULT_BOT_PROMPT` therefore carries **no** rules block of its
own — it lives in `DEFAULT_BOT_RULES`, or the join would ship the default rules twice.

`workspace_id` **is** the primary key, so one row per workspace is structural rather than a unique
key over a surrogate `id`. It still carries a `workspace_id` column, so `002_rls.sql`'s structural
policy loop picks the table up with no change to that file.

The committed spec's `last_synced_at`, `last_sync_outcome` and `last_sync_error` are dropped — see
*Design decisions* §7. Deviation recorded in `spec-contradictions.md`.

`is_provisioned` rather than `provisioned`, matching the committed spec and the `is_system` /
`is_required` convention in `taxonomy.ts`.

`updated_at` is a convenience for the admin screen, not the audit record. **Who** last changed the
config, and what it was before, come from `change_log` — there is no `updated_by` column here, for
the same reason `form` carries no `current_version` pointer: a denormalized copy is a second source
of truth that can drift from the rows it duplicates.

### `change_log`

```
id            bigserial pk
workspace_id  uuid not null -> workspace(id) restrict
entity_type   text not null                 -- 'bot_config' in this slice
entity_id     uuid not null                 -- for bot_config, the workspace_id
field         text not null                 -- 'prompt' | 'rules' | 'is_provisioned'
before_value  jsonb null                    -- null = the field had no value before
after_value   jsonb null                    -- null = the field was cleared
actor_id      uuid not null -> agent(id) restrict
changed_at    timestamptz not null default now()

CHECK (before_value IS DISTINCT FROM after_value)
INDEX (workspace_id, entity_type, entity_id, changed_at)
BRIN  (changed_at)
```

`bigserial` and a BRIN index on `changed_at`, matching `event`: the table only grows and is only
queried by entity or by time range.

`entity_type` is `text`, not an enum, for the same reason `event.type` is — new audited entities
arrive every slice, and a migration per entity type is friction with no safety benefit.

Both value columns are nullable, and each null carries one meaning: `before_value IS NULL` is the
first time that field was ever set, `after_value IS NULL` is the field being cleared (an admin
resetting `prompt` to the default). The `CHECK` makes a no-op audit row impossible — a row that
records a change from x to x is noise that makes a real audit harder to read.

`actor_id` is `NOT NULL` with a real FK. There is no system or bot actor: **every row in this table
is a human act.** An automated field change would need a deliberate design decision, not a nullable
column that quietly permits one.

**Append-only, enforced:** `REVOKE UPDATE, DELETE ON change_log FROM support_app`.

`entity_id` is `uuid` because every audited entity in the schema has a uuid primary key. For
`bot_config` that id *is* the `workspace_id`, which reads redundantly next to the `workspace_id`
column but keeps the table uniform — a reader never has to special-case one entity type.

### `subintent` — delta to an existing table

```
form_id  uuid null       -- the "No form table yet, no FK yet." comment is deleted
FK (workspace_id, form_id) -> form (workspace_id, id) ON DELETE RESTRICT
```

Cardinality follows from the column's shape, not from a constraint: a single nullable `form_id`
means a subintent maps to at most one form (null = never shows one), while many subintents may
point at the same form. The FK lives on `subintent` because that is the many side.

### `conversation` — delta to an existing table

```
UNIQUE (workspace_id, id)
```

Additive only, so `form_submission` can carry a composite FK to it. No existing FK is re-pointed.

---

## Field types

Seven, declared once in `form_field_type` and mirrored into `@support/types`.

| Type | `value` jsonb shape |
|---|---|
| `short_text` | JSON string, 1–500 chars |
| `long_text` | JSON string, 1–5000 chars |
| `number` | JSON number, finite |
| `date` | string `"YYYY-MM-DD"` |
| `time` | string `"HH:mm"`, 24-hour |
| `choice` | JSON string, must be present in that field's `options` |
| `attachment` | `{ "attachmentId": "<uuid>" }` — **not writable in this slice** |

`attachment` is declared now so the wire contract is frozen once — the contract rule is "add
response fields freely, never remove or retype one," and a type union a shipped client parses is
subject to the same reasoning. Until the `attachment` table exists, the submission service rejects
an `attachment` answer as unsupported and the builder cannot offer the type. This is the one
knowingly-inert type; everything else works end to end.

`time` is new relative to the committed spec's list of six.

---

## Shared types — `packages/types/src/forms.ts`

Exported from `packages/types/src/index.ts`.

```ts
export const FORM_FIELD_TYPES = [
  'short_text', 'long_text', 'number', 'date', 'time', 'choice', 'attachment',
] as const
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number]

export const formFieldSchema = z.object({
  key:        z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
  label:      z.string().min(1).max(200),
  type:       z.enum(FORM_FIELD_TYPES),
  isRequired: z.boolean(),
  position:   z.number().int().nonnegative(),
  options:    z.array(z.string().min(1)).min(2).optional(),
})
export type FormField = z.infer<typeof formFieldSchema>

export const formFieldsSchema = z.array(formFieldSchema).superRefine(/* … */)
```

`formFieldsSchema`'s refinements, all of which must be tested:

1. `key` is unique across the array.
2. `position` is unique across the array.
3. `options` is present when `type === 'choice'` and absent for every other type.
4. The array is non-empty for a version that is being published.

Answer-value validators, keyed by field type:

```ts
export const formAnswerValueSchemas = {
  short_text: z.string().min(1).max(500),
  long_text:  z.string().min(1).max(5000),
  number:     z.number().finite(),
  date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time:       z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  choice:     z.string().min(1),          // membership in options checked against the field
  attachment: z.object({ attachmentId: z.string().uuid() }),
} satisfies Record<FormFieldType, z.ZodTypeAny>
```

`choice` membership cannot be expressed in a standalone schema — it depends on the field's
`options` — so it is checked in the same guard that resolves the field.

Drizzle types the jsonb column against these: `jsonb('fields').$type<FormField[]>()`.

---

## Read and write rules

These are the semantics the columns carry. The routes that implement them belong to later slices;
implementing them differently makes the schema wrong.

### Does this subintent show a form?

All three must hold, or the answer is no:

1. `subintent.form_id IS NOT NULL`
2. that form's `archived_at IS NULL`
3. that form has at least one version with `published_at IS NOT NULL`

**A failure of any of these is "no form," never an error.** The conversation proceeds without a
modal. This is the same shape as the existing rule that missing player state is a state, not an
error.

The version used is the highest `version` with `published_at IS NOT NULL`, and its number is
snapshotted into `form_submission.form_version` at insert.

### Status meanings and transitions

| `status` | Means | `submitted_at` |
|---|---|---|
| `in_progress` | The modal is open | null |
| `completed` | Submitted, every required field answered | set |
| `partial` | Submitted with a required field left blank | set |
| `skipped` | Skip option used, or the modal dismissed | set |

Legal transitions: `in_progress → completed`, `in_progress → partial`, `in_progress → skipped`.
**All three are terminal.** There is no transition out of a terminal state and no path back to
`in_progress`.

`submitted_at` is set on every terminal state — it records when the outcome became known, not only
when a submit button was pressed. `in_progress` is the only status with a null `submitted_at`, so
nothing rots in an ambiguous state.

`partial` exists because `is_required` is soft, and it stays soft here: a required field may be
left blank and the submission still lands. **Nothing about a form may block a player reaching a
human.**

The thread's system card reads `status` directly — completed, partially completed, or skipped. A
skipped form is a row, not a missing row: the agent has to see that the player declined rather than
wonder where the details went.

### Writing an answer

For each answer, in one transaction with the status change:

1. Resolve the submission's `(form_id, form_version)` to its `form_version.fields`.
2. Reject a `field_key` absent from that array. This is the guard that replaces the FK a
   `form_field` table would have given.
3. Validate `value` against the field's declared type, plus `options` membership for `choice`.
4. Reject `attachment` as unsupported while the `attachment` table does not exist.
5. Insert a new row carrying `field_type` snapshotted from the resolved field. Never update.

### Reading answers

The current answer for a field is the row with the greatest `created_at` for that
`(form_submission_id, field_key)`. Older rows are history and are never hidden from an agent view
that wants them. `INDEX (form_submission_id, field_key, created_at)` serves this.

Missing fields are derived: the version's field keys minus the keys that have at least one answer.

### Reading `bot_config`

One resolver, so an absent row and `is_provisioned = false` cannot diverge:

```
row absent           -> { isProvisioned: false, prompt: DEFAULT_BOT_PROMPT, rules: DEFAULT_BOT_RULES, systemPrompt }
is_provisioned false -> { isProvisioned: false, prompt: <resolved as below>, rules: <resolved as below>, systemPrompt }
prompt IS NULL       -> DEFAULT_BOT_PROMPT
rules  IS NULL       -> DEFAULT_BOT_RULES
```

`resolveBotConfig` returns all four: the two resolved fields separately (so an admin screen can edit
each one) plus `systemPrompt`, the `buildSystemPrompt` join, which is what actually goes to the bot.
No caller joins them itself — one join site means the two cannot drift apart at different call sites.
`prompt` and `rules` resolve independently: customizing one leaves the other on its default.

No row exists until an admin first saves; the write is
`INSERT … ON CONFLICT (workspace_id) DO UPDATE`. There is no backfill and no seed change, and a
workspace created by any path is automatically in the correct off state.

`is_provisioned = false` means every message on that workspace's conversations takes the identical
fallback path as "bot disabled" — no bot reply, straight to the human queue.

`prompt IS NULL` (and `rules IS NULL`) means never customized. An empty or whitespace-only value is
rejected — `EmptyBotPrompt`, which names the offending field so a rules edit is not reported as a
prompt error — rather than stored, so null stays the only "no prompt" / "no rules" representation.
Clearing a customized value is an explicit reset to null, and it is audited like any other change.

### Writing `bot_config`, and auditing it

`backend/src/shared/changeLog/appendChangeLog.ts` — the single choke point, mirroring
`appendEvent`. Never insert into `change_log` directly.

```ts
export type ChangeLogInput = {
  workspaceId: string
  entityType: string
  entityId: string
  actorId: string                                              // the authenticated agent
  changes: Array<{ field: string; before: unknown; after: unknown }>
}

export async function appendChangeLog(tx: Tx, input: ChangeLogInput): Promise<void>
```

It writes one row per change, **after dropping every entry whose `before` deep-equals its `after`**
— so the database `CHECK` is a backstop against a bug, not a routine error path. A `changes` array
that is entirely no-ops writes nothing.

The `bot_config` upsert and its `appendChangeLog` call happen **in one transaction**, through one
function, following the existing rule that state changes never go through ad-hoc updates. A config
change that leaves no audit row is therefore impossible rather than merely unlikely, and a failed
audit write rolls the config change back.

Reading the audit trail: all changes to a workspace's bot config, newest first, is
`entity_type = 'bot_config' AND entity_id = <workspace_id>` ordered by `changed_at desc` — served
by `INDEX (workspace_id, entity_type, entity_id, changed_at)`. "Who last edited this" is the first
row of that scan.

**`prompt` before/after values are stored in full.** A prompt is long text and this duplicates it on
every edit; that is the cost of being able to answer "what did it say before," which is the whole
point. Prompts contain no player data, so this is not a PII surface.

The audited field names are the **column** names — `prompt`, `rules`, `is_provisioned` — not API
field names, so the trail stays readable against the schema when an API shape changes. A save that
edits the prompt and leaves the rules alone writes one row, for `prompt` only.

### `DEFAULT_BOT_PROMPT`, `DEFAULT_BOT_RULES` and `buildSystemPrompt`

`backend/src/domain/bot/defaultPrompt.ts` — the only non-schema code this slice adds.

`DEFAULT_BOT_PROMPT` must use the placeholder form the committed spec requires — `{{subintents}}`,
`{{articles}}`, `{{player_level}}`, `{{spend_tier}}`. Both it and `DEFAULT_BOT_RULES` **must never
contain a hard-coded subintent or article name**: a default that names a real subintent would ship
that workspace's taxonomy into every other workspace's bot. Both are asserted against
`SEED_TAXONOMY` in `tests/bot.config.test.ts`.

`DEFAULT_BOT_PROMPT` carries the role, the placeholders and the handoff instruction; the behavioural
constraints live in `DEFAULT_BOT_RULES`. `buildSystemPrompt(prompt, rules)` joins them — prompt
first, rules last under the `Rules:` heading, because a constraint stated after the task it
constrains is the one the model is most likely to still be holding when it answers. It takes the
already-resolved values, so neither argument is ever null, and substitution of the placeholders
happens after the join.

---

## Tenancy and grants

`002_rls.sql` is re-runnable and derives its policy list structurally from "any base table in
`public` with a `workspace_id` column." All six new tables have one — including `bot_config`,
where it is the primary key — so **all six get their `tenant` policy with no edit to the policy
loop**, which is the point of that design.

Two lines are added, after the `GRANT … ON ALL TABLES` block and alongside the existing `event`
revoke:

```sql
-- form_answer is append-only: corrections are a new row, never an in-place update.
REVOKE UPDATE ON form_answer FROM support_app;

-- change_log is the audit trail. An editable audit trail is not one.
REVOKE UPDATE, DELETE ON change_log FROM support_app;
```

`change_log` being RLS-scoped means an agent can only ever read their own workspace's audit trail,
which is the correct default. A cross-workspace admin view, if one is ever wanted, needs a
deliberate decision and a different connection — not a policy exception added quietly here.

`DELETE` is granted nowhere already, per "no hard deletes anywhere." Every FK above is
`ON DELETE RESTRICT`.

Handler-side scoped-`SELECT` pre-verification of client-supplied ids **remains mandatory** for
everything else in the codebase — the composite FKs here cover only these tables, and the ADR's
comments saying so must not be removed as redundant.

---

## Migration

`drizzle-kit` push via `pnpm db:setup`, which re-runs `002_rls.sql` afterwards. Order matters:

1. Create the `form_field_type` and `form_status` enums.
2. Add `UNIQUE (workspace_id, id)` to `conversation`.
3. Create `form` (with its `UNIQUE (workspace_id, id)`), then `form_version`.
4. Add the composite FK on `subintent.form_id`. Existing `subintent` rows all have
   `form_id IS NULL`, so no data fails the new constraint.
5. Create `form_submission` (with its `UNIQUE (workspace_id, id)`), then `form_answer`.
6. Create `bot_config`, with `prompt` and `rules` as two separate nullable text columns.
7. Create `change_log`, with its `CHECK`, composite index and BRIN index.
8. `002_rls.sql` — picks up six new policies structurally, applies the `form_answer` and
   `change_log` revokes.

Steps 2–3 must precede the FKs that depend on them. No existing row anywhere is rewritten and no
existing FK is re-pointed, so this migration is additive and reversible by dropping the new
objects.

---

## Verification

### `tests/schema.test.ts` additions

- All six tables exist with the columns and nullability above.
- `bot_config`'s primary key is `workspace_id`, and there is no `id` column.
- `form_status` and `form_field_type` have exactly the listed values, in order.
- `UNIQUE (conversation_id, form_id)` on `form_submission`, `UNIQUE (form_id, version)` on
  `form_version`, `UNIQUE (workspace_id, name)` on `form`.
- Every FK listed is composite where specified, and every one is `ON DELETE RESTRICT`.
- `INDEX (form_submission_id, field_key, created_at)` exists.

### New `tests/forms.dataModel.test.ts`

- **Append-only is enforced:** `UPDATE form_answer` as `support_app` is refused. `DELETE` too.
- **Composite FK blocks the cross-tenant edge:** with `app.workspace_id` set to A, inserting a
  `form_submission` whose `form_id` belongs to workspace B is refused by the database — not by a
  handler. Mirror the probe in `rls.test.ts`. Same for `conversation_id` and for
  `form_answer.form_submission_id`.
- **Offered once:** a second `form_submission` for the same `(conversation_id, form_id)` is
  refused.
- **Version snapshot is enforced:** a `form_submission` naming a `(form_id, form_version)` with no
  matching `form_version` row is refused.
- **Correction by adding:** two answers for one `field_key`, and the newest-`created_at` read
  returns the second.
- **Unanswered is absence:** the derived missing-fields set equals the version's keys minus the
  answered keys, with no null-valued row involved.
- **RLS covers all six:** each new table has a `tenant` policy and is invisible across workspaces.
  Extend the existing structural assertion rather than listing tables by hand.

### New `tests/forms.types.test.ts`

- `formFieldsSchema` rejects: duplicate `key`, duplicate `position`, `choice` without `options`,
  a non-`choice` type carrying `options`, a `key` violating the pattern, an empty array on publish.
- `formAnswerValueSchemas` accepts and rejects at each boundary per the field-type table —
  including `"24:00"` and `"1:5"` for `time`, `"2026-13-01"` for `date`, and a non-finite `number`.
- `choice` membership is rejected for a value absent from that field's `options`.

### `tests/bot.config.test.ts`

- Absent row resolves to `{ isProvisioned: false, prompt: DEFAULT_BOT_PROMPT, rules: DEFAULT_BOT_RULES }`.
- `prompt IS NULL` resolves to `DEFAULT_BOT_PROMPT`; a stored prompt is returned verbatim. Same for
  `rules` / `DEFAULT_BOT_RULES`, and the two resolve **independently** — customizing one leaves the
  other on its default.
- `ON CONFLICT (workspace_id) DO UPDATE` upserts rather than erroring on second save.
- Neither `DEFAULT_BOT_PROMPT` nor `DEFAULT_BOT_RULES` contains a subintent or article name; the
  prompt does contain the placeholders, and carries no `Rules:` block of its own.
- `buildSystemPrompt` puts the prompt first and the rules last, and leaves the placeholders intact.
- Clearing the prompt does not clear the rules; a whitespace-only value for either is rejected with
  `EmptyBotPrompt` naming that field.

### New `tests/changeLog.test.ts`

- **Append-only is enforced:** `UPDATE change_log` and `DELETE FROM change_log` as `support_app` are
  both refused.
- **No-ops are dropped:** `appendChangeLog` with `before === after` writes zero rows, and a mixed
  array writes only the genuinely changed fields.
- **The `CHECK` is a real backstop:** a direct insert with `before_value = after_value` is refused by
  the database.
- **Null semantics:** a first-ever `prompt` set writes `before_value IS NULL`; clearing it writes
  `after_value IS NULL`; neither is confused for the other on read.
- **Atomicity:** a `bot_config` save whose `appendChangeLog` call throws leaves **no** config change
  committed. This is the test that proves the invariant, so it must exercise a real transaction
  rollback, not a mocked one.
- **Field-level granularity:** one save changing `prompt` and `is_provisioned` writes exactly two
  rows, both with the same `actor_id` and the same transaction's `changed_at`.
- **Attribution:** `actor_id` is the authenticated agent, and an insert naming a nonexistent agent
  is refused by the FK.
- **Tenancy:** a workspace cannot read another workspace's `change_log` rows.
- **Read path:** newest-first by `changed_at` for a given `(entity_type, entity_id)` returns the
  most recent change, and the composite index is the one chosen — assert on the query plan the way
  the existing index tests do, if that pattern exists; otherwise assert ordering only.

---

## Deviations from the committed schema spec

Both are recorded in `docs/decisions/spec-contradictions.md`:

1. **Forms use `form_version.fields` jsonb + `form_answer.field_key`**, not a `form_field` table
   with `form_answer.form_field_id`. Reasoning in *Design decisions* §1.
2. **`bot_config` is keyed by `workspace_id`** and drops `last_synced_at` / `last_sync_outcome` /
   `last_sync_error`. Reasoning in *Design decisions* §7 — those columns are operational sync status,
   not audit, and audit is `change_log`.

`change_log` itself is **not** a deviation: the committed spec designs it, this slice is simply where
it first lands, with `bot_config` as its only writer for now.

Also worth reading against the older spec text, though these follow the 2026-08-10 supersession in
`project-overview.md` rather than contradicting it: `form_answer.message_id` is gone, `partial`
means submitted-with-gaps rather than abandoned-mid-questionnaire, and `is_required`'s
"re-ask once" enforcement point has no bot turn to live in.
