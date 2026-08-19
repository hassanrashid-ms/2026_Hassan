# Forms Slice 1 — Data Model and Seeded Forms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the forms half of the 2026-08-11 data-model spec — four tables, two enums, the `subintent.form_id` composite FK, the `conversation` composite-FK parent key and the `form_answer` append-only revoke — plus the one read helper and three seeded, published forms mapped to seeded subintents, so that `pnpm db:setup && pnpm db:seed` yields subintents that resolve to a published form.

**Architecture:** One new Drizzle schema file (`schema/forms.ts`) holding all four tables, two additions to `schema/enums.ts`, two deltas to existing tables (`subintent`, `conversation`), one committed migration whose statement order is hand-verified against the inherited spec's migration steps, one revoke in `002_rls.sql`, one shared-types module (`packages/types/src/forms.ts`) that owns the field and answer-value contracts, one domain read helper (`resolveSubintentForm`) that is the single place anything asks "is there a form here", and one seed module (`seedForms.ts`) beside `seedTaxonomy.ts`.

**Tech Stack:** TypeScript (native `.ts` ESM imports, extensions included), Drizzle ORM + `drizzle-kit generate` (committed SQL migrations applied by drizzle-orm's migrator — **not** `drizzle-kit push`), PostgreSQL 17, Zod 4, Vitest.

**Source specs:**
- `docs/specs/2026-08-17-player-side-forms-design.md` (Approved) — **slice 1 only**: "Slices", §1.1–§1.7, "Out of scope".
- `docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md` (Accepted) — its forms half is inherited **as written**. Every column, constraint, composite FK, migration step and verification section in it stands.

---

## Global Constraints

- **Slice 1 only.** Do **not** touch `backend/src/domain/bot/applyBotTurn.ts`, do **not** add routes, do **not** register anything in `backend/src/docs/openapi.ts`, do **not** add `'form'` to the `confirm_phase` enum, do **not** write `form_offered` / `form_field_answered` / `form_completed` events, do **not** create `completeFormAndHandoff.ts`, `formTimeout.ts` or any frontend file. Those are slices 2 and 3.
- **The 2026-08-11 spec is not redesigned.** Column names, nullability, defaults, unique keys, composite FKs and `ON DELETE RESTRICT` are copied from it verbatim. Where this plan quotes SQL or TypeScript, that text is the deliverable.
- **Migration ordering is load-bearing.** The inherited spec is emphatic: *"Steps 2–3 must precede the FKs that depend on them."* In order: (1) the two enums, (2) `UNIQUE (workspace_id, id)` on `conversation`, (3) `form` then `form_version`, (4) the composite FK on `subintent.form_id`, (5) `form_submission` then `form_answer`, (8) `002_rls.sql`. Task 2 Step 8 verifies the generated file against this order and reorders it by hand if drizzle emitted it otherwise.
- **This repo does not use `drizzle-kit push`.** `backend/src/shared/db/setup.ts` runs `001_extensions.sql`, then the committed migrations in `backend/drizzle/` via drizzle-orm's migrator, then `002_rls.sql`. The inherited spec's sentence "drizzle-kit push via `pnpm db:setup`" is stale — generate a migration with `pnpm db:generate` and commit it, per `CLAUDE.md`.
- **Composite tenancy FKs on every new scoped→scoped FK**, per `docs/decisions/2026-08-04-composite-foreign-keys-for-tenancy.md`. FKs to `workspace` and `agent` stay single-column — those two tables are unscoped. Handler-side scoped-`SELECT` pre-verification of client-supplied ids remains mandatory everywhere else; do not delete the ADR comments that say so.
- **No hard deletes.** Every FK is `ON DELETE RESTRICT`. `DELETE` is granted on nothing.
- **`form_answer` is append-only, enforced by `REVOKE UPDATE ON form_answer FROM support_app`**, not by convention. A correction is a second row; the newest `created_at` wins on read. There is **no** `REVOKE DELETE` line needed — `DELETE` is absent from every grant already — but revoke it anyway alongside `PUBLIC`, matching the existing `event` and `change_log` blocks.
- **The `form_field_type` enum stays at seven values including `time`.** Removing a value from a shipped enum is a migration for no gain. But: no seeded form uses `time`, and `attachment` stays declared-but-inert.
- **Unanswered means no row.** `form_answer.value` is `NOT NULL`. There is no null-value sentinel and no empty-answer row.
- **`resolveSubintentForm` returns `null`, never throws**, for every failure condition. Same shape as missing player state.
- Imports carry the `.ts` extension (`from './identity.ts'`). Follow the existing schema files exactly.
- Never `console.*`. Use `logger` from `backend/src/shared/logging/logger.ts`.
- All commands run from the repo root: `/Users/hassanrashid/Desktop/git/mindstorm/crm/app`. Postgres and Redis must be up (`docker compose up -d`) for any test that touches the database.
- Commit messages carry **no** `Co-Authored-By` trailer.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/types/src/forms.ts` | create | `FORM_FIELD_TYPES`, `formFieldSchema`, `formFieldsSchema`, `publishedFormFieldsSchema`, `formAnswerValueSchemas` — the one place the field contract lives |
| `packages/types/src/index.ts` | modify | one `export *` line |
| `packages/types/tests/forms.types.test.ts` | create | the inherited spec's `tests/forms.types.test.ts` section |
| `backend/src/shared/db/schema/enums.ts` | modify | `formFieldType`, `formStatus` |
| `backend/src/shared/db/schema/forms.ts` | create | `form`, `formVersion`, `formSubmission`, `formAnswer` |
| `backend/src/shared/db/schema/taxonomy.ts` | modify | `subintent.form_id` gains its composite FK; the stale comment is deleted |
| `backend/src/shared/db/schema/conversations.ts` | modify | `UNIQUE (workspace_id, id)` on `conversation`, additive only |
| `backend/src/shared/db/schema/index.ts` | modify | one `export *` line |
| `backend/drizzle/0004_forms.sql` + `meta/` | create | the committed migration, statement order hand-verified |
| `backend/src/shared/db/sql/002_rls.sql` | modify | the `form_answer` revoke replaces the "cannot be listed here yet" comment |
| `backend/src/domain/forms/resolveSubintentForm.ts` | create | the single "is there a form here" read |
| `backend/src/domain/forms/index.ts` | create | barrel, matching `domain/conversations/index.ts` |
| `backend/src/shared/db/seedForms.ts` | create | `SEED_FORMS` + `seedForms(tx, workspaceId)` |
| `backend/src/shared/db/seed.ts` | modify | calls `seedForms` inside the existing `withWorkspace` block, after the taxonomy loop |
| `backend/tests/helpers/db.ts` | modify | `truncateAll` covers the four new tables; `seedForm` / `seedFormVersion` / `seedFormSubmission` / `seedFormAnswer` helpers |
| `backend/tests/schema.test.ts` | modify | table count 16 → 20, plus structural assertions for the four tables and two deltas |
| `backend/tests/rls.test.ts` | modify | `SCOPED_TABLES` gains four tables; four smuggle probes; the `form_answer` append-only probe |
| `backend/tests/forms.dataModel.test.ts` | create | the inherited spec's `tests/forms.dataModel.test.ts` section |
| `backend/tests/forms.resolve.test.ts` | create | §1.7 of the 2026-08-17 spec |
| `backend/tests/seed.test.ts` | modify | §1.7's seed additions |
| `docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md` | modify | amendment 1 — the premise paragraph gains a pointer |
| `docs/project-overview.md` | modify | amendment 2 — the 2026-08-10 supersession note |
| `docs/decisions/spec-contradictions.md` | modify | amendment 3 — a new entry |

---

### Task 1: The shared field and answer-value contract

`packages/types` has no database dependency, so this task is pure and runs first. Every later task imports `FormField` from it — the Drizzle jsonb column is typed against it, the seed builds arrays of it, and `resolveSubintentForm` returns it.

**Files:**
- Create: `packages/types/src/forms.ts`
- Modify: `packages/types/src/index.ts`
- Test: `packages/types/tests/forms.types.test.ts`

**Interfaces:**
- Consumes: nothing. `zod` v4 is already a dependency of `@support/types`.
- Produces, all exported from `@support/types`:
  - `FORM_FIELD_TYPES: readonly ['short_text','long_text','number','date','time','choice','attachment']`
  - `type FormFieldType = (typeof FORM_FIELD_TYPES)[number]`
  - `formFieldSchema: z.ZodType<FormField>` with fields `key`, `label`, `type`, `isRequired`, `position`, `options?`
  - `type FormField = { key: string; label: string; type: FormFieldType; isRequired: boolean; position: number; options?: string[] }`
  - `formFieldsSchema` — an array of `formFieldSchema` with the three cross-field refinements
  - `publishedFormFieldsSchema` — `formFieldsSchema` plus non-empty
  - `formAnswerValueSchemas: Record<FormFieldType, z.ZodType>`

- [ ] **Step 1: Write the failing test**

Create `packages/types/tests/forms.types.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  FORM_FIELD_TYPES,
  formAnswerValueSchemas,
  formFieldsSchema,
  publishedFormFieldsSchema,
  type FormField,
} from '../src/index.ts'

const field = (over: Partial<FormField> = {}): FormField => ({
  key: 'store',
  label: 'Store',
  type: 'short_text',
  isRequired: true,
  position: 0,
  ...over,
})

describe('FORM_FIELD_TYPES', () => {
  it('is the canonical seven, in the order the pg enum declares them', () => {
    expect(FORM_FIELD_TYPES).toEqual([
      'short_text',
      'long_text',
      'number',
      'date',
      'time',
      'choice',
      'attachment',
    ])
  })
})

describe('formFieldsSchema', () => {
  it('accepts a well-formed array', () => {
    const fields = [field(), field({ key: 'note', type: 'long_text', position: 1, isRequired: false })]
    expect(formFieldsSchema.safeParse(fields).success).toBe(true)
  })

  it('rejects a duplicate key', () => {
    const fields = [field(), field({ position: 1 })]
    expect(formFieldsSchema.safeParse(fields).success).toBe(false)
  })

  it('rejects a duplicate position', () => {
    const fields = [field(), field({ key: 'other' })]
    expect(formFieldsSchema.safeParse(fields).success).toBe(false)
  })

  it('rejects a choice field with no options', () => {
    expect(formFieldsSchema.safeParse([field({ type: 'choice' })]).success).toBe(false)
  })

  it('rejects a non-choice field carrying options', () => {
    expect(formFieldsSchema.safeParse([field({ options: ['a', 'b'] })]).success).toBe(false)
  })

  it('rejects a choice field with fewer than two options', () => {
    expect(formFieldsSchema.safeParse([field({ type: 'choice', options: ['only'] })]).success).toBe(false)
  })

  it('rejects a key that violates the pattern', () => {
    for (const key of ['Store', 'store-id', 'store id', '']) {
      expect(formFieldsSchema.safeParse([field({ key })]).success, key).toBe(false)
    }
  })

  it('allows an empty array — a draft version has no fields yet', () => {
    expect(formFieldsSchema.safeParse([]).success).toBe(true)
  })
})

describe('publishedFormFieldsSchema', () => {
  it('rejects an empty array — a published version with no questions asks nothing', () => {
    expect(publishedFormFieldsSchema.safeParse([]).success).toBe(false)
  })

  it('accepts a non-empty well-formed array', () => {
    expect(publishedFormFieldsSchema.safeParse([field()]).success).toBe(true)
  })
})

describe('formAnswerValueSchemas', () => {
  it('covers every declared field type', () => {
    expect(Object.keys(formAnswerValueSchemas).sort()).toEqual([...FORM_FIELD_TYPES].sort())
  })

  it('bounds short_text at 1..500 and long_text at 1..5000', () => {
    expect(formAnswerValueSchemas.short_text.safeParse('').success).toBe(false)
    expect(formAnswerValueSchemas.short_text.safeParse('a'.repeat(500)).success).toBe(true)
    expect(formAnswerValueSchemas.short_text.safeParse('a'.repeat(501)).success).toBe(false)
    expect(formAnswerValueSchemas.long_text.safeParse('').success).toBe(false)
    expect(formAnswerValueSchemas.long_text.safeParse('a'.repeat(5000)).success).toBe(true)
    expect(formAnswerValueSchemas.long_text.safeParse('a'.repeat(5001)).success).toBe(false)
  })

  it('requires a finite number', () => {
    expect(formAnswerValueSchemas.number.safeParse(0).success).toBe(true)
    expect(formAnswerValueSchemas.number.safeParse(-3.5).success).toBe(true)
    expect(formAnswerValueSchemas.number.safeParse(Number.POSITIVE_INFINITY).success).toBe(false)
    expect(formAnswerValueSchemas.number.safeParse(Number.NaN).success).toBe(false)
    expect(formAnswerValueSchemas.number.safeParse('3').success).toBe(false)
  })

  it('requires YYYY-MM-DD for date and rejects an impossible month', () => {
    expect(formAnswerValueSchemas.date.safeParse('2026-08-17').success).toBe(true)
    expect(formAnswerValueSchemas.date.safeParse('2026-13-01').success).toBe(false)
    expect(formAnswerValueSchemas.date.safeParse('2026-8-17').success).toBe(false)
    expect(formAnswerValueSchemas.date.safeParse('17/08/2026').success).toBe(false)
  })

  it('requires 24-hour HH:mm for time', () => {
    expect(formAnswerValueSchemas.time.safeParse('00:00').success).toBe(true)
    expect(formAnswerValueSchemas.time.safeParse('23:59').success).toBe(true)
    expect(formAnswerValueSchemas.time.safeParse('24:00').success).toBe(false)
    expect(formAnswerValueSchemas.time.safeParse('1:5').success).toBe(false)
  })

  it('validates a choice as a non-empty string — membership is checked against the field, not here', () => {
    expect(formAnswerValueSchemas.choice.safeParse('Other').success).toBe(true)
    expect(formAnswerValueSchemas.choice.safeParse('').success).toBe(false)
    // Membership is not expressible standalone: it depends on that field's options.
    // The guard that resolves the field checks it. Documented here so nobody
    // "fixes" this schema by inventing an options list inside it.
    expect(formAnswerValueSchemas.choice.safeParse('not in the options').success).toBe(true)
  })

  it('requires an attachmentId uuid for attachment, which stays inert until the attachment table exists', () => {
    expect(
      formAnswerValueSchemas.attachment.safeParse({ attachmentId: '11111111-1111-1111-1111-111111111111' })
        .success,
    ).toBe(true)
    expect(formAnswerValueSchemas.attachment.safeParse({ attachmentId: 'nope' }).success).toBe(false)
    expect(formAnswerValueSchemas.attachment.safeParse('11111111-1111-1111-1111-111111111111').success).toBe(
      false,
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/types exec vitest run tests/forms.types.test.ts`
Expected: FAIL — the import from `../src/index.ts` resolves nothing, so every symbol is `undefined`.

- [ ] **Step 3: Write `packages/types/src/forms.ts`**

```ts
import { z } from 'zod'

/**
 * NOT part of the frozen SDK contract in the sdk-wire sense, but the type union
 * IS frozen once for the same reason: a shipped client parses it. `attachment`
 * is declared now and inert until the `attachment` table exists — the submission
 * service rejects it as unsupported, and the form-builder must not offer it.
 * `time` is likewise declared and unused: no seeded form uses it, and removing a
 * value from a shipped pg enum is a migration for no gain.
 *
 * This array is the canonical list. `schema/enums.ts`'s `form_field_type` mirrors
 * it in the same order, and `tests/schema.test.ts` asserts the two match, so they
 * cannot drift.
 */
export const FORM_FIELD_TYPES = [
  'short_text',
  'long_text',
  'number',
  'date',
  'time',
  'choice',
  'attachment',
] as const
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number]

/**
 * One question. `key` is a stable string that survives reordering and
 * relabelling without touching a single answer row — which is the whole reason
 * fields are jsonb here rather than a `form_field` table (spec-contradictions
 * §14). `position` is the render order and is snapshotted into events later, so
 * it must be present and unique.
 *
 * `isRequired` is SOFT everywhere. Nothing about a form may block a player
 * reaching a human, so a required field left blank still lands.
 */
export const formFieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'A field key is lower-case letters, digits and underscores only.'),
  label: z.string().min(1).max(200),
  type: z.enum(FORM_FIELD_TYPES),
  isRequired: z.boolean(),
  position: z.number().int().nonnegative(),
  options: z.array(z.string().min(1)).min(2).optional(),
})
export type FormField = z.infer<typeof formFieldSchema>

/**
 * The cross-field rules a single field cannot express. Nothing at the database
 * layer enforces these — `fields` is jsonb — so this schema is the enforcement
 * point, and every writer of a `form_version` must run it.
 *
 * An EMPTY array is accepted here: `form_version.fields` defaults to `[]` and a
 * draft legitimately has no questions yet. The non-empty rule belongs to
 * publishing, so it lives on `publishedFormFieldsSchema` below.
 */
export const formFieldsSchema = z.array(formFieldSchema).superRefine((fields, ctx) => {
  const seenKeys = new Set<string>()
  const seenPositions = new Set<number>()
  fields.forEach((field, i) => {
    if (seenKeys.has(field.key)) {
      ctx.addIssue({ code: 'custom', path: [i, 'key'], message: `Duplicate field key "${field.key}".` })
    }
    seenKeys.add(field.key)

    if (seenPositions.has(field.position)) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'position'],
        message: `Duplicate field position ${field.position}.`,
      })
    }
    seenPositions.add(field.position)

    if (field.type === 'choice' && field.options === undefined) {
      ctx.addIssue({ code: 'custom', path: [i, 'options'], message: 'A choice field needs options.' })
    }
    if (field.type !== 'choice' && field.options !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'options'],
        message: `A ${field.type} field must not carry options.`,
      })
    }
  })
})

/** The publish-time rule: a version with no questions asks nothing. */
export const publishedFormFieldsSchema = formFieldsSchema.refine((fields) => fields.length > 0, {
  message: 'A published form version must have at least one field.',
})

/**
 * The `form_answer.value` jsonb shape, keyed by the field's declared type.
 *
 * `choice` membership cannot be expressed standalone — it depends on that
 * field's `options` — so it is checked in the same guard that resolves the
 * field, never here. Do not "fix" that by baking an options list in.
 */
export const formAnswerValueSchemas = {
  short_text: z.string().min(1).max(500),
  long_text: z.string().min(1).max(5000),
  number: z.number().finite(),
  date: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  choice: z.string().min(1),
  attachment: z.object({ attachmentId: z.uuid() }),
} satisfies Record<FormFieldType, z.ZodType>
```

- [ ] **Step 4: Export it from the barrel**

In `packages/types/src/index.ts`, append one line after `export * from './agent-context.ts'`:

```ts
export * from './forms.ts'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @support/types exec vitest run tests/forms.types.test.ts`
Expected: PASS, all cases.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/forms.ts packages/types/src/index.ts packages/types/tests/forms.types.test.ts
git commit -m "feat(types): form field and answer-value contracts"
```

---

### Task 2: The schema — two enums, four tables, two deltas, one migration

**This is the task where migration ordering matters.** The inherited spec's steps 2–3 (`conversation UNIQUE`, then `form` + `form_version`) must precede the FKs that depend on them. Step 8 below is the check that this actually happened in the emitted SQL.

**Files:**
- Modify: `backend/src/shared/db/schema/enums.ts`
- Create: `backend/src/shared/db/schema/forms.ts`
- Modify: `backend/src/shared/db/schema/taxonomy.ts`
- Modify: `backend/src/shared/db/schema/conversations.ts`
- Modify: `backend/src/shared/db/schema/index.ts`
- Create: `backend/drizzle/0004_forms.sql` (+ generated `meta/0004_snapshot.json` and a `_journal.json` entry)
- Modify: `backend/src/shared/db/sql/002_rls.sql`
- Modify: `backend/tests/helpers/db.ts`
- Test: `backend/tests/schema.test.ts`

**Interfaces:**
- Consumes: `FormField` from `@support/types` (Task 1); `workspace`, `agent` from `./identity.ts`; `conversation` from `./conversations.ts`; `formFieldType`, `formStatus` from `./enums.ts`.
- Produces, all exported from `backend/src/shared/db/schema/index.ts`:
  - `formFieldType`, `formStatus` — pg enums.
  - `form` with `.id`, `.workspaceId`, `.name`, `.createdBy`, `.archivedAt`, `.createdAt`.
  - `formVersion` with `.id`, `.workspaceId`, `.formId`, `.version`, `.fields` (typed `FormField[]`), `.publishedAt`, `.publishedBy`, `.createdAt`.
  - `formSubmission` with `.id`, `.workspaceId`, `.conversationId`, `.formId`, `.formVersion`, `.status`, `.startedAt`, `.submittedAt`.
  - `formAnswer` with `.id`, `.workspaceId`, `.formSubmissionId`, `.fieldKey`, `.fieldType`, `.value`, `.createdAt`.
  - `subintent` gains the composite FK `subintent_form_fk`; `conversation` gains `conversation_workspace_id_uk`.
- Test helpers produced for Tasks 3–5: `seedForm`, `seedFormVersion`, `seedFormSubmission`, `seedFormAnswer` in `backend/tests/helpers/db.ts`.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/schema.test.ts`, add the four tables to `EXPECTED_TABLES` in alphabetical position (between `'event'` and `'intent'`) and correct the count in the first test's title:

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
  'form',
  'form_answer',
  'form_submission',
  'form_version',
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
  it('creates exactly the twenty tables of the SDK-path + articles-KB + bot-config + forms subset', async () => {
```

Then append these tests inside the same `describe('schema', …)` block. Add this import at the top of the file:

```ts
import { FORM_FIELD_TYPES } from '@support/types'
```

```ts
  it('declares form_field_type in the same order as FORM_FIELD_TYPES, and form_status with four values', async () => {
    const { rows } = await ownerPool.query<{ typname: string; labels: string[] }>(
      `select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
         from pg_type t join pg_enum e on e.enumtypid = t.oid
        where t.typname in ('form_field_type', 'form_status')
        group by t.typname`,
    )
    const byName = new Map(rows.map((r) => [r.typname, r.labels]))
    expect(byName.get('form_field_type')).toEqual([...FORM_FIELD_TYPES])
    expect(byName.get('form_status')).toEqual(['in_progress', 'completed', 'partial', 'skipped'])
  })

  it('gives form a nullable created_by and archived_at, and both of its unique keys', async () => {
    const cols = await columns('form')
    expect(cols.get('name')?.nullable).toBe(false)
    expect(cols.get('created_by')?.nullable).toBe(true)
    expect(cols.get('archived_at')?.nullable).toBe(true)
    expect(cols.get('created_at')?.nullable).toBe(false)

    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'form'`,
    )
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/UNIQUE.*\(workspace_id, name\)/)
    expect(defs).toMatch(/UNIQUE.*\(workspace_id, id\)/)
  })

  it('stores form_version fields as jsonb defaulting to an empty array, with a nullable published_at', async () => {
    const cols = await columns('form_version')
    expect(cols.get('fields')?.type).toBe('jsonb')
    expect(cols.get('fields')?.nullable).toBe(false)
    expect(cols.get('fields')?.hasDefault).toBe(true)
    expect(cols.get('version')?.nullable).toBe(false)
    expect(cols.get('published_at')?.nullable).toBe(true)
    expect(cols.get('published_by')?.nullable).toBe(true)

    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'form_version'`,
    )
    expect(rows.map((r) => r.indexdef).join('\n')).toMatch(/UNIQUE.*\(form_id, version\)/)
  })

  it('snapshots form_version as a plain int on form_submission and offers a form once per conversation', async () => {
    const cols = await columns('form_submission')
    expect(cols.get('form_version')?.type).toBe('integer')
    expect(cols.get('form_version')?.nullable).toBe(false)
    expect(cols.get('status')?.nullable).toBe(false)
    expect(cols.get('status')?.hasDefault).toBe(true)
    expect(cols.get('started_at')?.nullable).toBe(false)
    expect(cols.get('submitted_at')?.nullable).toBe(true)

    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'form_submission'`,
    )
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/UNIQUE.*\(conversation_id, form_id\)/)
    expect(defs).toMatch(/UNIQUE.*\(workspace_id, id\)/)
  })

  it('gives form_answer a NOT NULL value, a snapshotted field_type, and the newest-wins read index', async () => {
    const cols = await columns('form_answer')
    expect(cols.get('field_key')?.nullable).toBe(false)
    expect(cols.get('field_type')?.nullable).toBe(false)
    expect(cols.get('value')?.type).toBe('jsonb')
    // Unanswered is the ABSENCE of a row. There is no null value and no
    // empty-answer sentinel, so "what is missing" stays derivable.
    expect(cols.get('value')?.nullable).toBe(false)

    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'form_answer'`,
    )
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/\(form_submission_id, field_key, created_at\)/)
    // Multiple rows per field IS the correction mechanism, not an error.
    expect(defs).not.toMatch(/UNIQUE.*\(form_submission_id, field_key\)/)
  })

  it('carries a composite tenancy FK on every new scoped-to-scoped edge, all ON DELETE RESTRICT', async () => {
    const { rows } = await ownerPool.query<{ conname: string; def: string }>(
      `select c.conname, pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where c.contype = 'f'
          and (t.relname in ('form', 'form_version', 'form_submission', 'form_answer')
               or c.conname = 'subintent_form_fk')`,
    )
    const byName = new Map(rows.map((r) => [r.conname, r.def]))
    for (const [name, def] of byName) expect(def, name).toMatch(/ON DELETE RESTRICT/)

    const composite = (def: string | undefined) => def !== undefined && /FOREIGN KEY \([^)]*workspace_id/.test(def)
    expect(composite(byName.get('form_version_form_fk'))).toBe(true)
    expect(composite(byName.get('form_submission_conversation_fk'))).toBe(true)
    expect(composite(byName.get('form_submission_form_fk'))).toBe(true)
    expect(composite(byName.get('form_answer_submission_fk'))).toBe(true)
    expect(composite(byName.get('subintent_form_fk'))).toBe(true)

    // The version-snapshot FK is deliberately (form_id, form_version) — it makes
    // the snapshot an enforced fact, not a resolvable convention. It needs no
    // workspace_id because form_id already carries one via the composite FK above.
    // pg_get_constraintdef emits unqualified, space-separated column lists.
    const versionFk = byName.get('form_submission_version_fk')
    expect(versionFk).toMatch(/FOREIGN KEY \(form_id, form_version\)/)
    expect(versionFk).toMatch(/REFERENCES form_version\(form_id, "?version"?\)/)
  })

  it('gives conversation the composite-FK parent key form_submission needs', async () => {
    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'conversation'`,
    )
    expect(rows.map((r) => r.indexdef).join('\n')).toMatch(/UNIQUE.*\(workspace_id, id\)/)
  })
```

Also extend `SCOPED_TABLES` in `backend/tests/helpers/db.ts` so `truncateAll` clears the new tables — children before parents, matching the existing ordering convention:

```ts
const SCOPED_TABLES = [
  'form_answer',
  'form_submission',
  'form_version',
  'form',
  'change_log',
  'bot_config',
  'event',
  'message',
  'conversation',
  'subintent',
  'intent',
  'player_state_snapshot',
  'declared_field',
  'session',
  'player',
  'workspace_member',
  'agent',
  'workspace',
]
```

And append these helpers to the end of `backend/tests/helpers/db.ts`:

```ts
export async function seedForm(args: {
  workspaceId: string
  name?: string
  archivedAt?: Date | null
}): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(
    `insert into form (id, workspace_id, name, archived_at) values ($1, $2, $3, $4)`,
    [id, args.workspaceId, args.name ?? `Form ${randomUUID().slice(0, 8)}`, args.archivedAt ?? null],
  )
  return id
}

export async function seedFormVersion(args: {
  workspaceId: string
  formId: string
  version?: number
  fields?: unknown[]
  publishedAt?: Date | null
}): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(
    `insert into form_version (id, workspace_id, form_id, version, fields, published_at)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      id,
      args.workspaceId,
      args.formId,
      args.version ?? 1,
      JSON.stringify(args.fields ?? []),
      args.publishedAt ?? null,
    ],
  )
  return id
}

export async function seedFormSubmission(args: {
  workspaceId: string
  conversationId: string
  formId: string
  formVersion?: number
  status?: 'in_progress' | 'completed' | 'partial' | 'skipped'
  startedAt?: Date
}): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(
    `insert into form_submission (id, workspace_id, conversation_id, form_id, form_version, status, started_at)
     values ($1, $2, $3, $4, $5, $6, coalesce($7, now()))`,
    [
      id,
      args.workspaceId,
      args.conversationId,
      args.formId,
      args.formVersion ?? 1,
      args.status ?? 'in_progress',
      args.startedAt ?? null,
    ],
  )
  return id
}

export async function seedFormAnswer(args: {
  workspaceId: string
  formSubmissionId: string
  fieldKey: string
  fieldType?: string
  value?: unknown
  createdAt?: Date
}): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(
    `insert into form_answer (id, workspace_id, form_submission_id, field_key, field_type, value, created_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, coalesce($7, now()))`,
    [
      id,
      args.workspaceId,
      args.formSubmissionId,
      args.fieldKey,
      args.fieldType ?? 'short_text',
      JSON.stringify(args.value ?? 'answer'),
      args.createdAt ?? null,
    ],
  )
  return id
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @support/api exec vitest run tests/schema.test.ts`
Expected: FAIL — the table-list assertion reports the four `form*` tables missing, the new tests fail on empty column maps, and `truncateAll` throws `relation "form_answer" does not exist`.

- [ ] **Step 3: Add the two enums**

In `backend/src/shared/db/schema/enums.ts`, append after the `resolutionSource` line:

```ts
/**
 * Seven declared, six usable. The product spec names six field types — short
 * text, long text, choice, date, number, attachment — "because a form is for
 * collecting facts, not for building a UI". `time` is the seventh: it is
 * declared, unused by any seeded form, and must not be offered by the
 * form-builder. It stays because removing a value from a shipped pg enum is a
 * migration for no gain.
 *
 * `attachment` is declared-but-inert until the `attachment` table exists — the
 * submission service rejects it as unsupported.
 *
 * The order mirrors FORM_FIELD_TYPES in @support/types exactly, and
 * tests/schema.test.ts asserts it, so the two cannot drift.
 */
export const formFieldType = pgEnum('form_field_type', [
  'short_text',
  'long_text',
  'number',
  'date',
  'time',
  'choice',
  'attachment',
])

/**
 * `in_progress` is the only status with a null `submitted_at`, so nothing rots
 * in an ambiguous state. The other three are TERMINAL: there is no transition
 * out of them and no path back to `in_progress`.
 *
 * The three are DERIVED from the answer rows at terminate time (slice 2), not
 * from which button was pressed: `completed` = every field has >=1 answer,
 * `partial` = some do and some do not, `skipped` = zero answers. Partial answers
 * therefore survive a skip. See docs/specs/2026-08-17-player-side-forms-design.md §1.3.
 */
export const formStatus = pgEnum('form_status', ['in_progress', 'completed', 'partial', 'skipped'])
```

- [ ] **Step 4: Create `backend/src/shared/db/schema/forms.ts`**

```ts
import { sql } from 'drizzle-orm'
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { FormField } from '@support/types'
import { conversation } from './conversations.ts'
import { formFieldType, formStatus } from './enums.ts'
import { agent, workspace } from './identity.ts'

const tz = { withTimezone: true, mode: 'date' } as const

/**
 * A form: a short set of structured questions attached to a subintent, asked in
 * the chat before the player reaches a human.
 *
 * `created_by` is nullable and unset in this slice — the admin builder that
 * would populate it ships later. Same precedent as `subintent.default_priority`:
 * the column exists so the later work needs no migration.
 *
 * `archived_at` retires a form from new use without deleting it. Nothing is ever
 * deleted.
 *
 * There is deliberately NO `current_version` column. The current version is the
 * highest `version` with `published_at IS NOT NULL` — a pointer column would be
 * a second source of truth that can drift from the rows it points at.
 */
export const form = pgTable(
  'form',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    createdBy: uuid('created_by').references(() => agent.id, { onDelete: 'restrict' }),
    archivedAt: timestamp('archived_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('form_workspace_name_uk').on(t.workspaceId, t.name),
    // Composite-FK parent key: form_version, form_submission and subintent all
    // reference (workspace_id, id) together, so no row can ever parent onto
    // another workspace's form. FK checks bypass RLS — see
    // docs/decisions/2026-08-04-composite-foreign-keys-for-tenancy.md.
    unique('form_workspace_id_uk').on(t.workspaceId, t.id),
  ],
)

/**
 * The questions, versioned, so answers already collected stay readable when a
 * live form is edited.
 *
 * `fields` is a validated jsonb array, NOT a `form_field` table — recorded as
 * deviation §14 in docs/decisions/spec-contradictions.md. A stable string
 * `field_key` survives reordering and relabelling without touching an answer
 * row. What that gives up is an FK: nothing at the database layer stops an
 * answer naming a key absent from this array, so that check lives in the
 * submission service, and every writer here must run `formFieldsSchema` from
 * @support/types first.
 *
 * `published_at IS NULL` means draft. A version row is immutable once published;
 * nothing in this slice enforces that (the authoring spec owns it) but no code
 * here may update a published version's `fields`.
 */
export const formVersion = pgTable(
  'form_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    formId: uuid('form_id').notNull(),
    version: integer('version').notNull(),
    fields: jsonb('fields').$type<FormField[]>().notNull().default(sql`'[]'::jsonb`),
    publishedAt: timestamp('published_at', tz),
    publishedBy: uuid('published_by').references(() => agent.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    // Serves "the current version of this form" — the highest published version.
    // Also the parent key for form_submission's (form_id, form_version) FK.
    uniqueIndex('form_version_form_version_uk').on(t.formId, t.version),
    foreignKey({
      name: 'form_version_form_fk',
      columns: [t.workspaceId, t.formId],
      foreignColumns: [form.workspaceId, form.id],
    }).onDelete('restrict'),
  ],
)

/**
 * One offer of one form on one conversation, and its outcome.
 *
 * `UNIQUE (conversation_id, form_id)`: a form is offered ONCE per conversation.
 * There is no re-offer path — submit and skip are both terminal, and a
 * reclassified conversation does not auto-offer its new subintent's form; the
 * agent asks manually.
 *
 * `form_version` is a plain int snapshot: set at insert, never updated. That is
 * what makes it safe — the questions an answer was collected under can never be
 * rewritten under it. The (form_id, form_version) FK below turns that from a
 * resolvable convention into an enforced one.
 *
 * There is deliberately no `subintent_id`: which subintent triggered the form is
 * answered through the conversation at read time. The submission freezes
 * `form_id` + `form_version` only.
 */
export const formSubmission = pgTable(
  'form_submission',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').notNull(),
    formId: uuid('form_id').notNull(),
    formVersion: integer('form_version').notNull(),
    status: formStatus('status').notNull().default('in_progress'),
    startedAt: timestamp('started_at', tz).notNull().defaultNow(),
    /** Set on EVERY terminal state — it records when the outcome became known,
     *  not only when a submit button was pressed. */
    submittedAt: timestamp('submitted_at', tz),
  },
  (t) => [
    uniqueIndex('form_submission_conversation_form_uk').on(t.conversationId, t.formId),
    // Composite-FK parent key for form_answer.
    unique('form_submission_workspace_id_uk').on(t.workspaceId, t.id),
    foreignKey({
      name: 'form_submission_conversation_fk',
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversation.workspaceId, conversation.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'form_submission_form_fk',
      columns: [t.workspaceId, t.formId],
      foreignColumns: [form.workspaceId, form.id],
    }).onDelete('restrict'),
    // Not a tenancy FK — form_id already carries workspace_id via the FK above.
    // This one exists so a submission cannot claim a version that does not exist.
    foreignKey({
      name: 'form_submission_version_fk',
      columns: [t.formId, t.formVersion],
      foreignColumns: [formVersion.formId, formVersion.version],
    }).onDelete('restrict'),
  ],
)

/**
 * Append-only answers. A correction is a SECOND row for the same `field_key`;
 * newest `created_at` wins on read. Never an in-place update — enforced by
 * `REVOKE UPDATE ON form_answer FROM support_app` in 002_rls.sql, the same way
 * the `event` spine is enforced, not by convention. There is deliberately no
 * unique key on (form_submission_id, field_key): multiple rows per field IS the
 * mechanism, not an error.
 *
 * `field_type` is a SNAPSHOT of the field's declared type, so `value` is
 * interpretable without resolving the version, and a field retyped in a later
 * version can never make an old answer misread. Same rule as event payloads:
 * snapshots, never live pointers.
 *
 * `value` is NOT NULL and there is no empty-answer sentinel. Unanswered means no
 * row, so "what is missing" stays derivable: the version's field keys minus the
 * keys that have at least one answer.
 */
export const formAnswer = pgTable(
  'form_answer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    formSubmissionId: uuid('form_submission_id').notNull(),
    fieldKey: text('field_key').notNull(),
    fieldType: formFieldType('field_type').notNull(),
    value: jsonb('value').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    // The newest-wins read: one submission's answers for one field, in time order.
    index('form_answer_submission_field_idx').on(t.formSubmissionId, t.fieldKey, t.createdAt),
    foreignKey({
      name: 'form_answer_submission_fk',
      columns: [t.workspaceId, t.formSubmissionId],
      foreignColumns: [formSubmission.workspaceId, formSubmission.id],
    }).onDelete('restrict'),
  ],
)
```

- [ ] **Step 5: Promote `subintent.form_id` to a real composite FK**

In `backend/src/shared/db/schema/taxonomy.ts`:

Add `foreignKey` to the `drizzle-orm/pg-core` import and add `import { form } from './forms.ts'` below the existing `./identity.ts` import.

Replace the `formId` column's comment:

```ts
    /** A subintent maps to AT MOST one form; many subintents may point at the
     *  same one. The cardinality follows from the column's shape — a single
     *  nullable uuid — not from a constraint, and the FK lives here because this
     *  is the many side. NULL means this subintent never shows a form, which is
     *  the common case: roughly 28 of the seeded subintents map to nothing. */
    formId: uuid('form_id'),
```

and append to the table's constraint array, after `unique('subintent_workspace_id_uk')`:

```ts
    // Composite, not a bare FK: RI checks run with row security suspended, so a
    // single-column FK would let workspace A point a subintent at workspace B's
    // form. See docs/decisions/2026-08-04-composite-foreign-keys-for-tenancy.md.
    foreignKey({
      name: 'subintent_form_fk',
      columns: [t.workspaceId, t.formId],
      foreignColumns: [form.workspaceId, form.id],
    }).onDelete('restrict'),
```

> **On the import cycle this creates.** `taxonomy.ts → forms.ts → conversations.ts → taxonomy.ts` is a real ES-module cycle. It is expected to work, because the `(t) => [...]` constraint callback is **lazy** — Drizzle invokes it after every module in the cycle has finished evaluating, so `form.workspaceId` is resolved then, not at import time. The existing `conversation_subintent_fk` in `conversations.ts` relies on exactly the same laziness.
>
> If Node nonetheless throws `Cannot access 'form' before initialization` when Step 7 or Step 10 runs, the fallback is: delete the `foreignKey({ name: 'subintent_form_fk', … })` block from `taxonomy.ts`, remove the `./forms.ts` import from it, and instead hand-write the constraint into `backend/drizzle/0004_forms.sql` at ordering position 4:
>
> ```sql
> ALTER TABLE "subintent" ADD CONSTRAINT "subintent_form_fk"
>   FOREIGN KEY ("workspace_id","form_id") REFERENCES "public"."form"("workspace_id","id")
>   ON DELETE restrict ON UPDATE no action;
> ```
>
> and add a comment in `taxonomy.ts` on the `formId` column saying the FK is declared in the migration only, because the Drizzle model cannot express it without a load-time cycle. The `schema.test.ts` assertion on `subintent_form_fk` passes either way — it reads `pg_constraint`, not the model.

- [ ] **Step 6: Add the `conversation` composite-FK parent key and export the new file**

In `backend/src/shared/db/schema/conversations.ts`, add `unique` to the `drizzle-orm/pg-core` import and append to `conversation`'s constraint array:

```ts
    // Composite-FK parent key: form_submission references (workspace_id, id)
    // together. Additive only — no existing FK is re-pointed.
    unique('conversation_workspace_id_uk').on(t.workspaceId, t.id),
```

In `backend/src/shared/db/schema/index.ts`, append:

```ts
export * from './forms.ts'
```

- [ ] **Step 7: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `backend/drizzle/0004_<random-name>.sql`, a `meta/0004_snapshot.json`, and a fourth entry in `meta/_journal.json`.

Rename the SQL file to `backend/drizzle/0004_forms.sql` and set that entry's `"tag"` in `backend/drizzle/meta/_journal.json` to `"0004_forms"` — matching how `0002_confirm_phase` and `0003_ticket_number` were named. Leave `idx`, `when` and `version` alone.

- [ ] **Step 8: Verify and, if necessary, reorder the migration's statements**

Open `backend/drizzle/0004_forms.sql` and confirm the statements appear in this order. **This is the check the inherited spec is emphatic about — steps 2–3 must precede the FKs that depend on them.** If drizzle emitted them in another order, reorder by hand; the end state still matches `meta/0004_snapshot.json`, which is what the migrator compares against.

```
1.  CREATE TYPE "public"."form_field_type" AS ENUM (...);
    CREATE TYPE "public"."form_status" AS ENUM (...);
2.  ALTER TABLE "conversation" ADD CONSTRAINT "conversation_workspace_id_uk" UNIQUE("workspace_id","id");
3.  CREATE TABLE "form" (...);            -- carries form_workspace_id_uk
    CREATE UNIQUE INDEX "form_workspace_name_uk" ...;
    CREATE TABLE "form_version" (...);
    CREATE UNIQUE INDEX "form_version_form_version_uk" ...;
    ALTER TABLE "form_version" ADD CONSTRAINT "form_version_form_fk" ...;
4.  ALTER TABLE "subintent" ADD CONSTRAINT "subintent_form_fk" ...;
5.  CREATE TABLE "form_submission" (...); -- carries form_submission_workspace_id_uk
    CREATE UNIQUE INDEX "form_submission_conversation_form_uk" ...;
    ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_conversation_fk" ...;
    ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_form_fk" ...;
    ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_version_fk" ...;
    CREATE TABLE "form_answer" (...);
    CREATE INDEX "form_answer_submission_field_idx" ...;
    ALTER TABLE "form_answer" ADD CONSTRAINT "form_answer_submission_fk" ...;
```

Then add this header comment to the top of the file:

```sql
-- Order matters, per docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md
-- §Migration. Steps 2-3 must precede the FKs that depend on them:
--   1. the two enums
--   2. conversation UNIQUE (workspace_id, id)   -- parent key for step 5
--   3. form (with its UNIQUE (workspace_id, id)), then form_version
--   4. the composite FK on subintent.form_id     -- depends on step 3
--   5. form_submission, then form_answer         -- depend on steps 2, 3
-- Every existing subintent row has form_id IS NULL, so no data fails step 4.
-- Nothing is rewritten and no existing FK is re-pointed: this migration is
-- additive and reversible by dropping the new objects.
-- 002_rls.sql (spec step 8) runs after this, from db:setup.
```

- [ ] **Step 9: Add the `form_answer` revoke to `002_rls.sql`**

In `backend/src/shared/db/sql/002_rls.sql`, replace the last paragraph of the `2a` comment block — the three lines beginning `-- form_answer gets the same REVOKE UPDATE treatment when that table lands.` — with nothing, and append after the two `change_log` revokes:

```sql

-- 2c - form_answer is append-only: a correction is a NEW row for the same
-- field_key and the newest created_at wins on read. An in-place update would
-- destroy the correction history the agent rail and the drop-off analysis both
-- read. DELETE is already granted nowhere, but it is revoked here too so the
-- guarantee does not depend on the blanket GRANT above staying as it is.
REVOKE UPDATE, DELETE ON form_answer FROM support_app;
REVOKE UPDATE, DELETE ON form_answer FROM PUBLIC;
```

`form`, `form_version` and `form_submission` deliberately keep `UPDATE`: publishing a version sets `published_at`, archiving a form sets `archived_at`, and terminating a submission sets `status` and `submitted_at`. Do not tidy these into symmetry.

The four new tables all carry a `workspace_id` column, so the structural policy loop in section 3 picks them up with **no edit to it**. That is the point of that design — do not add a table list.

- [ ] **Step 10: Apply and run the tests**

Run: `pnpm db:setup`
Expected: exits 0, no error. If it fails on a constraint-ordering error, go back to Step 8.

Run: `pnpm --filter @support/api exec vitest run tests/schema.test.ts`
Expected: PASS, all assertions including the twenty-table list.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 11: Prove the migration is ordering-correct on a virgin database**

The check above ran against a database that already had the earlier migrations. Prove the new file also applies from nothing:

```bash
docker compose exec -T postgres psql -U support_owner -d postgres -c 'drop database if exists support_ordercheck' \
  && docker compose exec -T postgres psql -U support_owner -d postgres -c 'create database support_ordercheck' \
  && MIGRATION_DATABASE_URL=postgres://support_owner:support_owner@localhost:5432/support_ordercheck \
     pnpm --filter @support/api exec node --experimental-strip-types src/shared/db/setup.ts \
  && docker compose exec -T postgres psql -U support_owner -d postgres -c 'drop database support_ordercheck'
```

Expected: `database ready`, then the drop succeeds. A failure here means a statement references an object that does not exist yet — fix the order in `0004_forms.sql`, not the schema.

- [ ] **Step 12: Commit**

```bash
git add backend/src/shared/db/schema backend/drizzle backend/src/shared/db/sql/002_rls.sql \
        backend/tests/helpers/db.ts backend/tests/schema.test.ts
git commit -m "feat(db): form, form_version, form_submission, form_answer"
```

---

### Task 3: The data-model guarantees — composite FKs, append-only, RLS

The inherited spec's `tests/forms.dataModel.test.ts` section, in full, plus the `rls.test.ts` extensions. No production code changes: this task proves Task 2's schema actually holds, at the database layer, as `support_app`.

**Files:**
- Modify: `backend/tests/rls.test.ts`
- Test: `backend/tests/forms.dataModel.test.ts` (create)

**Interfaces:**
- Consumes: `seedForm`, `seedFormVersion`, `seedFormSubmission`, `seedFormAnswer`, `seedWorkspace`, `seedPlayer`, `seedConversation`, `ownerPool`, `truncateAll`, `closeOwnerPool` from `./helpers/db.ts` (Task 2).
- Produces: nothing importable.

- [ ] **Step 1: Write `backend/tests/forms.dataModel.test.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getEnv } from '../src/env.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedForm,
  seedFormAnswer,
  seedFormSubmission,
  seedFormVersion,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

let app: Client
let wsA: string
let wsB: string
let conversationA: string
let formA: string
let formB: string
let submissionA: string

beforeAll(async () => {
  app = new Client({ connectionString: getEnv().DATABASE_URL })
  await app.connect()
})

afterAll(async () => {
  await app.end()
  await closeOwnerPool()
})

async function asWorkspace<T>(id: string, fn: () => Promise<T>): Promise<T> {
  await app.query('begin')
  try {
    await app.query(`select set_config('app.workspace_id', $1, true)`, [id])
    const result = await fn()
    await app.query('commit')
    return result
  } catch (error) {
    await app.query('rollback')
    throw error
  }
}

beforeEach(async () => {
  await truncateAll()
  wsA = await seedWorkspace({ slug: `a-${randomUUID().slice(0, 8)}` })
  wsB = await seedWorkspace({ slug: `b-${randomUUID().slice(0, 8)}` })
  const playerA = await seedPlayer(wsA)
  conversationA = await seedConversation({ workspaceId: wsA, playerId: playerA })
  formA = await seedForm({ workspaceId: wsA, name: 'Purchase receipt' })
  formB = await seedForm({ workspaceId: wsB, name: 'Purchase receipt' })
  await seedFormVersion({ workspaceId: wsA, formId: formA, version: 1, publishedAt: new Date() })
  await seedFormVersion({ workspaceId: wsB, formId: formB, version: 1, publishedAt: new Date() })
  submissionA = await seedFormSubmission({ workspaceId: wsA, conversationId: conversationA, formId: formA })
})

describe('form_answer is append-only, enforced not conventional', () => {
  it('refuses an UPDATE and a DELETE as support_app', async () => {
    await seedFormAnswer({ workspaceId: wsA, formSubmissionId: submissionA, fieldKey: 'store', value: 'Other' })

    await expect(
      asWorkspace(wsA, () => app.query(`update form_answer set value = '"tampered"'::jsonb`)),
    ).rejects.toThrow(/permission denied/i)
    await expect(asWorkspace(wsA, () => app.query('delete from form_answer'))).rejects.toThrow(
      /permission denied/i,
    )
  })
})

describe('composite FKs block the cross-tenant edge at the database, not in a handler', () => {
  it('refuses a form_submission whose form belongs to another workspace', async () => {
    await expect(
      asWorkspace(wsA, () =>
        app.query(
          `insert into form_submission (workspace_id, conversation_id, form_id, form_version)
           values ($1, $2, $3, 1)`,
          [wsA, conversationA, formB],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint/i)
  })

  it('refuses a form_submission whose conversation belongs to another workspace', async () => {
    const playerB = await seedPlayer(wsB)
    const conversationB = await seedConversation({ workspaceId: wsB, playerId: playerB })
    await expect(
      asWorkspace(wsA, () =>
        app.query(
          `insert into form_submission (workspace_id, conversation_id, form_id, form_version)
           values ($1, $2, $3, 1)`,
          [wsA, conversationB, formA],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint/i)
  })

  it('refuses a form_answer whose submission belongs to another workspace', async () => {
    const playerB = await seedPlayer(wsB)
    const conversationB = await seedConversation({ workspaceId: wsB, playerId: playerB })
    const submissionB = await seedFormSubmission({
      workspaceId: wsB,
      conversationId: conversationB,
      formId: formB,
    })
    await expect(
      asWorkspace(wsA, () =>
        app.query(
          `insert into form_answer (workspace_id, form_submission_id, field_key, field_type, value)
           values ($1, $2, 'store', 'short_text', '"Other"'::jsonb)`,
          [wsA, submissionB],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint/i)
  })

  it('refuses a subintent pointing at another workspace form', async () => {
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [wsA],
    )
    const intentId = rows[0]!.id
    await expect(
      asWorkspace(wsA, () =>
        app.query(
          `insert into subintent (workspace_id, intent_id, name, form_id) values ($1, $2, 'Double Charge', $3)`,
          [wsA, intentId, formB],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint/i)
  })
})

describe('offered once per conversation', () => {
  it('refuses a second submission for the same (conversation_id, form_id)', async () => {
    await expect(
      asWorkspace(wsA, () =>
        app.query(
          `insert into form_submission (workspace_id, conversation_id, form_id, form_version)
           values ($1, $2, $3, 1)`,
          [wsA, conversationA, formA],
        ),
      ),
    ).rejects.toThrow(/duplicate key value/i)
  })
})

describe('the version snapshot is enforced, not merely resolvable', () => {
  it('refuses a submission naming a (form_id, form_version) with no matching version row', async () => {
    const playerA2 = await seedPlayer(wsA)
    const conversationA2 = await seedConversation({ workspaceId: wsA, playerId: playerA2 })
    await expect(
      asWorkspace(wsA, () =>
        app.query(
          `insert into form_submission (workspace_id, conversation_id, form_id, form_version)
           values ($1, $2, $3, 99)`,
          [wsA, conversationA2, formA],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint/i)
  })
})

describe('corrections are additions', () => {
  it('keeps both rows and reads the newest created_at as current', async () => {
    const older = new Date(Date.now() - 60_000)
    await seedFormAnswer({
      workspaceId: wsA,
      formSubmissionId: submissionA,
      fieldKey: 'order_or_receipt_id',
      value: 'typo',
      createdAt: older,
    })
    await seedFormAnswer({
      workspaceId: wsA,
      formSubmissionId: submissionA,
      fieldKey: 'order_or_receipt_id',
      value: 'GPA.1234-5678',
    })

    const rows = await asWorkspace(wsA, async () =>
      (
        await app.query<{ value: string; n: string }>(
          `select value::text as value, count(*) over () as n
             from form_answer
            where form_submission_id = $1 and field_key = 'order_or_receipt_id'
            order by created_at desc
            limit 1`,
          [submissionA],
        )
      ).rows,
    )
    expect(rows[0]?.n).toBe('2')
    expect(JSON.parse(rows[0]!.value)).toBe('GPA.1234-5678')
  })
})

describe('unanswered is the absence of a row', () => {
  it('derives missing fields as the version keys minus the answered keys, with no null-valued row', async () => {
    const keys = ['store', 'order_or_receipt_id', 'purchase_date', 'what_you_expected']
    await seedFormAnswer({ workspaceId: wsA, formSubmissionId: submissionA, fieldKey: 'store', value: 'Other' })
    await seedFormAnswer({
      workspaceId: wsA,
      formSubmissionId: submissionA,
      fieldKey: 'purchase_date',
      fieldType: 'date',
      value: '2026-08-16',
    })

    const answered = await asWorkspace(wsA, async () =>
      (
        await app.query<{ field_key: string }>(
          `select distinct field_key from form_answer where form_submission_id = $1`,
          [submissionA],
        )
      ).rows.map((r) => r.field_key),
    )
    expect(keys.filter((k) => !answered.includes(k))).toEqual(['order_or_receipt_id', 'what_you_expected'])

    const { rows: nulls } = await ownerPool.query(`select 1 from form_answer where value is null`)
    expect(nulls).toHaveLength(0)
  })
})

describe('RLS covers all four new tables', () => {
  const NEW_TABLES = ['form', 'form_version', 'form_submission', 'form_answer']

  it('gives each one a tenant policy with FORCE row level security', async () => {
    const { rows } = await ownerPool.query<{ relname: string; relforcerowsecurity: boolean }>(
      `select relname, relforcerowsecurity from pg_class where relname = any($1::text[])`,
      [NEW_TABLES],
    )
    expect(rows).toHaveLength(NEW_TABLES.length)
    for (const row of rows) expect(row.relforcerowsecurity, row.relname).toBe(true)

    const { rows: policies } = await ownerPool.query<{ tablename: string }>(
      `select tablename from pg_policies where policyname = 'tenant' and tablename = any($1::text[])`,
      [NEW_TABLES],
    )
    expect(policies.map((p) => p.tablename).sort()).toEqual([...NEW_TABLES].sort())
  })

  it('hides another workspace rows entirely', async () => {
    const rows = await asWorkspace(wsA, async () => (await app.query('select id from form')).rows)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(formA)
  })
})
```

- [ ] **Step 2: Extend `backend/tests/rls.test.ts`**

Add the four tables to `SCOPED_TABLES`:

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
  'form',
  'form_version',
  'form_submission',
  'form_answer',
]
```

In the inner `describe` that owns the smuggled-insert test (the one declaring `AGENT_A`, `SESSION_A` and `conversationAId`), add a `formAId` binding and seed it in that block's `beforeEach`, immediately after `conversationAId` is assigned:

```ts
  let formAId: string
  let submissionAId: string
```

```ts
    const { rows: formRows } = await ownerPool.query<{ id: string }>(
      `insert into form (workspace_id, name) values ($1, 'Purchase receipt') returning id`,
      [WS_A],
    )
    formAId = formRows[0]!.id
    await ownerPool.query(
      `insert into form_version (workspace_id, form_id, version, published_at) values ($1, $2, 1, now())`,
      [WS_A, formAId],
    )
    const { rows: subRows } = await ownerPool.query<{ id: string }>(
      `insert into form_submission (workspace_id, conversation_id, form_id, form_version)
       values ($1, $2, $3, 1) returning id`,
      [WS_A, conversationAId, formAId],
    )
    submissionAId = subRows[0]!.id
```

Then add four entries to the `attempts` array in the smuggled-insert test, so it still equals `SCOPED_TABLES`:

```ts
      {
        table: 'form',
        sql: `insert into form (workspace_id, name) values ($1, 'Smuggled')`,
        params: [WS_B],
      },
      {
        table: 'form_version',
        sql: `insert into form_version (workspace_id, form_id, version) values ($1, $2, 2)`,
        params: [WS_B, formAId],
      },
      {
        table: 'form_submission',
        sql: `insert into form_submission (workspace_id, conversation_id, form_id, form_version)
              values ($1, $2, $3, 1)`,
        params: [WS_B, conversationAId, formAId],
      },
      {
        table: 'form_answer',
        sql: `insert into form_answer (workspace_id, form_submission_id, field_key, field_type, value)
              values ($1, $2, 'store', 'short_text', '"Other"'::jsonb)`,
        params: [WS_B, submissionAId],
      },
```

And add one append-only probe alongside the existing `event` and `change_log` ones, inside the top-level `describe('row-level security', …)`:

```ts
  it('cannot update or delete a form_answer — a correction is a new row, never an edit', async () => {
    const { rows: formRows } = await ownerPool.query<{ id: string }>(
      `insert into form (workspace_id, name) values ($1, 'Bug report') returning id`,
      [WS_A],
    )
    const formId = formRows[0]!.id
    await ownerPool.query(
      `insert into form_version (workspace_id, form_id, version, published_at) values ($1, $2, 1, now())`,
      [WS_A, formId],
    )
    // Bump the counter the same way the request path does, so this row's number
    // does not collide with anything else the suite seeded.
    const { rows: seqRows } = await ownerPool.query<{ ticket_seq: number }>(
      `update workspace set ticket_seq = ticket_seq + 1 where id = $1 returning ticket_seq`,
      [WS_A],
    )
    const { rows: cRows } = await ownerPool.query<{ id: string }>(
      `insert into conversation (workspace_id, player_id, number) values ($1, $2, $3) returning id`,
      [WS_A, PLAYER_A, seqRows[0]!.ticket_seq],
    )
    const { rows: subRows } = await ownerPool.query<{ id: string }>(
      `insert into form_submission (workspace_id, conversation_id, form_id, form_version)
       values ($1, $2, $3, 1) returning id`,
      [WS_A, cRows[0]!.id, formId],
    )
    await ownerPool.query(
      `insert into form_answer (workspace_id, form_submission_id, field_key, field_type, value)
       values ($1, $2, 'what_happened', 'long_text', '"it crashed"'::jsonb)`,
      [WS_A, subRows[0]!.id],
    )

    await expect(
      asWorkspace(WS_A, () => app.query(`update form_answer set value = '"tampered"'::jsonb`)),
    ).rejects.toThrow(/permission denied/i)
    await expect(asWorkspace(WS_A, () => app.query('delete from form_answer'))).rejects.toThrow(
      /permission denied/i,
    )
  })

  it('keeps form_submission updatable — terminating a submission sets status and submitted_at', async () => {
    // Deliberate asymmetry with form_answer. Do not "tidy" the revoke in
    // 002_rls.sql into covering both tables: slice 2 writes the terminal status
    // onto this row.
    const { rows } = await ownerPool.query<{ has_priv: boolean }>(
      `select has_table_privilege('support_app', 'form_submission', 'UPDATE') as has_priv`,
    )
    expect(rows[0]?.has_priv).toBe(true)
  })
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `pnpm --filter @support/api exec vitest run tests/forms.dataModel.test.ts tests/rls.test.ts`
Expected: PASS. These assert Task 2's schema, so they should pass on the first run; a failure means Task 2 is wrong, not this task.

If a composite-FK test fails with a *row-level security* error rather than a *foreign key* error, the insert is claiming the wrong `workspace_id` — the probe must claim its own workspace and point at a foreign parent, which is the exact vector the ADR describes.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/forms.dataModel.test.ts backend/tests/rls.test.ts
git commit -m "test(db): forms composite FKs, append-only answers, tenancy"
```

---

### Task 4: `resolveSubintentForm`

One function, so slice 2 has exactly one place that asks "is there a form here" and cannot answer it two different ways.

**Files:**
- Create: `backend/src/domain/forms/resolveSubintentForm.ts`
- Create: `backend/src/domain/forms/index.ts`
- Test: `backend/tests/forms.resolve.test.ts`

**Interfaces:**
- Consumes: `Tx` from `backend/src/shared/db/withWorkspace.ts`; `form`, `formVersion`, `subintent` from the schema barrel; `FormField` from `@support/types`.
- Produces:
  ```ts
  export type ResolvedForm = {
    formId: string
    formName: string
    version: number
    fields: FormField[]
  }
  export async function resolveSubintentForm(tx: Tx, subintentId: string): Promise<ResolvedForm | null>
  ```
  Slice 2 calls this from `applyBotTurn`'s `handoff` case. Do not change the signature.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/forms.resolve.test.ts`:

```ts
import { randomUUID } from 'node:crypto'
import type { FormField } from '@support/types'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { resolveSubintentForm } from '../src/domain/forms/resolveSubintentForm.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedForm,
  seedFormVersion,
  seedIntent,
  seedSubintent,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

const FIELDS: FormField[] = [
  { key: 'what_you_expected', label: 'What you expected', type: 'long_text', isRequired: true, position: 3 },
  { key: 'store', label: 'Store', type: 'choice', isRequired: true, position: 0, options: ['A', 'B'] },
  { key: 'purchase_date', label: 'Date of purchase', type: 'date', isRequired: true, position: 2 },
  { key: 'order_or_receipt_id', label: 'Order or receipt ID', type: 'short_text', isRequired: true, position: 1 },
]

let workspaceId: string
let intentId: string

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(async () => {
  await truncateAll()
  workspaceId = await seedWorkspace({ slug: `ws-${randomUUID().slice(0, 8)}` })
  intentId = await seedIntent(workspaceId)
})

async function mapSubintentToForm(subintentId: string, formId: string): Promise<void> {
  await ownerPool.query(`update subintent set form_id = $1 where id = $2`, [formId, subintentId])
}

describe('resolveSubintentForm', () => {
  it('returns null, without throwing, when the subintent has no form_id', async () => {
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'How to Play' })
    const result = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, subintentId))
    expect(result).toBeNull()
  })

  it('returns null, without throwing, when the form is archived', async () => {
    const formId = await seedForm({ workspaceId, name: 'Retired', archivedAt: new Date() })
    await seedFormVersion({ workspaceId, formId, version: 1, fields: FIELDS, publishedAt: new Date() })
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Double Charge' })
    await mapSubintentToForm(subintentId, formId)

    const result = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, subintentId))
    expect(result).toBeNull()
  })

  it('returns null, without throwing, when no version is published', async () => {
    const formId = await seedForm({ workspaceId, name: 'Draft only' })
    await seedFormVersion({ workspaceId, formId, version: 1, fields: FIELDS, publishedAt: null })
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Missing Purchase' })
    await mapSubintentToForm(subintentId, formId)

    const result = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, subintentId))
    expect(result).toBeNull()
  })

  it('returns null for a subintent id that does not exist at all', async () => {
    const result = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, randomUUID()))
    expect(result).toBeNull()
  })

  it('returns the highest published version, ignoring an unpublished higher one', async () => {
    const formId = await seedForm({ workspaceId, name: 'Purchase receipt' })
    await seedFormVersion({ workspaceId, formId, version: 1, fields: FIELDS, publishedAt: new Date() })
    await seedFormVersion({ workspaceId, formId, version: 2, fields: FIELDS, publishedAt: new Date() })
    await seedFormVersion({ workspaceId, formId, version: 3, fields: FIELDS, publishedAt: null })
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Refund Status' })
    await mapSubintentToForm(subintentId, formId)

    const result = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, subintentId))
    expect(result).not.toBeNull()
    expect(result?.formId).toBe(formId)
    expect(result?.formName).toBe('Purchase receipt')
    expect(result?.version).toBe(2)
  })

  it('returns fields in position order regardless of how they are stored', async () => {
    const formId = await seedForm({ workspaceId, name: 'Purchase receipt' })
    await seedFormVersion({ workspaceId, formId, version: 1, fields: FIELDS, publishedAt: new Date() })
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Billing Errors' })
    await mapSubintentToForm(subintentId, formId)

    const result = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, subintentId))
    expect(result?.fields.map((f) => f.key)).toEqual([
      'store',
      'order_or_receipt_id',
      'purchase_date',
      'what_you_expected',
    ])
    expect(result?.fields.map((f) => f.position)).toEqual([0, 1, 2, 3])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api exec vitest run tests/forms.resolve.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/forms/resolveSubintentForm.ts'`.

- [ ] **Step 3: Write `backend/src/domain/forms/resolveSubintentForm.ts`**

```ts
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import type { FormField } from '@support/types'
import { form, formVersion, subintent } from '../../shared/db/schema/index.ts'
import type { Tx } from '../../shared/db/withWorkspace.ts'

export type ResolvedForm = {
  formId: string
  formName: string
  version: number
  fields: FormField[]
}

/**
 * Does this subintent show a form, and if so which version?
 *
 * All three conditions must hold, per
 * docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md:
 *   1. subintent.form_id IS NOT NULL
 *   2. that form's archived_at IS NULL
 *   3. that form has at least one version with published_at IS NOT NULL
 * The version returned is the highest `version` with published_at IS NOT NULL.
 *
 * A FAILURE OF ANY CONDITION RETURNS null, NEVER AN ERROR. Same shape as the
 * existing rule that missing player state is a state, not an error: the
 * conversation proceeds without a form. Roughly 28 of the seeded subintents map
 * to nothing, so null is the COMMON path, not the exceptional one.
 *
 * One function on purpose, so slice 2 has exactly one place that asks "is there
 * a form here" and cannot answer it two different ways. Do not inline this
 * query anywhere else.
 *
 * Scoping is the caller's transaction: `tx` comes from `withWorkspace`, so RLS
 * already restricts every table below to one workspace.
 */
export async function resolveSubintentForm(tx: Tx, subintentId: string): Promise<ResolvedForm | null> {
  const [row] = await tx
    .select({
      formId: form.id,
      formName: form.name,
      version: formVersion.version,
      fields: formVersion.fields,
    })
    .from(subintent)
    // An inner join is what turns condition 1 into "no row": a null form_id
    // matches nothing, so it needs no separate branch.
    .innerJoin(form, eq(form.id, subintent.formId))
    .innerJoin(formVersion, eq(formVersion.formId, form.id))
    .where(and(eq(subintent.id, subintentId), isNull(form.archivedAt), isNotNull(formVersion.publishedAt)))
    .orderBy(desc(formVersion.version))
    .limit(1)

  if (!row) return null

  return {
    formId: row.formId,
    formName: row.formName,
    version: row.version,
    // Sorted here rather than trusted from storage: `position` is the render
    // order the card and the agent rail both read, and slice 2 snapshots it into
    // event payloads. One sort site beats three callers each remembering to.
    fields: [...row.fields].sort((a, b) => a.position - b.position),
  }
}
```

- [ ] **Step 4: Add the barrel**

Create `backend/src/domain/forms/index.ts`:

```ts
export * from './resolveSubintentForm.ts'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @support/api exec vitest run tests/forms.resolve.test.ts`
Expected: PASS, all six cases.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain/forms backend/tests/forms.resolve.test.ts
git commit -m "feat(forms): resolveSubintentForm, the single is-there-a-form read"
```

---

### Task 5: The seed — three published forms mapped by subintent name

**Files:**
- Create: `backend/src/shared/db/seedForms.ts`
- Modify: `backend/src/shared/db/seed.ts`
- Test: `backend/tests/seed.test.ts`

**Interfaces:**
- Consumes: `FormField`, `formFieldsSchema` from `@support/types`; `form`, `formVersion`, `subintent` from the schema barrel; `Tx` from `withWorkspace.ts`; `logger`.
- Produces:
  ```ts
  export type SeedForm = { name: string; fields: FormField[]; subintents: string[] }
  export const SEED_FORMS: SeedForm[]
  export async function seedForms(tx: Tx, workspaceId: string): Promise<{ forms: number; mapped: number }>
  ```

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/seed.test.ts`. Add these imports to the existing import block:

```ts
import { formFieldsSchema } from '@support/types'
import { form, formVersion, subintent } from '../src/shared/db/schema/index.ts'
import { SEED_FORMS } from '../src/shared/db/seedForms.ts'
import { resolveSubintentForm } from '../src/domain/forms/resolveSubintentForm.ts'
```

and append these tests inside the existing `describe('seed', …)` block:

```ts
  it('seeds exactly three forms, each with exactly one published version, and re-running does not duplicate them', async () => {
    await seed()
    await seed()

    const workspaceId = await workspaceIdBySlug(SLUG)
    const rows = await withWorkspace(workspaceId, (tx) =>
      tx.select({ id: form.id, name: form.name }).from(form).where(eq(form.workspaceId, workspaceId)),
    )
    expect(rows.map((r) => r.name).sort()).toEqual(['Account recovery', 'Bug report', 'Purchase receipt'])

    for (const row of rows) {
      const versions = await withWorkspace(workspaceId, (tx) =>
        tx
          .select({ version: formVersion.version, publishedAt: formVersion.publishedAt })
          .from(formVersion)
          .where(eq(formVersion.formId, row.id)),
      )
      expect(versions, row.name).toHaveLength(1)
      expect(versions[0]?.version).toBe(1)
      expect(versions[0]?.publishedAt).not.toBeNull()
    }
  })

  it('resolves every mapped subintent name to its expected form, from all of them', async () => {
    await seed()
    const workspaceId = await workspaceIdBySlug(SLUG)

    for (const seedForm of SEED_FORMS) {
      for (const name of seedForm.subintents) {
        const [row] = await withWorkspace(workspaceId, (tx) =>
          tx
            .select({ id: subintent.id })
            .from(subintent)
            .where(and(eq(subintent.workspaceId, workspaceId), eq(subintent.name, name)))
            .limit(1),
        )
        expect(row, `no seeded subintent named ${name}`).toBeDefined()

        const resolved = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, row!.id))
        expect(resolved?.formName, name).toBe(seedForm.name)
        expect(resolved?.version, name).toBe(1)
      }
    }
  })

  it('leaves most subintents with no form — the null path is the common one', async () => {
    await seed()
    const workspaceId = await workspaceIdBySlug(SLUG)

    const rows = await withWorkspace(workspaceId, (tx) =>
      tx
        .select({ id: subintent.id, formId: subintent.formId })
        .from(subintent)
        .where(eq(subintent.workspaceId, workspaceId)),
    )
    const mappedCount = SEED_FORMS.reduce((n, f) => n + f.subintents.length, 0)
    expect(rows.filter((r) => r.formId !== null)).toHaveLength(mappedCount)
    expect(rows.filter((r) => r.formId === null).length).toBeGreaterThan(mappedCount)
  })

  it('uses no time and no attachment field — six usable types, seven declared', async () => {
    const types = SEED_FORMS.flatMap((f) => f.fields.map((field) => field.type))
    expect(types).not.toContain('time')
    expect(types).not.toContain('attachment')
  })

  it('validates every seeded field array against formFieldsSchema', async () => {
    for (const seedForm of SEED_FORMS) {
      const result = formFieldsSchema.safeParse(seedForm.fields)
      expect(result.success, `${seedForm.name}: ${JSON.stringify(result.error?.issues)}`).toBe(true)
      expect(seedForm.fields.length, seedForm.name).toBeGreaterThan(0)
    }
  })

  it('stores the fields the seed declares, in position order, through the resolver', async () => {
    await seed()
    const workspaceId = await workspaceIdBySlug(SLUG)

    const [row] = await withWorkspace(workspaceId, (tx) =>
      tx
        .select({ id: subintent.id })
        .from(subintent)
        .where(and(eq(subintent.workspaceId, workspaceId), eq(subintent.name, 'Missing Purchase')))
        .limit(1),
    )
    const resolved = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, row!.id))
    expect(resolved?.fields.map((f) => f.key)).toEqual([
      'store',
      'order_or_receipt_id',
      'purchase_date',
      'what_you_expected',
    ])
    expect(resolved?.fields[0]?.options).toEqual(['Apple App Store', 'Google Play', 'Other'])
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api exec vitest run tests/seed.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/db/seedForms.ts'`.

- [ ] **Step 3: Write `backend/src/shared/db/seedForms.ts`**

```ts
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { formFieldsSchema, type FormField } from '@support/types'
import { form, formVersion, subintent } from './schema/index.ts'
import type { Tx } from './withWorkspace.ts'

export type SeedForm = {
  name: string
  /** Seeded subintents this form serves, BY NAME. Resolved against the rows
   *  seedTaxonomy created, so a taxonomy edit does not strand a hardcoded uuid. */
  subintents: string[]
  fields: FormField[]
}

/**
 * Three forms, matching the product spec's "Starting templates: purchase
 * receipt, bug report, account recovery". Each is published at version 1 and
 * serves several subintents, exercising the cardinality the spec states: a
 * subintent maps to exactly one form, a form can serve several subintents.
 *
 * No field uses `time` or `attachment`. The product spec names six usable types
 * and the enum declares seven; `time` is declared and unused, `attachment` is
 * declared and inert until the `attachment` table exists.
 *
 * The remaining ~28 seeded subintents map to NOTHING, deliberately: the null
 * path is the common one in production, so the seed must exercise it more than
 * it exercises the happy path.
 */
export const SEED_FORMS: SeedForm[] = [
  {
    name: 'Purchase receipt',
    // The four fields drawn in the product spec's own mockup (page 23, screen C).
    // Nothing invented.
    subintents: ['Missing Purchase', 'Double Charge', 'Refund Status', 'Refund Requests', 'Billing Errors'],
    fields: [
      {
        key: 'store',
        label: 'Store',
        type: 'choice',
        isRequired: true,
        position: 0,
        options: ['Apple App Store', 'Google Play', 'Other'],
      },
      { key: 'order_or_receipt_id', label: 'Order or receipt ID', type: 'short_text', isRequired: true, position: 1 },
      { key: 'purchase_date', label: 'Date of purchase', type: 'date', isRequired: true, position: 2 },
      { key: 'what_you_expected', label: 'What you expected', type: 'long_text', isRequired: true, position: 3 },
    ],
  },
  {
    name: 'Bug report',
    subintents: ['Game Crashes', 'Performance Issues', 'Connection Problems'],
    fields: [
      { key: 'what_happened', label: 'What happened', type: 'long_text', isRequired: true, position: 0 },
      { key: 'steps_to_reproduce', label: 'Steps to reproduce', type: 'long_text', isRequired: false, position: 1 },
      { key: 'when_it_happened', label: 'When it happened', type: 'date', isRequired: false, position: 2 },
      { key: 'device_model', label: 'Device model', type: 'short_text', isRequired: false, position: 3 },
      { key: 'os_version', label: 'OS version', type: 'short_text', isRequired: false, position: 4 },
    ],
  },
  {
    name: 'Account recovery',
    subintents: ['Account Recovery', 'Lost Progress', 'Data Recovery', 'Device Transfer'],
    fields: [
      {
        key: 'last_known_player_id',
        label: 'Your last known player ID',
        type: 'short_text',
        isRequired: true,
        position: 0,
      },
      {
        key: 'linked_account',
        label: 'Linked account',
        type: 'choice',
        isRequired: true,
        position: 1,
        options: ['Google Play', 'Apple Game Center', 'Guest', 'Not sure'],
      },
      { key: 'last_played', label: 'When you last played', type: 'date', isRequired: false, position: 2 },
      {
        key: 'what_changed',
        label: 'What changed before you lost access',
        type: 'long_text',
        isRequired: true,
        position: 3,
      },
    ],
  },
]

/**
 * Idempotent, like the rest of the seed. `form` is keyed by
 * UNIQUE (workspace_id, name) and `form_version` by UNIQUE (form_id, version),
 * so both inserts are ON CONFLICT DO NOTHING with an explicit lookup behind
 * them. The subintent mapping is a scoped UPDATE that only touches rows whose
 * `form_id` is still null, so a re-run never rewrites an admin's later choice.
 *
 * Runs on the APP pool inside the caller's withWorkspace transaction, so the
 * seed exercises the real RLS path rather than bypassing it.
 */
export async function seedForms(tx: Tx, workspaceId: string): Promise<{ forms: number; mapped: number }> {
  const now = new Date()
  let forms = 0
  let mapped = 0

  for (const seedForm of SEED_FORMS) {
    // Validate before writing. Nothing at the database layer checks `fields`, so
    // a malformed seed would otherwise ship a form the submission service can
    // never accept an answer for.
    const parsed = formFieldsSchema.safeParse(seedForm.fields)
    if (!parsed.success) {
      throw new Error(`Seed form "${seedForm.name}" has invalid fields: ${JSON.stringify(parsed.error.issues)}`)
    }

    let [row] = await tx
      .insert(form)
      .values({ workspaceId, name: seedForm.name })
      .onConflictDoNothing()
      .returning({ id: form.id })

    if (row) {
      forms++
    } else {
      ;[row] = await tx
        .select({ id: form.id })
        .from(form)
        .where(and(eq(form.workspaceId, workspaceId), eq(form.name, seedForm.name)))
        .limit(1)
    }
    if (!row) throw new Error(`form upsert returned nothing for "${seedForm.name}"`)

    await tx
      .insert(formVersion)
      .values({
        workspaceId,
        formId: row.id,
        version: 1,
        fields: parsed.data,
        publishedAt: now,
      })
      .onConflictDoNothing()

    const updated = await tx
      .update(subintent)
      .set({ formId: row.id })
      .where(
        and(
          eq(subintent.workspaceId, workspaceId),
          inArray(subintent.name, seedForm.subintents),
          isNull(subintent.formId),
        ),
      )
      .returning({ id: subintent.id })
    mapped += updated.length
  }

  return { forms, mapped }
}
```

- [ ] **Step 4: Call it from `seed.ts`**

In `backend/src/shared/db/seed.ts`, add to the dynamic-import block, after the `SEED_TAXONOMY` line:

```ts
const { SEED_FORMS, seedForms } = await import('./seedForms.ts')
```

Declare a counter beside `insertedArticles` and `skippedArticles`:

```ts
  let formsCreated = 0
  let subintentsMapped = 0
```

Inside the existing `withWorkspace(workspaceId, async (tx) => { … })` block, **after** the `SEED_TAXONOMY` loop and the `Other` intent insert (forms map subintents by name, so every subintent row must exist first):

```ts
    // After the taxonomy loop on purpose: the mapping is by subintent NAME, so
    // every subintent row must already exist. `Other` is included in the scan
    // and maps to nothing, which is correct — an unplaceable conversation gets
    // no form.
    const formCounts = await seedForms(tx, workspaceId)
    formsCreated = formCounts.forms
    subintentsMapped = formCounts.mapped
```

And add one line to the log block, after the `intents` line:

```ts
  logger.info(
    'db',
    `forms       ${formsCreated} created (${SEED_FORMS.length - formsCreated} already existed), ${subintentsMapped} subintents mapped, ${SEED_FORMS.length} published at v1`,
  )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @support/api exec vitest run tests/seed.test.ts`
Expected: PASS, including the re-run idempotency case.

- [ ] **Step 6: Prove the slice's "done when" condition end to end**

Run: `pnpm db:setup && pnpm db:seed`
Expected: exits 0; the log shows `forms       3 created (0 already existed), 12 subintents mapped, 3 published at v1`.

Run it a second time:

Run: `pnpm db:seed`
Expected: `forms       0 created (3 already existed), 0 subintents mapped, 3 published at v1`.

Run: `pnpm test`
Expected: the whole workspace suite passes.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add backend/src/shared/db/seedForms.ts backend/src/shared/db/seed.ts backend/tests/seed.test.ts
git commit -m "feat(db): seed three published forms mapped to seeded subintents"
```

---

### Task 6: The three prose amendments

§1.2 of the 2026-08-17 design: the modal premise is reverted, the storage shape is unaffected, and exactly three documents say so. No code changes.

**Files:**
- Modify: `docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md`
- Modify: `docs/project-overview.md`
- Modify: `docs/decisions/spec-contradictions.md`

**Interfaces:** none.

- [ ] **Step 1: Amend the 2026-08-11 spec's premise paragraph**

In `docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md`, replace the paragraph beginning `Forms are **structured, Google-Form-style UIs opened in a modal**` (immediately under `## What this slice is`) with:

```markdown
Forms were originally specified as **structured, Google-Form-style UIs opened in a modal** — a
supersession recorded in `docs/project-overview.md` on 2026-08-10. **That premise is reverted by
`docs/specs/2026-08-17-player-side-forms-design.md`:** the questions are asked one at a time, in a
card pinned above the composer, not in a modal and not as conversation turns.

**Nothing below changes.** Append-only `form_answer` rows keyed by `field_key`, each snapshotting its
`field_type`, is a better fit for one-at-a-time than for a modal — a modal submits once and could
have been a single row, whereas one-at-a-time writes a row per step and needs exactly the durability
this shape already provides. Every column, constraint, composite FK and design rationale in this
document stands as written; read "the modal" below as "the pinned card". The conversational design in
`docs/specs/2026-08-04-database-and-schema-design.md` §Forms remains history — it modelled fields as
`form_field` rows, which is the part that did not come back.

Two other things in this document are amended by the 2026-08-17 design, both without a schema change:
`form_status` is **derived from the answer rows** rather than from which button was pressed (§1.3
there), and `time` is declared but must never be offered by the form-builder or used by a seeded form
(§1.4 there).
```

- [ ] **Step 2: Amend the 2026-08-10 supersession note in `docs/project-overview.md`**

Replace the heading line and the first bullet of the **Forms** block (currently `**Forms** — *(2026-08-10: superseding the earlier conversational design below)*` and the bullet beginning `**Forms are structured, Google-Form-style UIs opened in a modal**`) with:

```markdown
**Forms** — *(2026-08-17: the modal premise below is reverted; see
`docs/specs/2026-08-17-player-side-forms-design.md`. The 2026-08-10 note it supersedes still stands
for everything except where the questions are asked.)*
- **Forms are asked one question at a time, in a card pinned above the composer** — not in a modal,
  and not as conversation turns. The 2026-08-10 note said modal; that is the one thing that changed.
  The player answers or skips; either way they reach an agent, and **the skip is always present, one
  tap, and cannot be removed.**
- **The storage shape is unaffected by that reversal.** Append-only `form_answer` rows keyed by
  `field_key` suit one-at-a-time better than they suited a modal: a modal submits once, whereas
  one-at-a-time writes a row per step and needs exactly that durability.
```

Leave the rest of that block — the subintent mapping, the field types, the outcome card, the
`form_submission.status` line, the `form_answer` / `message_id` line and the attachment line —
unchanged. One correction to fold into the `status` line's neighbourhood, as a new bullet directly
after it:

```markdown
- `status` is **derived from the answer rows** at terminate time, not from which button was pressed:
  `completed` = every field has at least one answer, `partial` = some do and some do not, `skipped` =
  zero answers. Partial answers therefore survive a skip. *Which* action terminated the submission —
  submit, skip or the abandonment sweeper — is a fact about the turn and lives in the
  `form_completed` event payload, not in a column.
```

- [ ] **Step 3: Add the entry to `docs/decisions/spec-contradictions.md`**

Insert immediately before the `## Contradictions still open (no decision yet)` heading:

```markdown
### 23. Forms: a modal, or one question at a time in the thread?

**Conflict:** `docs/project-overview.md`'s 2026-08-10 note supersedes the original conversational
design and makes forms "structured, Google-Form-style UIs opened in a modal — not messages in the
conversation thread." `docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md` is built on
that premise throughout. The product spec (pages 21–23) draws neither: it draws a card pinned above
the composer, asking one question at a time, with a "Skip and talk to an agent" button on every
question.

**Decision:** **One question at a time, in a card pinned above the composer** — not a modal, and not
conversation turns. The card is not a message and writes no `message` rows for questions or answers;
it leaves exactly one trace in the transcript, a summary system card posted at terminate. Answers
must never be posted as chat messages: they would then live in both `message` and `form_answer`,
which can disagree, and they would fill the agent transcript with questionnaire noise the context
rail renders properly anyway.

**The storage shape is unchanged by this**, which is why this is a prose reversal and not a schema
one. Append-only `form_answer` rows keyed by `field_key`, each snapshotting its `field_type`, fit
one-at-a-time better than they fit a modal: a modal submits once and could have been a single row,
whereas one-at-a-time writes a row per step and needs exactly that durability. The 2026-08-11 spec's
tables, columns, constraints and composite FKs all stand as written.

Two consequences worth naming, both free of schema cost:

- `form_submission.status` is **derived from the answer rows**, not from which button was pressed.
  With a skip that can land at any point, "submitted with a required field left blank" is not a
  condition that can be evaluated. `completed` = every field in the version has at least one answer;
  `partial` = at least one answer and at least one field with none; `skipped` = zero answers. Partial
  answers survive a skip. `is_required` stays soft either way, because nothing about a form may
  block a player reaching a human.
- The `form_field_type` enum keeps all seven values including `time`. Removing a value from a shipped
  enum is a migration for no gain. No seeded form uses `time`, and the form-builder must offer
  neither `time` nor `attachment`.

See `docs/specs/2026-08-17-player-side-forms-design.md` §1.2–§1.4 and
`docs/plans/2026-08-17-forms-slice-1-data-model-and-seed.md`.

---
```

Note the numbering in this file already contains a duplicated 18–22 block; `23` continues from the
highest number present. Do not renumber the existing entries — other documents cite them.

- [ ] **Step 4: Verify**

Run: `git diff --stat docs/`
Expected: exactly three files changed, no code files.

Read back the three edited passages and confirm: the 2026-08-11 spec still says its schema stands
unchanged, `project-overview.md` no longer asserts a modal, and `spec-contradictions.md` entry 23 is
present with the storage-shape-unchanged paragraph intact.

- [ ] **Step 5: Commit**

```bash
git add docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md \
        docs/project-overview.md docs/decisions/spec-contradictions.md
git commit -m "docs: revert the modal premise for forms, storage shape unchanged"
```

---

## Done when

`pnpm db:setup && pnpm db:seed` yields subintents that resolve to a published form — the slice's own
exit criterion from the design's Slices table. Concretely:

- `pnpm db:setup` applies `0004_forms.sql` and re-runs `002_rls.sql` with the `form_answer` revoke.
- `pnpm db:seed` logs three forms created and twelve subintents mapped; a second run creates none.
- `pnpm test` passes, including `forms.types`, `schema`, `rls`, `forms.dataModel`, `forms.resolve`
  and `seed`.
- `pnpm typecheck` is clean.
- Nothing in `applyBotTurn.ts`, `openapi.ts`, `frontend/` or `shared/jobs/` was touched.

## Not in this slice — named so nobody wonders

`'form'` on the `confirm_phase` enum, the offer branch in `applyBotTurn`, the three
`/surface/form/*` routes, `completeFormAndHandoff`, the `form_offered` / `form_field_answered` /
`form_completed` events, `formTimeout.ts`, `FormCard.tsx`, the `messagesService` wire extension, the
`SupportChat.tsx:168` `confirmPending` narrowing, and the agent-rail `FormPanel`. Slices 2 and 3.

The admin form-builder is out of scope entirely: forms exist through seed data and Drizzle Studio
until that spec lands. It owns authoring, version minting, published-version immutability,
`form.created_by`, archiving, and wiring `form` / `form_version` edits into `change_log`.
