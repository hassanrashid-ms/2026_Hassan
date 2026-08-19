# Bot Config and Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `bot_config` and `change_log` tables, the single audit writer that feeds them, and the resolver that collapses "no row", "not provisioned" and "no prompt" into one answer — so the bot orchestrator has something to gate on and every config edit is attributable.

**Architecture:** Two new Drizzle schema files (`bot.ts`, `audit.ts`), one append-only enforcement revoke in `002_rls.sql`, and two service modules: `appendChangeLog` (the only thing that inserts into `change_log`, mirroring the existing `appendEvent`) and `botConfig.ts` (`resolveBotConfig` for reads, `saveBotConfig` for the upsert-plus-audit write, both taking a `Tx` so the caller owns the transaction). No Express route, no `openapi.ts` entry, no frontend — per the spec, "the routes that implement them belong to later slices."

**Tech Stack:** TypeScript (native `.ts` ESM imports, extensions included), Drizzle ORM 0.45.2 + `drizzle-kit` push, PostgreSQL 17, Vitest, `node:util`'s `isDeepStrictEqual`.

**Source spec:** `docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md` (Status: Accepted). This plan implements **only** the bot/audit half of that spec.

## Global Constraints

- **Scope is the bot half only.** Do not create `form`, `form_version`, `form_submission`, `form_answer`, the `form_field_type` / `form_status` enums, `packages/types/src/forms.ts`, the `subintent.form_id` FK, or `conversation UNIQUE (workspace_id, id)`. None of them are needed here: `bot_config` FKs only to `workspace`, `change_log` only to `workspace` and `agent`.
- **Do not add the `REVOKE UPDATE ON form_answer` line to `002_rls.sql`.** `form_answer` does not exist yet, `002_rls.sql` is re-runnable and runs on every `pnpm db:setup`, so the statement would abort setup for everyone.
- **No hard deletes.** Every FK is `ON DELETE RESTRICT`. `DELETE` is granted on nothing.
- **`change_log` is append-only, enforced by `REVOKE UPDATE, DELETE`, not by convention.** `bot_config` deliberately keeps `UPDATE` — its writer is `ON CONFLICT … DO UPDATE`. Do not "tidy" the revoke into covering both tables.
- **Never insert into `change_log` outside `appendChangeLog`.** Same rule as `event` / `appendEvent`.
- **Audited field names are column names** — `prompt`, `is_provisioned` — never API field names.
- **`DEFAULT_BOT_PROMPT` must contain the four placeholders** `{{subintents}}`, `{{articles}}`, `{{player_level}}`, `{{spend_tier}}` and **must never contain a real subintent, intent or article name.**
- **A `bot_config` write and its audit rows happen in one transaction, through one function.** A config change with no audit row must be impossible, not merely unlikely.
- Imports carry the `.ts` extension (`from './identity.ts'`). Follow the existing schema files exactly.
- Never `console.*`. Use `logger` from `backend/src/shared/logging/logger.ts` if logging is needed (it isn't, in this slice).
- All commands run from the repo root: `/Users/hassanrashid/Desktop/git/mindstorm/crm/app`. Postgres and Redis must be up (`docker compose up -d`) for any test that touches the database.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `backend/src/shared/db/schema/bot.ts` | create | `bot_config` table only |
| `backend/src/shared/db/schema/audit.ts` | create | `change_log` table only — its own file, so the next slice doesn't invent a second audit table elsewhere |
| `backend/src/shared/db/schema/index.ts` | modify | two new `export *` lines |
| `backend/src/shared/db/sql/002_rls.sql` | modify | one revoke block for `change_log` |
| `backend/src/domain/bot/defaultPrompt.ts` | create | `DEFAULT_BOT_PROMPT` + `BOT_PROMPT_PLACEHOLDERS` |
| `backend/src/domain/bot/botConfig.ts` | create | `resolveBotConfig`, `saveBotConfig`, `EmptyBotPrompt`, `BOT_CONFIG_ENTITY_TYPE` |
| `backend/src/domain/bot/index.ts` | create | barrel, matching `domain/conversations/index.ts` |
| `backend/src/shared/changeLog/appendChangeLog.ts` | create | the single audit writer |
| `backend/tests/helpers/db.ts` | modify | `truncateAll` covers the new tables; `seedBotConfig` helper |
| `backend/tests/schema.test.ts` | modify | table count 14 → 16, plus structural assertions for both tables |
| `backend/tests/rls.test.ts` | modify | `SCOPED_TABLES` gains both tables; append-only probe for `change_log`; `bot_config` stays updatable |
| `backend/tests/bot.config.test.ts` | create | resolver + upsert + default-prompt behaviour |
| `backend/tests/changeLog.test.ts` | create | audit writer semantics, atomicity, attribution, tenancy |

`docs/decisions/spec-contradictions.md` needs **no** edit — §15 already records the `bot_config` shape decision.

---

### Task 1: The two tables

**Files:**
- Create: `backend/src/shared/db/schema/bot.ts`
- Create: `backend/src/shared/db/schema/audit.ts`
- Modify: `backend/src/shared/db/schema/index.ts`
- Modify: `backend/tests/helpers/db.ts` (the `SCOPED_TABLES` array used by `truncateAll`)
- Test: `backend/tests/schema.test.ts`

**Interfaces:**
- Consumes: `workspace` and `agent` from `./identity.ts`.
- Produces: `botConfig` and `changeLog` Drizzle table objects, exported from `backend/src/shared/db/schema/index.ts`. Column properties: `botConfig.workspaceId`, `.isProvisioned`, `.prompt`, `.createdAt`, `.updatedAt`; `changeLog.id`, `.workspaceId`, `.entityType`, `.entityId`, `.field`, `.beforeValue`, `.afterValue`, `.actorId`, `.changedAt`.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/schema.test.ts`, add `'bot_config'` and `'change_log'` to `EXPECTED_TABLES` in alphabetical position (between `'article_attachment'` and `'conversation'`), and rename the existing test so its title is not a lie:

```ts
const EXPECTED_TABLES = [
  'agent',
  'article',
  'article_attachment',
  'bot_config',
  'change_log',
  'conversation',
  'declared_field',
  'event',
  'intent',
  'message',
  'player',
  'player_state_snapshot',
  'session',
  'subintent',
  'workspace',
  'workspace_member',
]
```

```ts
  it('creates exactly the sixteen tables of the SDK-path + articles-KB + bot-config subset', async () => {
```

Then append these three tests inside the same `describe('schema', …)` block:

```ts
  it('keys bot_config by workspace_id itself — one row per workspace is structural', async () => {
    const cols = await columns('bot_config')
    expect(cols.has('id')).toBe(false)
    expect(cols.get('is_provisioned')?.nullable).toBe(false)
    expect(cols.get('is_provisioned')?.hasDefault).toBe(true)
    expect(cols.get('prompt')?.nullable).toBe(true)
    expect(cols.get('updated_at')?.nullable).toBe(false)

    const { rows } = await ownerPool.query<{ column_name: string }>(
      `select a.attname as column_name
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
        where t.relname = 'bot_config' and c.contype = 'p'`,
    )
    expect(rows.map((r) => r.column_name)).toEqual(['workspace_id'])
  })

  it('gives change_log a growing bigserial key, both value columns nullable, and a NOT NULL actor', async () => {
    const cols = await columns('change_log')
    expect(cols.get('id')?.type).toBe('bigint')
    expect(cols.get('entity_type')?.type).toBe('text')
    expect(cols.get('entity_id')?.type).toBe('uuid')
    expect(cols.get('before_value')?.nullable).toBe(true)
    expect(cols.get('after_value')?.nullable).toBe(true)
    expect(cols.get('actor_id')?.nullable).toBe(false)
    expect(cols.get('changed_at')?.nullable).toBe(false)

    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'change_log'`,
    )
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/\(workspace_id, entity_type, entity_id, changed_at\)/)
    expect(defs).toMatch(/brin \(changed_at\)/)
  })

  it('makes a no-op audit row impossible at the database layer', async () => {
    const { rows } = await ownerPool.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname = 'change_log' and c.contype = 'c'`,
    )
    expect(rows.map((r) => r.def).join('\n')).toMatch(/before_value IS DISTINCT FROM after_value/i)
  })

  it('restricts every delete on the two new tables — nothing is ever deleted', async () => {
    const { rows } = await ownerPool.query<{ table_name: string; def: string }>(
      `select t.relname as table_name, pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname in ('bot_config', 'change_log') and c.contype = 'f'`,
    )
    expect(rows).toHaveLength(3) // bot_config→workspace, change_log→workspace, change_log→agent
    for (const row of rows) {
      expect(row.def, `${row.table_name}: ${row.def}`).toMatch(/ON DELETE RESTRICT/)
    }
  })
```

Also extend `SCOPED_TABLES` in `backend/tests/helpers/db.ts` so `truncateAll` clears the new tables — children before parents, matching the existing ordering convention:

```ts
const SCOPED_TABLES = [
  'change_log',
  'bot_config',
  'event',
  'message',
  'conversation',
  'player_state_snapshot',
  'declared_field',
  'session',
  'player',
  'workspace_member',
  'agent',
  'workspace',
]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @support/backend exec vitest run tests/schema.test.ts`
Expected: FAIL — the table-list assertion reports `bot_config` and `change_log` missing, the new tests fail on empty column maps, and `truncateAll` throws `relation "change_log" does not exist`.

- [ ] **Step 3: Create `backend/src/shared/db/schema/bot.ts`**

```ts
import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { workspace } from './identity.ts'

const tz = { withTimezone: true, mode: 'date' } as const

/**
 * What the orchestrator gates on, and the prompt it sends.
 *
 * `workspace_id` IS the primary key: one row per workspace is structural rather
 * than a unique key over a surrogate id. It is still a `workspace_id` column, so
 * 002_rls.sql's structural policy loop picks this table up with no edit to it.
 *
 * There is no `updated_by`, and no `last_sync_*`. WHO changed the config and what
 * it was before come from `change_log` — a denormalised copy here would be a
 * second source of truth that can drift from the rows it duplicates. Nothing
 * pushes bot config anywhere, so there is no sync status to record.
 *
 * No row exists until an admin first saves, and an absent row means exactly the
 * same thing as `is_provisioned = false` — see resolveBotConfig, which is the
 * only place that distinction is allowed to be resolved.
 */
export const botConfig = pgTable('bot_config', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  isProvisioned: boolean('is_provisioned').notNull().default(false),
  /** NULL means never customised, and resolves to DEFAULT_BOT_PROMPT. An empty
   *  or whitespace-only prompt is rejected before storage, so NULL stays the
   *  only representation of "no prompt". */
  prompt: text('prompt'),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  /** A convenience for the admin screen, not the audit record. Bumped explicitly
   *  by saveBotConfig — deliberately not a trigger, which would be a writer the
   *  audit path cannot see. */
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
})
```

- [ ] **Step 4: Create `backend/src/shared/db/schema/audit.ts`**

```ts
import { sql } from 'drizzle-orm'
import { bigserial, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agent, workspace } from './identity.ts'

const tz = { withTimezone: true, mode: 'date' } as const

/**
 * The audit trail: who changed which field, when, and from what to what.
 * Field-level granularity — one save that edits two fields writes two rows.
 *
 * Append-only. Enforcement is REVOKE UPDATE, DELETE in 002_rls.sql: an editable
 * audit trail is not one.
 *
 * NOT the `event` spine, deliberately. `event.actor_id` has no foreign key
 * because it holds an agent id or a player id depending on actor_type, and an
 * audit trail whose actor is unverifiable at the database layer is a weak one.
 * `event` is also the conversation/session reporting spine, and admin config
 * rows would silently enter any metric that aggregates event types.
 *
 * `actor_id` is NOT NULL with a real FK: every row in this table is a human act.
 * A system or bot actor would need a deliberate design decision, not a nullable
 * column that quietly permits one.
 *
 * A bot_config edit writes here and does NOT also write an `event`. Two audit
 * homes diverge.
 */
export const changeLog = pgTable(
  'change_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    /** text, not an enum, for the same reason `event.type` is: new audited
     *  entities arrive every slice, and a migration per type is friction with no
     *  safety benefit. Only 'bot_config' is written in this slice — do not add
     *  values for writers that do not exist. */
    entityType: text('entity_type').notNull(),
    /** uuid because every audited entity has a uuid pk. For bot_config this IS
     *  the workspace_id, which reads redundantly next to the column above but
     *  keeps the table uniform — a reader never special-cases one entity type. */
    entityId: uuid('entity_id').notNull(),
    /** The COLUMN name — 'prompt', 'is_provisioned' — never an API field name,
     *  so the trail stays readable against the schema when an API shape changes. */
    field: text('field').notNull(),
    /** NULL means the field had no value before: the first time it was ever set. */
    beforeValue: jsonb('before_value'),
    /** NULL means the field was cleared — e.g. a prompt reset to the default. */
    afterValue: jsonb('after_value'),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'restrict' }),
    changedAt: timestamp('changed_at', tz).notNull().defaultNow(),
  },
  (t) => [
    // A row recording a change from x to x is noise that makes a real audit
    // harder to read. appendChangeLog drops no-ops before insert; this is the
    // backstop against a bug there, not a routine error path.
    check('change_log_value_changed', sql`${t.beforeValue} is distinct from ${t.afterValue}`),
    // The read path: one entity's history, newest first.
    index('change_log_entity_changed_idx').on(t.workspaceId, t.entityType, t.entityId, t.changedAt),
    // bigserial + BRIN, matching `event`: the table only grows and is only
    // queried by entity or by time range.
    index('change_log_changed_brin').using('brin', t.changedAt),
  ],
)
```

- [ ] **Step 5: Export both from the schema barrel**

In `backend/src/shared/db/schema/index.ts`, append:

```ts
export * from './bot.ts'
export * from './audit.ts'
```

- [ ] **Step 6: Push the schema and re-run the tests**

Run: `pnpm db:setup && pnpm --filter @support/backend exec vitest run tests/schema.test.ts`
Expected: PASS, all tests including the four new ones.

If `drizzle-kit` push prompts about the new tables, accept. If the `CHECK` constraint does not appear in `pg_constraint` after push, do **not** work around it in application code — add the constraint to `002_rls.sql` instead (it is re-runnable, so use `ALTER TABLE change_log DROP CONSTRAINT IF EXISTS change_log_value_changed; ALTER TABLE change_log ADD CONSTRAINT change_log_value_changed CHECK (before_value IS DISTINCT FROM after_value);`) and note it in the commit message.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add backend/src/shared/db/schema/bot.ts backend/src/shared/db/schema/audit.ts \
        backend/src/shared/db/schema/index.ts backend/tests/helpers/db.ts backend/tests/schema.test.ts
git commit -m "feat(db): add bot_config and change_log tables"
```

---

### Task 2: Append-only enforcement and tenancy

**Files:**
- Modify: `backend/src/shared/db/sql/002_rls.sql`
- Test: `backend/tests/rls.test.ts`

**Interfaces:**
- Consumes: the two tables from Task 1.
- Produces: nothing importable. Guarantees `support_app` can `INSERT`/`SELECT` on `change_log` but never `UPDATE` or `DELETE`, and can `INSERT`/`SELECT`/`UPDATE` on `bot_config` but never `DELETE`. Task 6's upsert depends on that `UPDATE` grant.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/rls.test.ts`, add both tables to `SCOPED_TABLES` so the existing per-table policy loops cover them:

```ts
const SCOPED_TABLES = [
  'workspace_member',
  'player',
  'session',
  'player_state_snapshot',
  'declared_field',
  'conversation',
  'message',
  'event',
  'bot_config',
  'change_log',
]
```

Then add these three tests inside the `describe('row-level security', …)` block:

```ts
  it('cannot update or delete a change_log row — an editable audit trail is not one', async () => {
    const agentId = 'cccccccc-3333-3333-3333-333333333333'
    await ownerPool.query(
      `insert into agent (id, email, display_name) values ($1, 'auditor@example.test', 'Auditor')`,
      [agentId],
    )
    await ownerPool.query(
      `insert into change_log (workspace_id, entity_type, entity_id, field, before_value, after_value, actor_id)
       values ($1, 'bot_config', $1, 'is_provisioned', 'false'::jsonb, 'true'::jsonb, $2)`,
      [WS_A, agentId],
    )

    await expect(
      asWorkspace(WS_A, () => app.query(`update change_log set after_value = 'false'::jsonb`)),
    ).rejects.toThrow(/permission denied/i)
    await expect(asWorkspace(WS_A, () => app.query('delete from change_log'))).rejects.toThrow(
      /permission denied/i,
    )
  })

  it('keeps bot_config updatable — its writer is ON CONFLICT DO UPDATE', async () => {
    await ownerPool.query(
      `insert into bot_config (workspace_id, is_provisioned) values ($1, false)`,
      [WS_A],
    )
    const rows = await asWorkspace(WS_A, async () => {
      await app.query(`update bot_config set is_provisioned = true`)
      return (await app.query(`select is_provisioned from bot_config`)).rows
    })
    expect(rows).toEqual([{ is_provisioned: true }])

    await expect(asWorkspace(WS_A, () => app.query('delete from bot_config'))).rejects.toThrow(
      /permission denied/i,
    )
  })

  it('hides another workspace audit trail entirely', async () => {
    const agentId = 'dddddddd-4444-4444-4444-444444444444'
    await ownerPool.query(
      `insert into agent (id, email, display_name) values ($1, 'other@example.test', 'Other')`,
      [agentId],
    )
    for (const ws of [WS_A, WS_B]) {
      await ownerPool.query(
        `insert into change_log (workspace_id, entity_type, entity_id, field, before_value, after_value, actor_id)
         values ($1, 'bot_config', $1, 'prompt', null, '"hi"'::jsonb, $2)`,
        [ws, agentId],
      )
    }
    const rows = await asWorkspace(WS_A, async () =>
      (await app.query('select workspace_id from change_log')).rows,
    )
    expect(rows).toEqual([{ workspace_id: WS_A }])
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @support/backend exec vitest run tests/rls.test.ts`
Expected: FAIL — the `change_log` update/delete test fails because `GRANT … ON ALL TABLES` gave `support_app` `UPDATE`, so the `update` succeeds instead of raising `permission denied`.

- [ ] **Step 3: Add the revoke to `002_rls.sql`**

Insert this block immediately after the existing `-- 2 - The event spine is append-only.` block and before `-- 2b`:

```sql
-- 2a - change_log is the audit trail. An editable audit trail is not one, so
-- UPDATE and DELETE come straight back off after the blanket GRANT above.
--
-- bot_config deliberately KEEPS UPDATE: its only writer is an
-- INSERT ... ON CONFLICT (workspace_id) DO UPDATE, so revoking here would break
-- the second save on every workspace. Do not "tidy" these two into symmetry.
--
-- form_answer gets the same REVOKE UPDATE treatment when that table lands. It
-- cannot be listed here yet: this file re-runs on every db:setup, and naming a
-- table that does not exist aborts setup for everyone.
REVOKE UPDATE, DELETE ON change_log FROM support_app;
REVOKE UPDATE, DELETE ON change_log FROM PUBLIC;
```

- [ ] **Step 4: Re-run setup and the tests**

Run: `pnpm db:setup && pnpm --filter @support/backend exec vitest run tests/rls.test.ts`
Expected: PASS, including the existing structural drift guard, which now covers ten scoped tables.

- [ ] **Step 5: Commit**

```bash
git add backend/src/shared/db/sql/002_rls.sql backend/tests/rls.test.ts
git commit -m "feat(db): enforce change_log append-only with REVOKE UPDATE, DELETE"
```

---

### Task 3: `DEFAULT_BOT_PROMPT`

**Files:**
- Create: `backend/src/domain/bot/defaultPrompt.ts`
- Create: `backend/tests/bot.config.test.ts`

**Interfaces:**
- Consumes: `SEED_TAXONOMY` from `backend/src/shared/db/seedTaxonomy.ts` (test only) — typed `SeedIntent[]` where `SeedIntent = { name: string; subintents: string[]; articles: SeedArticle[] }` and `SeedArticle = { title: string; body: string; keywords: string[] }`.
- Produces: `DEFAULT_BOT_PROMPT: string` and `BOT_PROMPT_PLACEHOLDERS: readonly ['{{subintents}}', '{{articles}}', '{{player_level}}', '{{spend_tier}}']`, both from `backend/src/domain/bot/defaultPrompt.ts`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/bot.config.test.ts`. This file grows in Tasks 5 and 6; start with the pure, no-database part so it runs fast:

```ts
import { describe, expect, it } from 'vitest'
import { BOT_PROMPT_PLACEHOLDERS, DEFAULT_BOT_PROMPT } from '../src/domain/bot/defaultPrompt.ts'
import { SEED_TAXONOMY } from '../src/shared/db/seedTaxonomy.ts'

describe('DEFAULT_BOT_PROMPT', () => {
  it('carries every placeholder the orchestrator substitutes', () => {
    for (const placeholder of BOT_PROMPT_PLACEHOLDERS) {
      expect(DEFAULT_BOT_PROMPT, `missing ${placeholder}`).toContain(placeholder)
    }
  })

  it('names no real subintent, intent or article — it ships to every workspace', () => {
    const haystack = DEFAULT_BOT_PROMPT.toLowerCase()
    const forbidden = SEED_TAXONOMY.flatMap((intent) => [
      intent.name,
      ...intent.subintents,
      ...intent.articles.map((article) => article.title),
    ])

    expect(forbidden.length).toBeGreaterThan(0) // guard: an empty seed would vacuously pass
    for (const name of forbidden) {
      expect(haystack, `leaks taxonomy name "${name}"`).not.toContain(name.toLowerCase())
    }
  })

  it('is not empty or whitespace — it is the fallback every uncustomised bot runs on', () => {
    expect(DEFAULT_BOT_PROMPT.trim().length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/backend exec vitest run tests/bot.config.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/bot/defaultPrompt.ts'`.

- [ ] **Step 3: Create `backend/src/domain/bot/defaultPrompt.ts`**

```ts
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

Context about this player:
- Progress: {{player_level}}
- Spending tier: {{spend_tier}}

Rules:
- Never invent a fact about the game, an account, a purchase, a refund, or a balance. If the articles do not say it, you do not know it.
- If the player is upset, reports lost money or lost progress, mentions a legal or safety issue, or asks for a human, hand off immediately and say you are doing so.
- If you are not confident an article answers the question, hand off. A fast handoff is a good outcome, not a failure.
- Never promise a compensation, a refund, a timeline, or an outcome. A human decides those.
- Never ask the player for a password, a payment detail, or a one-time code.
- Reply in the player's language, in at most three short sentences. This is a chat window on a phone, not an email.
- Do not greet the player again if the conversation is already underway.

When you hand off, say plainly that you are passing this to the support team, and stop. Do not keep asking questions to fill the gap.`
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @support/backend exec vitest run tests/bot.config.test.ts`
Expected: PASS, 3 tests.

If the taxonomy test fails, the prompt has collided with a seeded name (for example a seeded intent literally called "Billing" matching the word "billing"). Reword the prompt — never loosen the assertion.

- [ ] **Step 5: Create the domain barrel**

Create `backend/src/domain/bot/index.ts`, matching `backend/src/domain/conversations/index.ts`:

```ts
export * from './defaultPrompt.ts'
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain/bot/defaultPrompt.ts backend/src/domain/bot/index.ts backend/tests/bot.config.test.ts
git commit -m "feat(bot): add DEFAULT_BOT_PROMPT with no hard-coded taxonomy"
```

---

### Task 4: `appendChangeLog`

**Files:**
- Create: `backend/src/shared/changeLog/appendChangeLog.ts`
- Modify: `backend/tests/helpers/db.ts` (add `seedBotConfig`)
- Test: `backend/tests/changeLog.test.ts`

**Interfaces:**
- Consumes: `Tx` from `backend/src/shared/db/withWorkspace.ts`, `changeLog` from the schema barrel.
- Produces:
  ```ts
  export type ChangeLogChange = { field: string; before: unknown; after: unknown }
  export type ChangeLogInput = {
    workspaceId: string
    entityType: string
    entityId: string
    actorId: string
    changes: readonly ChangeLogChange[]
  }
  export async function appendChangeLog(tx: Tx, input: ChangeLogInput): Promise<void>
  ```
  Task 6 calls this.

- [ ] **Step 1: Add the `seedBotConfig` helper**

In `backend/tests/helpers/db.ts`, append:

```ts
export async function seedBotConfig(args: {
  workspaceId: string
  isProvisioned?: boolean
  prompt?: string | null
}): Promise<void> {
  await ownerPool.query(
    `insert into bot_config (workspace_id, is_provisioned, prompt) values ($1, $2, $3)`,
    [args.workspaceId, args.isProvisioned ?? false, args.prompt ?? null],
  )
}
```

- [ ] **Step 2: Write the failing test**

Create `backend/tests/changeLog.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { getEnv } from '../src/env.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { appendChangeLog } from '../src/shared/changeLog/appendChangeLog.ts'
import { closeOwnerPool, ownerPool, seedAgent, seedWorkspace, truncateAll } from './helpers/db.ts'

let workspaceId: string
let otherWorkspaceId: string
let actorId: string

type Row = {
  field: string
  before_value: unknown
  after_value: unknown
  actor_id: string
  entity_type: string
  entity_id: string
  changed_at: Date
}

async function rows(ws = workspaceId): Promise<Row[]> {
  const { rows } = await ownerPool.query<Row>(
    `select field, before_value, after_value, actor_id, entity_type, entity_id, changed_at
       from change_log where workspace_id = $1 order by field`,
    [ws],
  )
  return rows
}

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(async () => {
  await truncateAll()
  workspaceId = await seedWorkspace()
  otherWorkspaceId = await seedWorkspace()
  actorId = await seedAgent()
})

describe('appendChangeLog', () => {
  it('writes one row per changed field, all sharing the transaction timestamp', async () => {
    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [
          { field: 'is_provisioned', before: false, after: true },
          { field: 'prompt', before: null, after: 'be helpful' },
        ],
      }),
    )

    const written = await rows()
    expect(written.map((r) => r.field)).toEqual(['is_provisioned', 'prompt'])
    expect(written.every((r) => r.actor_id === actorId)).toBe(true)
    expect(written.every((r) => r.entity_type === 'bot_config')).toBe(true)
    expect(written.every((r) => r.entity_id === workspaceId)).toBe(true)
    // now() is transaction start time in Postgres, so one insert shares one stamp.
    expect(written[0]?.changed_at.getTime()).toBe(written[1]?.changed_at.getTime())
  })

  it('drops no-ops, and writes nothing at all when every change is a no-op', async () => {
    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [
          { field: 'is_provisioned', before: true, after: true },
          { field: 'prompt', before: 'same', after: 'same' },
        ],
      }),
    )
    expect(await rows()).toHaveLength(0)

    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [
          { field: 'is_provisioned', before: false, after: false },
          { field: 'prompt', before: null, after: 'new' },
        ],
      }),
    )
    expect((await rows()).map((r) => r.field)).toEqual(['prompt'])
  })

  it('compares deeply, so an equal object is a no-op and a changed one is not', async () => {
    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [{ field: 'shape', before: { a: [1, 2] }, after: { a: [1, 2] } }],
      }),
    )
    expect(await rows()).toHaveLength(0)

    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [{ field: 'shape', before: { a: [1, 2] }, after: { a: [1, 3] } }],
      }),
    )
    expect(await rows()).toHaveLength(1)
  })

  it('keeps the two nulls distinct: unset-before is not the same fact as cleared-after', async () => {
    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [{ field: 'prompt', before: null, after: 'first ever' }],
      }),
    )
    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [{ field: 'prompt', before: 'first ever', after: null }],
      }),
    )

    const { rows: history } = await ownerPool.query<Row>(
      `select field, before_value, after_value from change_log
        where workspace_id = $1 order by id`,
      [workspaceId],
    )
    expect(history[0]).toMatchObject({ before_value: null, after_value: 'first ever' })
    expect(history[1]).toMatchObject({ before_value: 'first ever', after_value: null })
  })

  it('treats an undefined value as null rather than dropping the column', async () => {
    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [
          { field: 'prompt', before: undefined, after: 'set' },
          { field: 'is_provisioned', before: undefined, after: undefined },
        ],
      }),
    )
    const written = await rows()
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ field: 'prompt', before_value: null, after_value: 'set' })
  })

  it('refuses an actor that is not a real agent — attribution is enforced by the FK', async () => {
    await expect(
      withWorkspace(workspaceId, (tx) =>
        appendChangeLog(tx, {
          workspaceId,
          entityType: 'bot_config',
          entityId: workspaceId,
          actorId: randomUUID(),
          changes: [{ field: 'prompt', before: null, after: 'x' }],
        }),
      ),
    ).rejects.toThrow(/foreign key|violates/i)
    expect(await rows()).toHaveLength(0)
  })

  it('reads back newest-first for one entity, and never across the tenant boundary', async () => {
    for (const [before, after] of [[null, 'one'], ['one', 'two']] as const) {
      await withWorkspace(workspaceId, (tx) =>
        appendChangeLog(tx, {
          workspaceId,
          entityType: 'bot_config',
          entityId: workspaceId,
          actorId,
          changes: [{ field: 'prompt', before, after }],
        }),
      )
    }
    await withWorkspace(otherWorkspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId: otherWorkspaceId,
        entityType: 'bot_config',
        entityId: otherWorkspaceId,
        actorId,
        changes: [{ field: 'prompt', before: null, after: 'theirs' }],
      }),
    )

    const visible = await withWorkspace(workspaceId, async (tx) => {
      const result = await tx.execute(
        `select after_value from change_log
          where entity_type = 'bot_config' and entity_id = '${workspaceId}'
          order by changed_at desc, id desc`,
      )
      return result.rows as Array<{ after_value: unknown }>
    })
    expect(visible.map((r) => r.after_value)).toEqual(['two', 'one'])
  })
})

describe('the change_log CHECK constraint', () => {
  let app: Client

  // beforeAll, not beforeEach: a new Client per test would leak connections,
  // because a single afterAll can only end the last one.
  beforeAll(async () => {
    app = new Client({ connectionString: getEnv().DATABASE_URL })
    await app.connect()
  })

  afterAll(async () => {
    await app.end()
  })

  it('refuses a no-op row inserted directly, so a bug in the writer cannot pollute the trail', async () => {
    await app.query('begin')
    await app.query(`select set_config('app.workspace_id', $1, true)`, [workspaceId])
    await expect(
      app.query(
        `insert into change_log (workspace_id, entity_type, entity_id, field, before_value, after_value, actor_id)
         values ($1, 'bot_config', $1, 'prompt', '"same"'::jsonb, '"same"'::jsonb, $2)`,
        [workspaceId, actorId],
      ),
    ).rejects.toThrow(/change_log_value_changed|check constraint/i)
    await app.query('rollback')
  })
})
```

Note on the raw `tx.execute` in the newest-first test: the workspace id is interpolated rather than bound because Drizzle's `execute` takes a plain string here. It is a UUID that `withWorkspace` has already validated, so it is not an injection surface — but if you prefer, use `sql` from `drizzle-orm` with a template literal so it parameterises properly.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @support/backend exec vitest run tests/changeLog.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/changeLog/appendChangeLog.ts'`.

- [ ] **Step 4: Create `backend/src/shared/changeLog/appendChangeLog.ts`**

```ts
import { isDeepStrictEqual } from 'node:util'
import type { Tx } from '../db/withWorkspace.ts'
import { changeLog } from '../db/schema/index.ts'

export type ChangeLogChange = {
  /** The COLUMN name, not the API field name. */
  field: string
  before: unknown
  after: unknown
}

export type ChangeLogInput = {
  workspaceId: string
  entityType: string
  /** The audited row's uuid pk. For bot_config that is the workspace id itself. */
  entityId: string
  /** The authenticated agent. There is no system or bot actor. */
  actorId: string
  changes: readonly ChangeLogChange[]
}

/**
 * jsonb has no `undefined`. Normalising here means a caller passing `undefined`
 * gets an explicit SQL NULL rather than Drizzle omitting the column and the
 * insert falling back to a default — and it makes the no-op comparison below
 * treat `undefined` and `null` as the same absence, which they are.
 */
function normalise(value: unknown): unknown {
  return value === undefined ? null : value
}

/**
 * The single choke point for the audit trail, mirroring `appendEvent`.
 * Never insert into `change_log` directly.
 *
 * One row per genuinely changed field: a save that edits the prompt and flips
 * is_provisioned writes two rows, and both carry the same actor and the same
 * `changed_at`, because `now()` is transaction start time in Postgres.
 *
 * No-ops are dropped here, deeply compared, so the table's CHECK constraint is a
 * backstop against a bug in this function rather than a routine error path. A
 * changes array that is entirely no-ops writes nothing and does not fail.
 *
 * Call this inside the same transaction as the mutation it audits, so a config
 * change that leaves no audit row is impossible rather than merely unlikely.
 */
export async function appendChangeLog(tx: Tx, input: ChangeLogInput): Promise<void> {
  const changed = input.changes
    .map((change) => ({
      field: change.field,
      before: normalise(change.before),
      after: normalise(change.after),
    }))
    .filter((change) => !isDeepStrictEqual(change.before, change.after))

  if (changed.length === 0) return

  await tx.insert(changeLog).values(
    changed.map((change) => ({
      workspaceId: input.workspaceId,
      entityType: input.entityType,
      entityId: input.entityId,
      field: change.field,
      beforeValue: change.before,
      afterValue: change.after,
      actorId: input.actorId,
    })),
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @support/backend exec vitest run tests/changeLog.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add backend/src/shared/changeLog/appendChangeLog.ts backend/tests/changeLog.test.ts backend/tests/helpers/db.ts
git commit -m "feat(audit): add appendChangeLog, the single change_log writer"
```

---

### Task 5: `resolveBotConfig`

**Files:**
- Create: `backend/src/domain/bot/botConfig.ts`
- Modify: `backend/src/domain/bot/index.ts`
- Test: `backend/tests/bot.config.test.ts`

**Interfaces:**
- Consumes: `Tx`, `botConfig` from the schema barrel, `DEFAULT_BOT_PROMPT` from `./defaultPrompt.ts`.
- Produces:
  ```ts
  export type ResolvedBotConfig = { isProvisioned: boolean; prompt: string }
  export async function resolveBotConfig(tx: Tx, workspaceId: string): Promise<ResolvedBotConfig>
  ```
  `prompt` is never null. Task 6 reuses `ResolvedBotConfig` as `saveBotConfig`'s return type.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/bot.config.test.ts`. Widen the existing `vitest` import to `import { afterAll, beforeEach, describe, expect, it } from 'vitest'` — do not add a second import line from the same module — and add:

```ts
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { resolveBotConfig } from '../src/domain/bot/botConfig.ts'
import { closeOwnerPool, ownerPool, seedBotConfig, seedWorkspace, truncateAll } from './helpers/db.ts'
```

Then append this block. The teardown lives at **file top level**, not inside the `describe` — a describe-scoped `afterAll` closes the pools as soon as that block finishes, and Task 6 appends a second `describe` that still needs them:

```ts
afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

describe('resolveBotConfig', () => {
  let workspaceId: string

  beforeEach(async () => {
    await truncateAll()
    workspaceId = await seedWorkspace()
  })

  it('resolves an absent row to off, with the default prompt', async () => {
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(resolved).toEqual({ isProvisioned: false, prompt: DEFAULT_BOT_PROMPT })
  })

  it('resolves a row with a null prompt to the default prompt', async () => {
    await seedBotConfig({ workspaceId, isProvisioned: true, prompt: null })
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(resolved).toEqual({ isProvisioned: true, prompt: DEFAULT_BOT_PROMPT })
  })

  it('returns a stored prompt verbatim', async () => {
    await seedBotConfig({ workspaceId, isProvisioned: true, prompt: '  keep my leading spaces  ' })
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(resolved.prompt).toBe('  keep my leading spaces  ')
  })

  it('cannot tell an absent row from is_provisioned = false — one resolver, one answer', async () => {
    const absent = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    await seedBotConfig({ workspaceId, isProvisioned: false, prompt: null })
    const present = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(present).toEqual(absent)
  })

  it('never leaks another workspace config', async () => {
    const otherWorkspaceId = await seedWorkspace()
    await seedBotConfig({ workspaceId: otherWorkspaceId, isProvisioned: true, prompt: 'theirs' })
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId))
    expect(resolved).toEqual({ isProvisioned: false, prompt: DEFAULT_BOT_PROMPT })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/backend exec vitest run tests/bot.config.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/bot/botConfig.ts'`.

- [ ] **Step 3: Create `backend/src/domain/bot/botConfig.ts`**

```ts
import { eq } from 'drizzle-orm'
import type { Tx } from '../../shared/db/withWorkspace.ts'
import { botConfig } from '../../shared/db/schema/index.ts'
import { DEFAULT_BOT_PROMPT } from './defaultPrompt.ts'

/** `prompt` is never null: the resolver has already substituted the default. */
export type ResolvedBotConfig = {
  isProvisioned: boolean
  prompt: string
}

/**
 * The one place three different "the bot is off" shapes collapse into one answer:
 * no row at all, `is_provisioned = false`, and `prompt IS NULL`. Every caller
 * goes through here, so an absent row and an explicit false can never diverge —
 * and no caller ever has to know which of the three it hit, or handle a null
 * prompt.
 *
 * `is_provisioned = false` means every message on this workspace takes the same
 * fallback path as "bot disabled": no bot reply, straight to the human queue.
 *
 * The explicit workspace predicate is belt-and-braces on top of RLS, matching
 * the codebase rule that scoped reads name their workspace.
 */
export async function resolveBotConfig(tx: Tx, workspaceId: string): Promise<ResolvedBotConfig> {
  const [row] = await tx
    .select({ isProvisioned: botConfig.isProvisioned, prompt: botConfig.prompt })
    .from(botConfig)
    .where(eq(botConfig.workspaceId, workspaceId))
    .limit(1)

  if (!row) return { isProvisioned: false, prompt: DEFAULT_BOT_PROMPT }
  return { isProvisioned: row.isProvisioned, prompt: row.prompt ?? DEFAULT_BOT_PROMPT }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @support/backend exec vitest run tests/bot.config.test.ts`
Expected: PASS, 8 tests (3 from Task 3, 5 new).

- [ ] **Step 5: Add to the barrel**

`backend/src/domain/bot/index.ts`:

```ts
export * from './defaultPrompt.ts'
export * from './botConfig.ts'
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain/bot/botConfig.ts backend/src/domain/bot/index.ts backend/tests/bot.config.test.ts
git commit -m "feat(bot): add resolveBotConfig collapsing absent row and unprovisioned"
```

---

### Task 6: `saveBotConfig` — the upsert and its audit, in one transaction

**Files:**
- Modify: `backend/src/domain/bot/botConfig.ts`
- Test: `backend/tests/bot.config.test.ts`, `backend/tests/changeLog.test.ts`

**Interfaces:**
- Consumes: `appendChangeLog` / `ChangeLogInput` from `backend/src/shared/changeLog/appendChangeLog.ts`, `resolveBotConfig` / `ResolvedBotConfig` from Task 5.
- Produces:
  ```ts
  export const BOT_CONFIG_ENTITY_TYPE = 'bot_config'
  export class EmptyBotPrompt extends Error {}
  export type BotConfigSave = {
    workspaceId: string
    actorId: string
    isProvisioned?: boolean
    prompt?: string | null
  }
  export async function saveBotConfig(tx: Tx, input: BotConfigSave): Promise<ResolvedBotConfig>
  ```
  `isProvisioned: undefined` and `prompt: undefined` mean "leave this field alone". `prompt: null` is an explicit reset to the default. The later admin-route slice calls this inside `withWorkspace`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/bot.config.test.ts`. Extend the existing imports with `EmptyBotPrompt` and `saveBotConfig` from `../src/domain/bot/botConfig.ts`, and `seedAgent` from `./helpers/db.ts`. Nothing here needs `randomUUID` — the rollback test that does lives in `changeLog.test.ts`, which already imports it.

```ts
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
    expect(first).toEqual({ isProvisioned: true, prompt: 'v1' })

    const second = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, prompt: 'v2' }),
    )
    expect(second).toEqual({ isProvisioned: true, prompt: 'v2' })

    const { rows } = await ownerPool.query(`select count(*)::int as n from bot_config where workspace_id = $1`, [
      workspaceId,
    ])
    expect(rows[0]).toEqual({ n: 1 })
  })

  it('leaves an omitted field alone, and resets prompt to the default on an explicit null', async () => {
    await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, isProvisioned: true, prompt: 'custom' }),
    )

    const provisionOnly = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, isProvisioned: false }),
    )
    expect(provisionOnly).toEqual({ isProvisioned: false, prompt: 'custom' })

    const cleared = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, prompt: null }),
    )
    expect(cleared).toEqual({ isProvisioned: false, prompt: DEFAULT_BOT_PROMPT })

    const { rows } = await ownerPool.query(`select prompt from bot_config where workspace_id = $1`, [workspaceId])
    expect(rows[0]).toEqual({ prompt: null }) // NULL is the only "no prompt" representation
  })

  it('rejects an empty or whitespace-only prompt instead of storing one', async () => {
    for (const prompt of ['', '   ', '\n\t']) {
      await expect(
        withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, prompt })),
        `prompt ${JSON.stringify(prompt)}`,
      ).rejects.toThrow(EmptyBotPrompt)
    }
    const { rows } = await ownerPool.query(`select count(*)::int as n from bot_config`)
    expect(rows[0]).toEqual({ n: 0 })
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
```

Append to `backend/tests/changeLog.test.ts` (add `saveBotConfig` from `../src/domain/bot/botConfig.ts` and `DEFAULT_BOT_PROMPT` from `../src/domain/bot/defaultPrompt.ts` to the imports):

```ts
describe('saveBotConfig writes its own audit trail', () => {
  it('writes exactly one row per changed column, named for the column', async () => {
    await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, isProvisioned: true, prompt: 'be helpful' }),
    )
    const written = await rows()
    expect(written.map((r) => r.field)).toEqual(['is_provisioned', 'prompt'])
    expect(written.map((r) => r.before_value)).toEqual([false, null])
    expect(written.map((r) => r.after_value)).toEqual([true, 'be helpful'])
    expect(written.every((r) => r.actor_id === actorId)).toBe(true)
    expect(written.every((r) => r.entity_id === workspaceId)).toBe(true)
    expect(written[0]?.changed_at.getTime()).toBe(written[1]?.changed_at.getTime())
  })

  it('writes nothing when a save changes nothing observable', async () => {
    // First save with both fields at their resolved defaults: the row is created,
    // but an absent row already resolved identically, so nothing changed.
    await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, isProvisioned: false, prompt: null }),
    )
    expect(await rows()).toHaveLength(0)

    await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, prompt: 'set it' }),
    )
    expect(await rows()).toHaveLength(1)

    // Re-saving the same value is a no-op, not a duplicate audit row.
    await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, prompt: 'set it' }),
    )
    expect(await rows()).toHaveLength(1)
  })

  it('rolls the config change back when the audit write fails — no unaudited edit can commit', async () => {
    await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, isProvisioned: false, prompt: 'original' }),
    )

    // A real FK violation inside the real transaction. Not a mock: the invariant
    // is that Postgres rolls the upsert back, and only Postgres can prove that.
    const ghostAgent = randomUUID()
    await expect(
      withWorkspace(workspaceId, (tx) =>
        saveBotConfig(tx, { workspaceId, actorId: ghostAgent, isProvisioned: true, prompt: 'tampered' }),
      ),
    ).rejects.toThrow(/foreign key|violates/i)

    const { rows: config } = await ownerPool.query<{ is_provisioned: boolean; prompt: string | null }>(
      `select is_provisioned, prompt from bot_config where workspace_id = $1`,
      [workspaceId],
    )
    expect(config[0]).toEqual({ is_provisioned: false, prompt: 'original' })
    expect((await rows()).map((r) => r.after_value)).toEqual(['original'])
  })

  it('stores the prompt before-value in full, so "what did it say before" is answerable', async () => {
    const long = 'x'.repeat(4000)
    await withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, prompt: long }))
    await withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, prompt: 'short' }))

    const { rows: history } = await ownerPool.query<{ before_value: unknown; after_value: unknown }>(
      `select before_value, after_value from change_log
        where workspace_id = $1 and field = 'prompt' order by id desc limit 1`,
      [workspaceId],
    )
    expect(history[0]?.before_value).toBe(long)
    expect(history[0]?.after_value).toBe('short')
  })

  it('never writes an event for a config change — two audit homes diverge', async () => {
    await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, isProvisioned: true, prompt: 'p' }),
    )
    const { rows: events } = await ownerPool.query(`select count(*)::int as n from event`)
    expect(events[0]).toEqual({ n: 0 })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @support/backend exec vitest run tests/bot.config.test.ts tests/changeLog.test.ts`
Expected: FAIL — `saveBotConfig` and `EmptyBotPrompt` are not exported from `botConfig.ts`.

- [ ] **Step 3: Extend `backend/src/domain/bot/botConfig.ts`**

Add these imports to the existing ones at the top of the file:

```ts
import { appendChangeLog } from '../../shared/changeLog/appendChangeLog.ts'
```

Then append:

```ts
/** The `change_log.entity_type` this slice writes. The only one, for now. */
export const BOT_CONFIG_ENTITY_TYPE = 'bot_config'

/**
 * Thrown rather than stored. An empty or whitespace-only prompt would be a second
 * representation of "no prompt" alongside NULL, and the resolver would have to
 * guess. Clearing a prompt is `prompt: null`, explicitly.
 */
export class EmptyBotPrompt extends Error {
  constructor() {
    super('Bot prompt cannot be empty — pass null to reset it to the default')
    this.name = 'EmptyBotPrompt'
  }
}

export type BotConfigSave = {
  workspaceId: string
  /** The authenticated agent. Attribution is not optional. */
  actorId: string
  /** Omitted means leave alone. */
  isProvisioned?: boolean
  /** Omitted means leave alone; explicit null is a reset to DEFAULT_BOT_PROMPT. */
  prompt?: string | null
}

/**
 * The only way `bot_config` is written. The upsert and its audit rows land in the
 * caller's single transaction, so a config change that leaves no audit row is
 * impossible, and a failed audit write rolls the config change back.
 *
 * Audited field names are the COLUMN names, so the trail stays readable against
 * the schema when an API shape changes.
 *
 * A first save that sets both fields to their already-resolved defaults writes no
 * audit row: an absent row and `{ false, null }` resolve identically, so nothing
 * observable changed. The row still gets created.
 */
export async function saveBotConfig(tx: Tx, input: BotConfigSave): Promise<ResolvedBotConfig> {
  if (typeof input.prompt === 'string' && input.prompt.trim() === '') {
    throw new EmptyBotPrompt()
  }

  const [existing] = await tx
    .select({ isProvisioned: botConfig.isProvisioned, prompt: botConfig.prompt })
    .from(botConfig)
    .where(eq(botConfig.workspaceId, input.workspaceId))
    .limit(1)

  // An absent row means the same thing as { false, null } — the same collapse
  // resolveBotConfig performs — so a first save's before-values are those, not
  // "unknown".
  const beforeProvisioned = existing?.isProvisioned ?? false
  const beforePrompt = existing?.prompt ?? null

  const afterProvisioned = input.isProvisioned ?? beforeProvisioned
  const afterPrompt = input.prompt === undefined ? beforePrompt : input.prompt

  await tx
    .insert(botConfig)
    .values({
      workspaceId: input.workspaceId,
      isProvisioned: afterProvisioned,
      prompt: afterPrompt,
    })
    .onConflictDoUpdate({
      target: botConfig.workspaceId,
      set: {
        isProvisioned: afterProvisioned,
        prompt: afterPrompt,
        // Explicit, because there is no trigger — see the schema comment.
        updatedAt: new Date(),
      },
    })

  await appendChangeLog(tx, {
    workspaceId: input.workspaceId,
    entityType: BOT_CONFIG_ENTITY_TYPE,
    entityId: input.workspaceId,
    actorId: input.actorId,
    changes: [
      { field: 'is_provisioned', before: beforeProvisioned, after: afterProvisioned },
      { field: 'prompt', before: beforePrompt, after: afterPrompt },
    ],
  })

  return {
    isProvisioned: afterProvisioned,
    prompt: afterPrompt ?? DEFAULT_BOT_PROMPT,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @support/backend exec vitest run tests/bot.config.test.ts tests/changeLog.test.ts`
Expected: PASS — 12 in `bot.config.test.ts`, 14 in `changeLog.test.ts`.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: clean typecheck, whole suite green. If `schema.test.ts` or `rls.test.ts` fail on a table count, a fixture list was missed in Task 1 or 2 — fix it there, don't loosen the assertion.

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain/bot/botConfig.ts backend/tests/bot.config.test.ts backend/tests/changeLog.test.ts
git commit -m "feat(bot): add saveBotConfig upserting and auditing in one transaction"
```

---

## Where each of the spec's verification bullets landed

The spec lists its assertions under test-file headings. Two of them are implemented in
`rls.test.ts` instead, following the precedent that grant and policy probes for the `event` spine
already live there with the `support_app` connection those probes need. Nothing is dropped:

| Spec bullet | Task | File |
|---|---|---|
| `bot_config` PK is `workspace_id`, no `id` column | 1 | `schema.test.ts` |
| The `CHECK` exists and is a real backstop | 1, 4 | `schema.test.ts` (definition), `changeLog.test.ts` (direct insert refused) |
| Composite index + BRIN on `change_log` | 1 | `schema.test.ts` |
| `change_log` append-only: `UPDATE`/`DELETE` refused | 2 | `rls.test.ts` — *spec filed this under `changeLog.test.ts`* |
| Tenancy: no cross-workspace audit reads | 2, 4 | `rls.test.ts` and `changeLog.test.ts` — *spec filed this under `changeLog.test.ts` only* |
| No-ops dropped; mixed array writes only real changes | 4 | `changeLog.test.ts` |
| Null semantics: first-set vs. cleared, never confused | 4 | `changeLog.test.ts` |
| Attribution: `actor_id` is the agent; ghost agent refused by FK | 4, 6 | `changeLog.test.ts` |
| Field-level granularity: two rows, one actor, one `changed_at` | 6 | `changeLog.test.ts` |
| Atomicity via a real rollback, not a mock | 6 | `changeLog.test.ts` |
| Read path: newest-first for one `(entity_type, entity_id)` | 4 | `changeLog.test.ts` |
| Absent row → `{ false, DEFAULT_BOT_PROMPT }` | 5 | `bot.config.test.ts` |
| `prompt IS NULL` → default; stored prompt verbatim | 5 | `bot.config.test.ts` |
| `ON CONFLICT DO UPDATE` upserts on second save | 6 | `bot.config.test.ts` |
| `DEFAULT_BOT_PROMPT` has the placeholders, no taxonomy names | 3 | `bot.config.test.ts` |

The spec's read-path bullet offers "assert on the query plan the way the existing index tests do, if
that pattern exists; otherwise assert ordering only." It does not exist — `schema.test.ts` asserts
index *definitions* from `pg_indexes`, never an `EXPLAIN` plan. So Task 1 asserts the index exists
and Task 4 asserts ordering. Do not add a plan assertion; a planner that picks a sequential scan on a
ten-row test table would fail a correct build.

## What this plan deliberately does not do

Named so a reviewer doesn't read them as gaps:

- **No `GET`/`PUT /admin/bot-config` route, no `openapi.ts` entry, no frontend.** The spec puts routes in later slices. `saveBotConfig` takes a `Tx`, so the route slice wraps it in `withWorkspace` and adds the permission check — permission checks run at the API, and there is no API here yet.
- **No forms tables, enums, or `@support/types` additions.** The other half of the same spec.
- **No `REVOKE UPDATE ON form_answer`.** See Global Constraints — it would break `pnpm db:setup` today.
- **No audit read API or admin history screen.** The table, its index and its writer land here; the screen does not.
- **No `entity_type` values beyond `'bot_config'`.** The spec is explicit: do not add values for writers that do not exist.
- **No `rule` / `rule_firing`,** so the committed spec's "the bot cannot be provisioned with an empty rule set" invariant still cannot be enforced. Recorded, not implemented — `saveBotConfig` will happily set `is_provisioned = true` with no rules.
- **No seed change.** No row exists until an admin first saves, and the resolver means a workspace created by any path is already in the correct off state.
- **No `docs/decisions/spec-contradictions.md` edit** — §15 already records the `bot_config` shape deviation.
