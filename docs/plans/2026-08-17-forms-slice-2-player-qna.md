# Player-side forms — Slice 2 (player Q&A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement slice 2 of `docs/specs/2026-08-17-player-side-forms-design.md` — when the bot hands off on a subintent that has a published form, offer that form as a pinned one-question-at-a-time card above the composer, hold the conversation in `bot_active` until the player submits or skips, and guarantee with a sweeper that nobody is ever stranded there.

**Architecture:** The `handoff` case of `applyBotTurn` splits into two moments. At **offer** it posts the handoff line, classifies, inserts a `form_submission`, sets `conversation.confirm_phase = 'form'` and appends `form_offered` — and deliberately does *not* assign an agent, does *not* set `status = 'open'` and does *not* append `bot_handoff`. At **terminate** a single function, `completeFormAndHandoff`, does all of that plus the derived status, `form_completed` and a summary system card. That function has exactly three callers — `POST /surface/form/submit`, `POST /surface/form/skip`, and the `form-timeout` BullMQ sweeper — so the three cannot drift into different end states. The card is `FormCard.tsx`, rendered in the same slot the resolution banner occupies, driven entirely by the form block that `GET /surface/messages` now returns.

**Tech Stack:** Express 5 + Zod, Drizzle ORM (one `ALTER TYPE … ADD VALUE` migration), Socket.io, BullMQ repeatable job, Vitest + supertest, React + TanStack Query + Tailwind.

## Global Constraints

Copied from the spec and `CLAUDE.md`. Every task's requirements implicitly include this section.

- **The transition is gated.** At offer time the conversation stays `status = 'bot_active'`, `assigned_agent_id` stays null, and **no `bot_handoff` event is written**. Those three things happen only at terminate.
- **`completeFormAndHandoff` has three callers and one transaction shape.** Submit, skip and the sweeper produce byte-identical `form_submission` and `conversation` end states, distinguishable only by `form_completed.terminated_by`.
- **The sweeper is part of this slice, not a follow-up.** Without it the gate strands conversations unassigned, which violates *"nothing may prevent a player reaching a human."*
- **`form_field_answered` carries no answer value.** Payload keys are exactly `form_id`, `field_key`, `field_type`, `position`, `is_correction`. A test asserts the key set exactly, so a later change that adds `value` fails rather than quietly leaking PII into `event`.
- **A form answer is never posted as a chat message.** The card writes no `message` rows for questions or answers. Its only trace in the transcript is the one summary system card posted at terminate.
- **A handoff whose subintent has no form must behave byte-identically to today**: agent assigned, `status = 'open'`, exactly one `bot_handoff` event, `confirm_phase = 'none'`, one posted handoff line, and no new socket emit.
- **`asked_for_person` never offers a form**, even when the subintent resolves to a published form.
- **All state changes go through one function that writes both `conversation` and `event` in one transaction.** Never an ad-hoc update. `appendEvent` is the only writer of `event`.
- **Socket emits happen after the transaction commits, never inside it.**
- **A message with no body is always a bug.** Every summary card string is a non-empty constant; `postMessage` rejects whitespace at the choke point.
- **Player-facing routes may only call `toPlayerView`.** No new serializer, no internal-note path.
- **`event.session_id` is attribution, never a gate.** Any client-supplied session id is confirmed with a scoped `(id, player_id)` select first and degraded to `null` on any miss. A miss never rejects the answer.
- **Every new endpoint is registered in `backend/src/docs/openapi.ts`.**
- **Event payload keys are snake_case**, and payload values are snapshots, never live pointers.
- **`is_required` is soft.** A required field left blank never blocks Next, never blocks submit, never blocks skip.
- **`attachment` is rejected as unsupported** by the answer route; no seeded form uses it.
- **Schema work is limited to adding `'form'` to the `confirm_phase` enum.** The four form tables, `resolveSubintentForm`, `packages/types/src/forms.ts` and the three seeded forms all land in slice 1 and are consumed here as-is.
- **No agent-console work.** The context rail and the queue label are slice 3.
- **Timeout window: 30 minutes.** Sweep interval: every 5 minutes. Both constants live in one file.

---

## What slice 1 is assumed to have landed

This plan does not re-derive any of it. If any of these is missing, stop and finish slice 1 first.

| Thing | Where |
|---|---|
| `form`, `form_version`, `form_submission`, `form_answer` tables + Drizzle schema | `backend/src/shared/db/schema/forms.ts`, exported from `schema/index.ts` |
| `formFieldType`, `formStatus` pg enums | `backend/src/shared/db/schema/enums.ts` |
| `subintent.form_id` composite FK to `form` | `schema/taxonomy.ts` |
| `REVOKE UPDATE ON form_answer FROM support_app` | `backend/src/shared/db/sql/002_rls.sql` |
| `resolveSubintentForm(tx, subintentId): Promise<ResolvedForm \| null>` where `ResolvedForm = { formId, formName, version, fields: FormField[] }` | `backend/src/domain/forms/resolveSubintentForm.ts` |
| `FORM_FIELD_TYPES`, `formFieldSchema`, `formFieldsSchema`, `formAnswerValueSchemas`, `FormField` | `packages/types/src/forms.ts` |
| Three published forms (purchase receipt, bug report, account recovery) mapped to seeded subintents | `backend/src/shared/db/seedForms.ts` |

`FormField` is `{ key: string; label: string; type: FormFieldType; isRequired: boolean; position: number; options?: string[] }`.

---

## Decisions this plan makes that the spec leaves open

Each is a real fork in the road. Implement them as written; they are load-bearing for later tasks.

1. **`form_offered`'s payload carries `handoff_reason`.** The spec pins it to `{ form_id, form_version, field_count }`, but `bot_handoff` must still carry `reason` "as today" and the reason is only known at offer time — by terminate the decision object is long gone, and no column holds it. Event payloads are this repo's snapshot mechanism, so the payload becomes `{ form_id, form_version, field_count, handoff_reason }` and `completeFormAndHandoff` reads it back. If the `form_offered` event cannot be found (impossible by construction), `bot_handoff.reason` is written as `null` rather than fabricated — a null reason is a falsifiable bug signal, and the payload already documents `assigned_agent_id: null` as legitimate. **Recorded in `docs/decisions/spec-contradictions.md` in Task 10.**

2. **`bot_article_rejected` is written in the offer transaction, not deferred.** It records *why* the handoff happened, which is a fact about the bot turn and true at offer time. Deferring it to terminate would make an abandoned form lose the record of the article rejection entirely.

3. **The terminal guard is a `SELECT … FOR UPDATE` inside `completeFormAndHandoff`, not a check in each caller.** Two concurrent submits, or a submit racing the sweeper, must produce exactly one termination. The function returns `null` when the submission is not `in_progress`; the routes map that to `409`, the sweeper skips it silently.

4. **`applyBotTurn`'s result gains `phaseChanged: ConfirmPhaseValue | null`, set only by the form-offer branch.** Every existing branch returns `null`, so no existing path gains a socket emit it did not have — that is what keeps the no-form handoff byte-identical. The orchestrator's `emitApplied` calls `emitPhaseChanged` only when it is non-null.

5. **The sweeper opens one transaction per submission, not one per workspace.** `closeStaleSessions` batches per workspace because it writes one table; this calls a function that assigns agents and posts messages, and one bad row must not roll back and strand every other player in that workspace.

6. **The answer route does not deduplicate identical values.** "Pressing Next on an unchanged prefilled answer writes nothing" is a client rule (§2.5) — the card holds the answers and knows what changed. The server stays dumb, so it has no second opinion about what counts as a correction.

7. **The answer mutation does not invalidate the messages query.** The card owns its own progress and draft state until terminate; a refetch mid-form would remount it. `FormCard` is keyed by `submission_id` so a refetch from any other cause also preserves state.

8. **"Does not re-ask a question already answered on the way forward" (§2.7) means does not re-*post* it.** Navigation stays linear — Next always steps one field forward — and pressing Next over an unchanged prefilled answer fires no request. The test asserts on requests, not on indices.

9. **HTTP status codes** (the spec pins none): `404 not_found` (no conversation for this player), `409 no_form_pending` (no `in_progress` submission), `409 already_terminal` (submit/skip on a terminated submission — same code, different reason string), `422 invalid_request` / `unknown_field` / `invalid_value` / `unsupported_field_type`. This follows `resolutionController`'s `ERRORS` map shape exactly.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `backend/src/shared/db/schema/enums.ts` | modify | `confirmPhase` gains `'form'`; the reservation comment is deleted |
| `backend/drizzle/0005_confirm_phase_form.sql` (+ snapshot/journal) | create | `ALTER TYPE "confirm_phase" ADD VALUE 'form'` |
| `packages/types/src/chat.ts` | modify | `ConfirmPhaseValue` gains `'form'`; `PlayerMessagesResponse.form` |
| `packages/types/src/forms.ts` | modify | `FormAnswerBody`, `FormTerminateBody`, `PlayerFormView`, response types |
| `backend/tests/helpers/db.ts` | modify | `truncateAll` covers the four form tables; `seedForm`, `seedFormSubmission`, `seedFormAnswer`; `seedSubintent` accepts `formId` |
| `backend/src/domain/bot/applyBotTurn.ts` | modify | the offer branch in the `handoff` case; `phaseChanged` on the result |
| `backend/src/domain/bot/orchestrator.ts` | modify | `emitApplied` emits `conversation:phase_changed` when `phaseChanged` is set |
| `backend/src/domain/forms/completeFormAndHandoff.ts` | create | the one terminate transaction, three callers |
| `backend/src/domain/forms/messages.ts` | create | the three summary-card strings, server-owned |
| `backend/src/domain/forms/emitFormTerminated.ts` | create | the one post-commit emit shape, three callers |
| `backend/src/domain/forms/index.ts` | modify | re-export the above |
| `backend/src/surface/services/formService.ts` | create | answer / submit / skip: session verification, resolution, validation, delegate, emit |
| `backend/src/surface/controllers/formController.ts` | create | Zod parse + status codes |
| `backend/src/surface/routers/formRouter.ts` | create | three routes |
| `backend/src/surface/router.ts` | modify | mount `formRouter` |
| `backend/src/surface/services/messagesService.ts` | modify | `form` block on `getPlayerMessages` |
| `backend/src/shared/jobs/formTimeout.ts` | create | `sweepAbandonedForms`, `FORM_TIMEOUT_MINUTES` |
| `backend/src/shared/jobs/queue.ts` | modify | register the `form-timeout` repeatable job |
| `backend/src/docs/openapi.ts` | modify | three new paths |
| `frontend/src/features/chat/api/playerChatApi.ts` | modify | `postFormAnswer`, `submitForm`, `skipForm` |
| `frontend/src/surfaces/webview/components/chat/FormCard.tsx` | create | the pinned card |
| `frontend/src/surfaces/webview/components/chat/FormCard.test.tsx` | create | card behaviour |
| `frontend/src/surfaces/webview/pages/SupportChat.tsx` | modify | `:168` bug fix, card slot, composer disable, mutations |
| `frontend/src/surfaces/webview/pages/SupportChat.test.tsx` | modify | banner/composer/reconnect assertions |
| `backend/tests/forms.offer.test.ts` | create | §2.7 offer block |
| `backend/tests/forms.submission.test.ts` | create | §2.7 submission block |
| `backend/tests/forms.events.test.ts` | create | §2.7 events block |
| `backend/tests/forms.timeout.test.ts` | create | §2.7 timeout block |
| `backend/tests/surface.messages.test.ts` | modify | the `form` block on the read |
| `backend/tests/schema.test.ts` | modify | `confirm_phase` accepts `'form'` |
| `docs/decisions/spec-contradictions.md` | modify | decisions 1 and 9 above |

## Parallelisation

```
Task 1 (enum)  ─┐
Task 2 (types + helpers) ─┴─▶ Task 3 (offer branch) ─┐
                              Task 4 (completeFormAndHandoff) ─┬─▶ Task 5 (routes) ─┬─▶ Task 8 (FormCard) ─┐
                                                               └─▶ Task 7 (sweeper) │   Task 9 (SupportChat) ─┴─▶ Task 10
                                                                   Task 6 (read)  ──┘
```

- **Wave A:** Tasks 1 and 2 in parallel. Task 1 touches `backend/src/shared/db/schema/enums.ts` + `backend/drizzle/`; Task 2 touches `packages/types/` + `backend/tests/helpers/db.ts`. No overlap.
- **Wave B:** Tasks 3 and 4 in parallel. Task 3 owns `domain/bot/*`; Task 4 owns `domain/forms/*`. No overlap.
- **Wave C:** Tasks 5, 6, 7. Task 5 owns `surface/{routers,controllers,services}/form*.ts`, `surface/router.ts`, `docs/openapi.ts`; Task 6 owns `surface/services/messagesService.ts`; Task 7 owns `shared/jobs/*`. No overlap.
- **Wave D:** Tasks 8 and 9 — 9 imports the component 8 creates, so run 8 first or in the same session.
- **Wave E:** Task 10 alone.

Every task leaves `pnpm typecheck` and `pnpm test` green. Postgres and Redis must be up for the backend suite (`pnpm dev` brings them up, or `docker compose up -d`). Run `pnpm db:setup` after Task 1.

---

### Task 1: `confirm_phase` gains `'form'`

**Files:**
- Modify: `backend/src/shared/db/schema/enums.ts:30-33`
- Create: `backend/drizzle/0005_confirm_phase_form.sql` (+ the generated `meta/` snapshot and journal entry)
- Test: `backend/tests/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the pg enum value `'form'` on type `confirm_phase`, writable to `conversation.confirm_phase`.

> The migration index assumes slice 1 landed the forms tables as `0004`. If the highest existing file is a different number, use the next free one and keep the `confirm_phase_form` suffix.

- [ ] **Step 1: Write the failing test**

Append to the `conversation` describe block in `backend/tests/schema.test.ts`:

```ts
  it('conversation.confirm_phase accepts form', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const { rows } = await ownerPool.query<{ confirm_phase: string }>(
      `insert into conversation (workspace_id, player_id, confirm_phase)
       values ($1, $2, 'form') returning confirm_phase`,
      [workspaceId, playerId],
    )
    expect(rows[0]!.confirm_phase).toBe('form')
  })
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @support/backend test schema.test.ts -t 'accepts form'`
Expected: FAIL with `invalid input value for enum confirm_phase: "form"`.

- [ ] **Step 3: Add the value to the Drizzle enum**

In `backend/src/shared/db/schema/enums.ts`, replace the `confirmPhase` block (the comment and the `pgEnum` call) with:

```ts
// `bot_article` is set by the bot's answer_from_article, `agent_ask` by
// POST /agent/conversations/:id/ask-resolved — both mean a yes/no question is on
// the player's screen. `form` means the pinned form card is up instead: not a
// yes/no, and the reason the webview must branch on the value rather than test
// it against 'none'. See docs/specs/2026-08-17-player-side-forms-design.md §2.4.
export const confirmPhase = pgEnum('confirm_phase', ['none', 'bot_article', 'agent_ask', 'form'])
```

- [ ] **Step 4: Generate and inspect the migration**

Run: `pnpm db:generate`

It should produce a file whose only statement is the `ADD VALUE`. Rename it to `0005_confirm_phase_form.sql` (updating the `tag` in `backend/drizzle/meta/_journal.json` to match) and confirm its contents are exactly:

```sql
ALTER TYPE "public"."confirm_phase" ADD VALUE 'form';
```

`0002_confirm_phase.sql` is the precedent — `ADD VALUE` inside the migration transaction is fine on PG 17 as long as nothing in the same transaction *uses* the new value, and nothing here does.

- [ ] **Step 5: Apply and re-run**

Run: `pnpm db:setup && pnpm --filter @support/backend test schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/shared/db/schema/enums.ts backend/drizzle backend/tests/schema.test.ts
git commit -m "feat(forms): add 'form' to the confirm_phase enum"
```

---

### Task 2: Wire types and test helpers

**Files:**
- Modify: `packages/types/src/chat.ts:59-65,100`
- Modify: `packages/types/src/forms.ts`
- Modify: `backend/tests/helpers/db.ts:11-26,169-183`
- Test: `packages/types` has no suite of its own; verification is `pnpm typecheck` plus the helpers being exercised from Task 3 onward.

**Interfaces:**
- Consumes: `FormField`, `FormFieldType` from slice 1's `packages/types/src/forms.ts`.
- Produces:
  - `ConfirmPhaseValue = 'none' | 'bot_article' | 'agent_ask' | 'form'`
  - `PlayerMessagesResponse.form: PlayerFormView | null`
  - `PlayerFormView = { submission_id: string; form_id: string; form_name: string; version: number; fields: FormField[]; answers: PlayerFormAnswerView[] }`
  - `PlayerFormAnswerView = { field_key: string; value: unknown }`
  - `FormAnswerBody` (Zod), `FormTerminateBody` (Zod)
  - `FormAnswerResponse = { ok: true; is_correction: boolean }`
  - `FormTerminateResponse = { confirm_phase: 'none'; status: ConversationStatusValue; form_status: FormSubmissionStatus }`
  - `FormSubmissionStatus = 'in_progress' | 'completed' | 'partial' | 'skipped'`
  - test helpers `seedForm`, `seedFormSubmission`, `seedFormAnswer`; `seedSubintent` accepts `formId`

- [ ] **Step 1: Widen `ConfirmPhaseValue` and the messages response**

In `packages/types/src/chat.ts`, replace the `ConfirmPhaseValue` declaration:

```ts
export type ConfirmPhaseValue = 'none' | 'bot_article' | 'agent_ask' | 'form'
```

and extend `PlayerMessagesResponse`:

```ts
export type PlayerMessagesResponse = {
  conversation_id: string | null
  messages: PlayerMessageView[]
  status?: ConversationStatusValue
  /** 'none' when there is no conversation at all. */
  confirm_phase: ConfirmPhaseValue
  /**
   * The pinned form card's whole state, or null. Always present, never
   * undefined — the same rule confirm_phase follows, so the card has one thing
   * to test. Non-null only when confirm_phase === 'form' and an in_progress
   * submission still exists; a reconnect therefore resumes at the right
   * question with earlier answers intact.
   */
  form: PlayerFormView | null
}
```

Add the import at the top of `chat.ts`:

```ts
import type { PlayerFormView } from './forms.ts'
```

- [ ] **Step 2: Add the player-facing form contract**

Append to `packages/types/src/forms.ts`:

```ts
export type FormSubmissionStatus = 'in_progress' | 'completed' | 'partial' | 'skipped'

/** The latest answer for a field. Older rows are history and never reach a player. */
export type PlayerFormAnswerView = { field_key: string; value: unknown }

/**
 * Everything the pinned card needs to render from cold, including a reconnect
 * mid-form. `fields` comes from the submission's snapshotted version, never the
 * current one, so a form edited to v2 does not renumber a v1 card mid-answer.
 */
export type PlayerFormView = {
  submission_id: string
  form_id: string
  form_name: string
  version: number
  fields: FormField[]
  answers: PlayerFormAnswerView[]
}

/**
 * `value` is `unknown` on the wire on purpose: which schema validates it depends
 * on the resolved field's declared type, which only the server can look up.
 * `session_id` is best-effort attribution — verified server-side, degraded to
 * null on any miss, and never a gate on the answer being accepted.
 */
export const FormAnswerBody = z.object({
  field_key: z.string().min(1).max(64),
  value: z.unknown(),
  session_id: z.uuid().optional(),
})

/** Submit and skip carry nothing but attribution. Which one was called is the whole difference. */
export const FormTerminateBody = z.object({ session_id: z.uuid().optional() })

export type FormAnswerResponse = { ok: true; is_correction: boolean }

export type FormTerminateResponse = {
  confirm_phase: 'none'
  status: ConversationStatusValue
  form_status: Exclude<FormSubmissionStatus, 'in_progress'>
}
```

Add to the imports at the top of `forms.ts`:

```ts
import type { ConversationStatusValue } from './chat.ts'
```

(`z` is already imported by slice 1. The two files import types from each other; that is fine — `import type` is erased and creates no runtime cycle.)

- [ ] **Step 3: Extend the test helpers**

In `backend/tests/helpers/db.ts`, add the four form tables to `SCOPED_TABLES` — children before parents, though `cascade` makes the order cosmetic:

```ts
const SCOPED_TABLES = [
  'change_log',
  'bot_config',
  'form_answer',
  'form_submission',
  'form_version',
  'form',
  'event',
  'message',
  'conversation',
  // …unchanged from here down
]
```

(Slice 1 may already have done this. If the four names are present, leave them alone.)

Give `seedSubintent` a `formId`:

```ts
export async function seedSubintent(args: {
  workspaceId: string
  intentId: string
  name?: string
  formId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(
    `insert into subintent (id, workspace_id, intent_id, name, form_id) values ($1, $2, $3, $4, $5)`,
    [id, args.workspaceId, args.intentId, args.name ?? `Subintent ${id.slice(0, 8)}`, args.formId ?? null],
  )
  return id
}
```

> Keep the existing column list and defaults from the current implementation; only `form_id` is new. If the current body inserts a different set of columns, add `form_id` to it rather than replacing the statement wholesale.

Append the three new helpers:

```ts
export type SeedFormField = {
  key: string
  label: string
  type: string
  isRequired: boolean
  position: number
  options?: string[]
}

/**
 * One form and one version. `publishedAt: null` seeds a draft, which
 * resolveSubintentForm must treat as "no form" — the null path is the one the
 * offer branch takes most often in production.
 */
export async function seedForm(args: {
  workspaceId: string
  name?: string
  fields: SeedFormField[]
  version?: number
  published?: boolean
  archivedAt?: Date | null
}): Promise<{ formId: string; version: number }> {
  const formId = randomUUID()
  await ownerPool.query(
    `insert into form (id, workspace_id, name, archived_at) values ($1, $2, $3, $4)`,
    [formId, args.workspaceId, args.name ?? `Form ${formId.slice(0, 8)}`, args.archivedAt ?? null],
  )
  const version = args.version ?? 1
  await ownerPool.query(
    `insert into form_version (id, workspace_id, form_id, version, fields, published_at)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [randomUUID(), args.workspaceId, formId, version, JSON.stringify(args.fields), args.published === false ? null : new Date()],
  )
  return { formId, version }
}

/** Adds a version to a form that already exists — for the v1-vs-v2 snapshot tests. */
export async function seedFormVersion(args: {
  workspaceId: string
  formId: string
  version: number
  fields: SeedFormField[]
  published?: boolean
}): Promise<void> {
  await ownerPool.query(
    `insert into form_version (id, workspace_id, form_id, version, fields, published_at)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [randomUUID(), args.workspaceId, args.formId, args.version, JSON.stringify(args.fields), args.published === false ? null : new Date()],
  )
}

export async function seedFormSubmission(args: {
  workspaceId: string
  conversationId: string
  formId: string
  version: number
  status?: string
  startedAt?: Date
}): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(
    `insert into form_submission (id, workspace_id, conversation_id, form_id, form_version, status, started_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, args.workspaceId, args.conversationId, args.formId, args.version, args.status ?? 'in_progress', args.startedAt ?? new Date()],
  )
  return id
}

export async function seedFormAnswer(args: {
  workspaceId: string
  submissionId: string
  fieldKey: string
  fieldType: string
  value: unknown
  createdAt?: Date
}): Promise<void> {
  await ownerPool.query(
    `insert into form_answer (id, workspace_id, form_submission_id, field_key, field_type, value, created_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [randomUUID(), args.workspaceId, args.submissionId, args.fieldKey, args.fieldType, JSON.stringify(args.value), args.createdAt ?? new Date()],
  )
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. If `messagesService.ts` errors because `PlayerMessagesResponse.form` is now required, add `form: null` to both of its return statements — Task 6 replaces the non-trivial one.

- [ ] **Step 5: Commit**

```bash
git add packages/types backend/tests/helpers/db.ts backend/src/surface/services/messagesService.ts
git commit -m "feat(forms): player-facing form wire types and test seed helpers"
```

---

### Task 3: The offer branch in `applyBotTurn`

**Files:**
- Modify: `backend/src/domain/bot/applyBotTurn.ts:16-19,79-115`
- Modify: `backend/src/domain/bot/orchestrator.ts:50-73`
- Test: `backend/tests/forms.offer.test.ts` (create)

**Interfaces:**
- Consumes: `resolveSubintentForm(tx, subintentId)` from slice 1; `formSubmission` from `shared/db/schema`.
- Produces: `ApplyBotTurnResult = { posted: PostedMessageRow[]; statusChanged: boolean; phaseChanged: ConfirmPhaseValue | null }`; the `form_offered` event with payload `{ form_id, form_version, field_count, handoff_reason }`.

- [ ] **Step 1: Write the failing test file**

Create `backend/tests/forms.offer.test.ts`. Model the harness on `backend/tests/bot.assignment.test.ts` — it already drives `applyBotTurn` directly inside `withWorkspace`.

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { conversation, event, formSubmission, message } from '../src/shared/db/schema/index.ts'
import { applyBotTurn } from '../src/domain/bot/applyBotTurn.ts'
import type { HandoffReason } from '../src/domain/bot/botTurn.ts'
import {
  closeOwnerPool,
  seedAgent,
  seedConversation,
  seedForm,
  seedIntent,
  seedPlayer,
  seedSubintent,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts'

const FIELDS = [
  { key: 'store', label: 'Store', type: 'choice', isRequired: true, position: 0, options: ['Apple App Store', 'Google Play'] },
  { key: 'order_id', label: 'Order or receipt ID', type: 'short_text', isRequired: true, position: 1 },
]

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

/** A workspace with one active agent, so "no agent was assigned" is a real assertion. */
async function fixture(options: { withForm: boolean; publishForm?: boolean } = { withForm: true }) {
  const workspaceId = await seedWorkspace()
  const agentId = await seedAgent()
  await seedWorkspaceMember({ workspaceId, agentId })
  const playerId = await seedPlayer(workspaceId)
  const conversationId = await seedConversation({ workspaceId, playerId })
  const intentId = await seedIntent(workspaceId)
  let formId: string | null = null
  if (options.withForm) {
    const form = await seedForm({ workspaceId, fields: FIELDS, published: options.publishForm !== false })
    formId = form.formId
  }
  const subintentId = await seedSubintent({ workspaceId, intentId, formId })
  return { workspaceId, agentId, playerId, conversationId, subintentId, formId }
}

async function handoff(
  workspaceId: string,
  conversationId: string,
  reason: HandoffReason,
  subintentId: string | null,
) {
  return withWorkspace(workspaceId, (tx) =>
    applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'handoff', reason, subintentId }),
  )
}

async function read(workspaceId: string, conversationId: string) {
  return withWorkspace(workspaceId, async (tx) => {
    const [conv] = await tx.select().from(conversation).where(eq(conversation.id, conversationId))
    const events = await tx.select().from(event).where(eq(event.conversationId, conversationId))
    const messages = await tx.select().from(message).where(eq(message.conversationId, conversationId))
    const submissions = await tx.select().from(formSubmission).where(eq(formSubmission.conversationId, conversationId))
    return { conv: conv!, events, messages, submissions }
  })
}

describe('the form offer at handoff', () => {
  it('holds the conversation in bot_active with no agent and no bot_handoff event', async () => {
    const f = await fixture()
    const result = await handoff(f.workspaceId, f.conversationId, 'article_rejected', f.subintentId)

    const { conv, events, messages, submissions } = await read(f.workspaceId, f.conversationId)
    expect(conv.status).toBe('bot_active')
    expect(conv.assignedAgentId).toBeNull()
    expect(conv.confirmPhase).toBe('form')
    expect(events.filter((e) => e.type === 'bot_handoff')).toHaveLength(0)
    expect(submissions).toHaveLength(1)
    expect(submissions[0]!.status).toBe('in_progress')
    expect(submissions[0]!.submittedAt).toBeNull()
    // The handoff line is posted at the moment the handoff is decided, not at terminate.
    expect(messages.filter((m) => m.authorType === 'system')).toHaveLength(1)
    expect(result.statusChanged).toBe(false)
    expect(result.phaseChanged).toBe('form')
  })

  it('writes one form_offered carrying the version, the field count and the reason', async () => {
    const f = await fixture()
    await handoff(f.workspaceId, f.conversationId, 'no_article', f.subintentId)

    const { events } = await read(f.workspaceId, f.conversationId)
    const offered = events.filter((e) => e.type === 'form_offered')
    expect(offered).toHaveLength(1)
    expect(offered[0]!.actorType).toBe('bot')
    expect(offered[0]!.actorId).toBeNull()
    expect(offered[0]!.payload).toEqual({
      form_id: f.formId,
      form_version: 1,
      field_count: 2,
      handoff_reason: 'no_article',
    })
  })

  it('still records the article rejection in the offer transaction', async () => {
    const f = await fixture()
    await handoff(f.workspaceId, f.conversationId, 'article_rejected', f.subintentId)
    const { events } = await read(f.workspaceId, f.conversationId)
    expect(events.filter((e) => e.type === 'bot_article_rejected')).toHaveLength(1)
  })

  it.each(['no_article', 'sensitive', 'article_rejected'] as const)('offers a form on %s', async (reason) => {
    const f = await fixture()
    await handoff(f.workspaceId, f.conversationId, reason, f.subintentId)
    const { conv, submissions } = await read(f.workspaceId, f.conversationId)
    expect(conv.confirmPhase).toBe('form')
    expect(submissions).toHaveLength(1)
  })

  it('never offers a form on asked_for_person, even when the subintent resolves to one', async () => {
    const f = await fixture()
    await handoff(f.workspaceId, f.conversationId, 'asked_for_person', f.subintentId)
    const { conv, submissions, events } = await read(f.workspaceId, f.conversationId)
    expect(submissions).toHaveLength(0)
    expect(conv.confirmPhase).toBe('none')
    expect(conv.status).toBe('open')
    expect(events.filter((e) => e.type === 'bot_handoff')).toHaveLength(1)
  })

  it('offers no form when the subintent is null', async () => {
    const f = await fixture()
    await handoff(f.workspaceId, f.conversationId, 'turn_cap', null)
    const { conv, submissions } = await read(f.workspaceId, f.conversationId)
    expect(submissions).toHaveLength(0)
    expect(conv.status).toBe('open')
  })

  it('offers no form when the subintent has only a draft version', async () => {
    const f = await fixture({ withForm: true, publishForm: false })
    await handoff(f.workspaceId, f.conversationId, 'no_article', f.subintentId)
    const { conv, submissions } = await read(f.workspaceId, f.conversationId)
    expect(submissions).toHaveLength(0)
    expect(conv.status).toBe('open')
  })

  // The regression that matters most.
  it('a handoff whose subintent has no form behaves exactly as it does today', async () => {
    const f = await fixture({ withForm: false })
    const result = await handoff(f.workspaceId, f.conversationId, 'no_article', f.subintentId)

    const { conv, events, messages, submissions } = await read(f.workspaceId, f.conversationId)
    expect(submissions).toHaveLength(0)
    expect(conv.status).toBe('open')
    expect(conv.confirmPhase).toBe('none')
    expect(conv.assignedAgentId).toBe(f.agentId)
    const handoffs = events.filter((e) => e.type === 'bot_handoff')
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]!.payload).toEqual({ reason: 'no_article', assigned_agent_id: f.agentId })
    expect(messages).toHaveLength(1)
    expect(result.statusChanged).toBe(true)
    expect(result.phaseChanged).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @support/backend test forms.offer.test.ts`
Expected: FAIL — `phaseChanged` does not exist on the result, and every offer assertion fails because the branch is not written.

- [ ] **Step 3: Add `phaseChanged` to the result type**

In `backend/src/domain/bot/applyBotTurn.ts`, replace the result type:

```ts
export type ApplyBotTurnResult = {
  posted: PostedMessageRow[]
  statusChanged: boolean
  /**
   * Non-null only when this turn moved confirm_phase in a way a client must be
   * told about out of band. Today that is exactly one case: the form offer,
   * which changes no status and so triggers no other refetch on the agent side.
   * Every other branch returns null deliberately — adding an emit to a path
   * that never had one is a behaviour change, and the no-form handoff must stay
   * byte-identical.
   */
  phaseChanged: ConfirmPhaseValue | null
}
```

Add `phaseChanged: null` to the `noop`, `answer`, `resolve`, `unavailable` returns and to the existing `handoff` return. Add the imports:

```ts
import type { ConfirmPhaseValue } from '@support/types'
import { resolveSubintentForm } from '../forms/resolveSubintentForm.ts'
import { formSubmission } from '../../shared/db/schema/index.ts'
```

- [ ] **Step 4: Write the offer branch**

In the `handoff` case, immediately after the `classifyIfUnset` call and **before** `assignOnHandoff`, insert:

```ts
      // The offer branch. Everything after this block is today's behaviour,
      // untouched — a subintent with no published form falls straight through.
      //
      // `asked_for_person` is excluded explicitly: the product spec requires an
      // immediate redirect to an agent, and four questions in front of someone
      // who just asked for a human is the behaviour that rule forbids. The other
      // two exclusions need no special case — `turn_cap` carries a null
      // subintent, and `unavailable` is a different decision kind entirely.
      if (decision.subintentId && decision.reason !== 'asked_for_person') {
        const resolved = await resolveSubintentForm(tx, decision.subintentId)
        if (resolved) {
          await tx.insert(formSubmission).values({
            workspaceId: ctx.workspaceId,
            conversationId: ctx.conversationId,
            formId: resolved.formId,
            formVersion: resolved.version,
          })
          await tx
            .update(conversation)
            .set({ confirmPhase: 'form' })
            .where(eq(conversation.id, ctx.conversationId))

          // Written here rather than deferred to terminate: it records why the
          // handoff happened, which is a fact about this turn. A form the player
          // abandons would otherwise lose the record of the rejection entirely.
          if (decision.reason === 'article_rejected') {
            await appendEvent(tx, {
              workspaceId: ctx.workspaceId,
              type: 'bot_article_rejected',
              conversationId: ctx.conversationId,
              actorId: null,
              actorType: 'bot',
              payload: {},
            })
          }

          // `handoff_reason` is here because `bot_handoff` still has to carry it
          // at terminate, and by then the decision is gone and no column holds
          // it. A snapshot in the event that explains the offer is this repo's
          // mechanism for exactly that. See the plan's decision 1.
          await appendEvent(tx, {
            workspaceId: ctx.workspaceId,
            type: 'form_offered',
            conversationId: ctx.conversationId,
            actorId: null,
            actorType: 'bot',
            payload: {
              form_id: resolved.formId,
              form_version: resolved.version,
              field_count: resolved.fields.length,
              handoff_reason: decision.reason,
            },
          })

          // Status stays bot_active, no agent is assigned, and no bot_handoff is
          // written. completeFormAndHandoff does all three at terminate — that
          // gate is what keeps a half-filled ticket out of the queue.
          return { posted: [posted], statusChanged: false, phaseChanged: 'form' }
        }
      }
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @support/backend test forms.offer.test.ts`
Expected: PASS.

- [ ] **Step 6: Emit the phase change from the orchestrator**

In `backend/src/domain/bot/orchestrator.ts`, widen `emitApplied`'s parameter and add the emit:

```ts
function emitApplied(
  workspaceId: string,
  conversationId: string,
  result: { posted: PostedMessageRow[]; statusChanged: boolean; phaseChanged: ConfirmPhaseValue | null },
): void {
  // …unchanged getIo() try/catch…

  for (const row of result.posted) {
    emitMessageToRooms(io, conversationId, toPlayerView(row), toAgentView(row))
  }
  // The form offer changes no status, so `conversation:changed` says nothing and
  // the agent rail would never learn the card went up. Only the offer sets this.
  if (result.phaseChanged) {
    emitPhaseChanged(io, conversationId, { conversation_id: conversationId, confirm_phase: result.phaseChanged })
  }
  if (result.statusChanged) {
    emitInboxChanged(io, workspaceId, conversationId, 'open')
  }
}
```

Update the import to include `emitPhaseChanged`, and widen `ApplyIfBotActiveResult`'s `applied: true` member to carry `phaseChanged: ConfirmPhaseValue | null`.

- [ ] **Step 7: Run the bot suite for regressions**

Run: `pnpm --filter @support/backend test bot. && pnpm typecheck`
Expected: PASS. `bot.turnSeam.test.ts`, `bot.assignment.test.ts` and `jobs.botTurns.test.ts` all drive `applyBotTurn` and must be untouched by this change.

- [ ] **Step 8: Commit**

```bash
git add backend/src/domain/bot backend/tests/forms.offer.test.ts
git commit -m "feat(forms): offer a form at handoff and gate the status transition"
```

---

### Task 4: `completeFormAndHandoff`

**Files:**
- Create: `backend/src/domain/forms/completeFormAndHandoff.ts`
- Create: `backend/src/domain/forms/messages.ts`
- Create: `backend/src/domain/forms/emitFormTerminated.ts`
- Modify: `backend/src/domain/forms/index.ts`
- Test: `backend/tests/forms.submission.test.ts` (create — the derivation half; the route half arrives in Task 5)

**Interfaces:**
- Consumes: `assignOnHandoff(tx, workspaceId)`, `postMessage(tx, …)`, `appendEvent(tx, …)`.
- Produces:
  ```ts
  export type FormTerminationReason = 'submit' | 'skip' | 'timeout'
  export type CompleteFormResult = {
    formStatus: 'completed' | 'partial' | 'skipped'
    answeredCount: number
    fieldCount: number
    assignedAgentId: string | null
    posted: PostedMessageRow
    conversationId: string
  }
  export async function completeFormAndHandoff(
    tx: Tx,
    ctx: {
      workspaceId: string
      conversationId: string
      submissionId: string
      actorType: 'player' | 'system'
      actorId: string | null
      sessionId: string | null
    },
    terminatedBy: FormTerminationReason,
  ): Promise<CompleteFormResult | null>
  export function emitFormTerminated(workspaceId: string, result: CompleteFormResult): void
  export function formSummaryMessage(status: 'completed' | 'partial' | 'skipped'): string
  ```

- [ ] **Step 1: Write the failing test**

Create `backend/tests/forms.submission.test.ts` with the derivation block. (Task 5 appends the route block to this same file.)

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { conversation, event, formSubmission, message } from '../src/shared/db/schema/index.ts'
import { completeFormAndHandoff } from '../src/domain/forms/completeFormAndHandoff.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedForm,
  seedFormAnswer,
  seedFormSubmission,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts'

const FIELDS = [
  { key: 'a', label: 'A', type: 'short_text', isRequired: true, position: 0 },
  { key: 'b', label: 'B', type: 'short_text', isRequired: false, position: 1 },
  { key: 'c', label: 'C', type: 'short_text', isRequired: false, position: 2 },
  { key: 'd', label: 'D', type: 'short_text', isRequired: false, position: 3 },
]

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function offered(answers: string[]) {
  const workspaceId = await seedWorkspace()
  const agentId = await seedAgent()
  await seedWorkspaceMember({ workspaceId, agentId })
  const playerId = await seedPlayer(workspaceId)
  const conversationId = await seedConversation({ workspaceId, playerId })
  await ownerPool.query(`update conversation set confirm_phase = 'form' where id = $1`, [conversationId])
  const { formId, version } = await seedForm({ workspaceId, fields: FIELDS })
  const submissionId = await seedFormSubmission({ workspaceId, conversationId, formId, version })
  // The offer event the terminate step reads the handoff reason back out of.
  await ownerPool.query(
    `insert into event (workspace_id, type, conversation_id, actor_type, payload)
     values ($1, 'form_offered', $2, 'bot', $3::jsonb)`,
    [workspaceId, conversationId, JSON.stringify({ form_id: formId, form_version: version, field_count: 4, handoff_reason: 'no_article' })],
  )
  for (const key of answers) {
    await seedFormAnswer({ workspaceId, submissionId, fieldKey: key, fieldType: 'short_text', value: 'x' })
  }
  return { workspaceId, agentId, playerId, conversationId, submissionId }
}

function terminate(f: Awaited<ReturnType<typeof offered>>, by: 'submit' | 'skip' | 'timeout') {
  return withWorkspace(f.workspaceId, (tx) =>
    completeFormAndHandoff(
      tx,
      {
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
        submissionId: f.submissionId,
        actorType: by === 'timeout' ? 'system' : 'player',
        actorId: by === 'timeout' ? null : f.playerId,
        sessionId: null,
      },
      by,
    ),
  )
}

describe('completeFormAndHandoff', () => {
  it('derives completed when every field has an answer', async () => {
    const f = await offered(['a', 'b', 'c', 'd'])
    const result = await terminate(f, 'submit')
    expect(result!.formStatus).toBe('completed')
    expect(result!.answeredCount).toBe(4)
    expect(result!.fieldCount).toBe(4)
  })

  it('derives partial when some fields are answered and keeps the answers', async () => {
    const f = await offered(['a', 'b'])
    const result = await terminate(f, 'skip')
    expect(result!.formStatus).toBe('partial')
    expect(result!.answeredCount).toBe(2)
    const rows = await withWorkspace(f.workspaceId, (tx) => tx.select().from(formSubmission))
    expect(rows[0]!.status).toBe('partial')
    const { rows: answers } = await ownerPool.query(`select field_key from form_answer order by field_key`)
    expect(answers.map((r) => r.field_key)).toEqual(['a', 'b'])
  })

  it('derives skipped when there are no answers at all', async () => {
    const f = await offered([])
    const result = await terminate(f, 'skip')
    expect(result!.formStatus).toBe('skipped')
    expect(result!.answeredCount).toBe(0)
  })

  it('counts distinct field keys, not answer rows, when a field was corrected', async () => {
    const f = await offered(['a', 'a', 'b'])
    const result = await terminate(f, 'submit')
    expect(result!.answeredCount).toBe(2)
    expect(result!.formStatus).toBe('partial')
  })

  it('assigns an agent, opens the conversation and clears the phase', async () => {
    const f = await offered(['a', 'b', 'c', 'd'])
    await terminate(f, 'submit')
    const [conv] = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, f.conversationId)),
    )
    expect(conv!.status).toBe('open')
    expect(conv!.confirmPhase).toBe('none')
    expect(conv!.assignedAgentId).toBe(f.agentId)
  })

  it('writes exactly one bot_handoff carrying the reason from the offer, and one form_completed', async () => {
    const f = await offered(['a'])
    await terminate(f, 'timeout')
    const events = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.conversationId, f.conversationId)),
    )
    const handoffs = events.filter((e) => e.type === 'bot_handoff')
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]!.payload).toEqual({ reason: 'no_article', assigned_agent_id: f.agentId })
    const completed = events.filter((e) => e.type === 'form_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]!.actorType).toBe('system')
    expect(completed[0]!.actorId).toBeNull()
    expect(completed[0]!.payload).toEqual({
      status: 'partial',
      terminated_by: 'timeout',
      answered_count: 1,
      field_count: 4,
    })
  })

  it('posts exactly one non-empty summary card and no other message', async () => {
    const f = await offered([])
    await terminate(f, 'skip')
    const rows = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(message).where(eq(message.conversationId, f.conversationId)),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.authorType).toBe('system')
    expect(rows[0]!.visibility).toBe('public')
    expect(rows[0]!.body.trim().length).toBeGreaterThan(0)
  })

  it('returns null on a second call and writes nothing the second time', async () => {
    const f = await offered(['a'])
    await terminate(f, 'submit')
    const second = await terminate(f, 'skip')
    expect(second).toBeNull()
    const events = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.conversationId, f.conversationId)),
    )
    expect(events.filter((e) => e.type === 'bot_handoff')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'form_completed')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @support/backend test forms.submission.test.ts`
Expected: FAIL with `Cannot find module '../src/domain/forms/completeFormAndHandoff.ts'`.

- [ ] **Step 3: Write the summary copy**

Create `backend/src/domain/forms/messages.ts`:

```ts
/**
 * The one trace the card leaves in the transcript. Server-owned for the same
 * reason HANDOFF_PLAYER_MESSAGES is: no prompt edit and no player-injected
 * instruction may rewrite what the player is told about their own handoff.
 *
 * A map keyed by outcome rather than a random pick, because unlike the handoff
 * line these three are not interchangeable — the whole point is that the player
 * can see which of the three happened. None promises a wait, none apologises,
 * and none is empty: postMessage refuses a blank body at the choke point, and a
 * blank system card would record nothing anywhere.
 */
const FORM_SUMMARY_MESSAGES = {
  completed: "Thanks — your answers are with the team now.",
  partial: "Thanks — what you answered is with the team now.",
  skipped: "No problem — this is with the team now.",
} as const

export function formSummaryMessage(status: keyof typeof FORM_SUMMARY_MESSAGES): string {
  return FORM_SUMMARY_MESSAGES[status]
}
```

- [ ] **Step 4: Write `completeFormAndHandoff`**

Create `backend/src/domain/forms/completeFormAndHandoff.ts`:

```ts
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Tx } from '../../shared/db/withWorkspace.ts'
import { conversation, event, formAnswer, formSubmission, formVersion } from '../../shared/db/schema/index.ts'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { assignOnHandoff } from '../bot/assignOnHandoff.ts'
import { postMessage, type PostedMessageRow } from '../conversations/postMessage.ts'
import { formSummaryMessage } from './messages.ts'

export type FormTerminationReason = 'submit' | 'skip' | 'timeout'
export type TerminalFormStatus = 'completed' | 'partial' | 'skipped'

export type CompleteFormContext = {
  workspaceId: string
  conversationId: string
  submissionId: string
  /** 'player' for submit and skip; 'system' with a null actor for the sweeper. */
  actorType: 'player' | 'system'
  actorId: string | null
  sessionId: string | null
}

export type CompleteFormResult = {
  conversationId: string
  formStatus: TerminalFormStatus
  answeredCount: number
  fieldCount: number
  assignedAgentId: string | null
  posted: PostedMessageRow
}

/**
 * The terminal half of the split handoff, and the only writer of it. Three
 * callers — POST /surface/form/submit, POST /surface/form/skip, and the
 * form-timeout sweeper — share this one transaction shape, so a form the player
 * skipped and a form the sweeper closed reach an identical end state and differ
 * only in `form_completed.terminated_by`. That is deliberate: the two need
 * opposite fixes, and the difference has to be a fact on a row rather than
 * something inferred from what is absent.
 *
 * Returns null when the submission is not in_progress. The guard is a
 * SELECT … FOR UPDATE inside this transaction rather than a check in each
 * caller, so a submit racing the sweeper serialises instead of double-writing.
 *
 * The caller owns the transaction and must call emitFormTerminated only after it
 * commits.
 */
export async function completeFormAndHandoff(
  tx: Tx,
  ctx: CompleteFormContext,
  terminatedBy: FormTerminationReason,
): Promise<CompleteFormResult | null> {
  const [submission] = await tx
    .select({
      id: formSubmission.id,
      status: formSubmission.status,
      formId: formSubmission.formId,
      formVersion: formSubmission.formVersion,
    })
    .from(formSubmission)
    .where(and(eq(formSubmission.id, ctx.submissionId), eq(formSubmission.conversationId, ctx.conversationId)))
    .for('update')
    .limit(1)

  if (!submission || submission.status !== 'in_progress') return null

  const [version] = await tx
    .select({ fields: formVersion.fields })
    .from(formVersion)
    .where(and(eq(formVersion.formId, submission.formId), eq(formVersion.version, submission.formVersion)))
    .limit(1)
  const fieldCount = version?.fields.length ?? 0

  // Distinct keys, never row count: a corrected field is two rows and one
  // answered question, and the snapshot on form_completed has to say the latter.
  const answeredRows = await tx
    .selectDistinct({ fieldKey: formAnswer.fieldKey })
    .from(formAnswer)
    .where(eq(formAnswer.formSubmissionId, submission.id))
  const answeredCount = answeredRows.length

  // §1.3: status records the outcome, not the button. Which action terminated
  // the submission is a fact about the turn and lives in form_completed.
  const formStatus: TerminalFormStatus =
    answeredCount === 0 ? 'skipped' : fieldCount > 0 && answeredCount >= fieldCount ? 'completed' : 'partial'

  await tx
    .update(formSubmission)
    .set({ status: formStatus, submittedAt: new Date() })
    .where(eq(formSubmission.id, submission.id))

  const assignedAgentId = await assignOnHandoff(tx, ctx.workspaceId)
  await tx
    .update(conversation)
    .set({ status: 'open', confirmPhase: 'none', assignedAgentId })
    .where(eq(conversation.id, ctx.conversationId))

  // The reason belongs to the bot turn that offered the form, so it is read back
  // from that turn's own snapshot. Null rather than a guess if the event is
  // missing: a null reason is a visible bug, an invented one is not.
  const [offer] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.conversationId, ctx.conversationId), eq(event.type, 'form_offered')))
    .orderBy(desc(event.occurredAt))
    .limit(1)
  const reason = (offer?.payload as { handoff_reason?: string } | undefined)?.handoff_reason ?? null

  await appendEvent(tx, {
    workspaceId: ctx.workspaceId,
    type: 'bot_handoff',
    conversationId: ctx.conversationId,
    actorId: null,
    actorType: 'bot',
    payload: { reason, assigned_agent_id: assignedAgentId },
  })

  await appendEvent(tx, {
    workspaceId: ctx.workspaceId,
    type: 'form_completed',
    conversationId: ctx.conversationId,
    sessionId: ctx.sessionId,
    actorId: ctx.actorId,
    actorType: ctx.actorType,
    payload: {
      status: formStatus,
      terminated_by: terminatedBy,
      answered_count: answeredCount,
      field_count: fieldCount,
    },
  })

  const posted = await postMessage(tx, {
    workspaceId: ctx.workspaceId,
    conversationId: ctx.conversationId,
    authorType: 'system',
    actorId: null,
    body: formSummaryMessage(formStatus),
    visibility: 'public',
  })

  return { conversationId: ctx.conversationId, formStatus, answeredCount, fieldCount, assignedAgentId, posted }
}
```

> `sql` may be unused depending on how `selectDistinct` types out — drop the import if `pnpm typecheck` flags it.

- [ ] **Step 5: Write the shared post-commit emitter**

Create `backend/src/domain/forms/emitFormTerminated.ts`:

```ts
import type { Server } from 'socket.io'
import { toAgentView, toPlayerView } from '../conversations/serializers.ts'
import { emitInboxChanged, emitMessageToRooms, emitPhaseChanged } from '../../shared/realtime/emit.ts'
import { getIo } from '../../shared/realtime/socketServer.ts'
import { logger } from '../../shared/logging/logger.ts'
import type { CompleteFormResult } from './completeFormAndHandoff.ts'

/**
 * One emit shape for the same three callers completeFormAndHandoff has, so the
 * two halves cannot drift: whatever the transaction did, this announces.
 *
 * The socket server may not be running at all — the sweeper is exercised
 * directly in tests with no Redis, the same contract the bot orchestrator's
 * emitApplied works under. A missing io is logged, never thrown: the write has
 * already committed and failing here would report a success as a failure.
 */
export function emitFormTerminated(workspaceId: string, result: CompleteFormResult): void {
  let io: Server
  try {
    io = getIo()
  } catch (err) {
    logger.warn('forms', 'skipping realtime emit: socket server not initialised', {
      workspaceId,
      conversationId: result.conversationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  emitMessageToRooms(io, result.conversationId, toPlayerView(result.posted), toAgentView(result.posted))
  emitPhaseChanged(io, result.conversationId, { conversation_id: result.conversationId, confirm_phase: 'none' })
  emitInboxChanged(io, workspaceId, result.conversationId, 'open')
}
```

- [ ] **Step 6: Re-export**

In `backend/src/domain/forms/index.ts` add:

```ts
export * from './completeFormAndHandoff.ts'
export * from './emitFormTerminated.ts'
export * from './messages.ts'
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @support/backend test forms.submission.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/domain/forms backend/tests/forms.submission.test.ts
git commit -m "feat(forms): completeFormAndHandoff, the one terminate transaction"
```

---

### Task 5: The three `/surface/form/*` routes

**Files:**
- Create: `backend/src/surface/services/formService.ts`
- Create: `backend/src/surface/controllers/formController.ts`
- Create: `backend/src/surface/routers/formRouter.ts`
- Modify: `backend/src/surface/router.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/forms.submission.test.ts` (append route block), `backend/tests/forms.events.test.ts` (create)

**Interfaces:**
- Consumes: `completeFormAndHandoff`, `emitFormTerminated`, `FormAnswerBody`, `FormTerminateBody`, `formAnswerValueSchemas`.
- Produces:
  ```ts
  export type AnswerFormResult =
    | { ok: false; reason: 'not_found' | 'no_form_pending' | 'unknown_field' | 'invalid_value' | 'unsupported_field_type' }
    | { ok: true; isCorrection: boolean }
  export async function answerForm(ctx: PlayerContext, body: z.infer<typeof FormAnswerBody>): Promise<AnswerFormResult>

  export type TerminateFormResult =
    | { ok: false; reason: 'not_found' | 'no_form_pending' | 'already_terminal' }
    | { ok: true; formStatus: TerminalFormStatus; status: ConversationStatusValue }
  export async function terminateForm(
    ctx: PlayerContext,
    body: z.infer<typeof FormTerminateBody>,
    terminatedBy: 'submit' | 'skip',
  ): Promise<TerminateFormResult>
  ```

- [ ] **Step 1: Write the failing route tests**

Append to `backend/tests/forms.submission.test.ts`, mounting the router the way `surface.resolutionAnswer.test.ts` does (`express()` + `requirePlayerToken` + the router + `errorMiddleware`, `mintToken` from `helpers/app.ts`, `req` from `helpers/http.ts`):

```ts
describe('POST /surface/form/answer', () => {
  it('accepts a valid answer and reports it as not a correction', async () => {
    const f = await liveForm()
    const res = await request(app)
      .post('/surface/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'store', value: 'Google Play' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, is_correction: false })
  })

  it('reports the second answer for the same field as a correction', async () => {
    const f = await liveForm()
    const post = (value: string) =>
      request(app).post('/surface/form/answer').set('Authorization', `Bearer ${f.token}`).send({ field_key: 'store', value })
    await post('Google Play')
    const res = await post('Apple App Store')
    expect(res.body.is_correction).toBe(true)
    const { rows } = await ownerPool.query(`select value from form_answer order by created_at`)
    expect(rows).toHaveLength(2)
  })

  it('rejects an unknown field key', async () => {
    const f = await liveForm()
    const res = await request(app)
      .post('/surface/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'not_a_field', value: 'x' })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('unknown_field')
  })

  it('rejects a value of the wrong type', async () => {
    const f = await liveForm()
    const res = await request(app)
      .post('/surface/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'quantity', value: 'seven' })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('invalid_value')
  })

  it('rejects a choice outside its options', async () => {
    const f = await liveForm()
    const res = await request(app)
      .post('/surface/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'store', value: 'Steam' })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('invalid_value')
  })

  it('rejects an attachment as unsupported', async () => {
    const f = await liveForm()
    const res = await request(app)
      .post('/surface/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'proof', value: { attachmentId: '00000000-0000-4000-8000-000000000000' } })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('unsupported_field_type')
  })

  it('never posts an answer as a chat message', async () => {
    const f = await liveForm()
    await request(app)
      .post('/surface/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'store', value: 'Google Play' })
    const { rows } = await ownerPool.query(`select body from message where conversation_id = $1`, [f.conversationId])
    expect(rows.map((r) => r.body)).not.toContain('Google Play')
  })
})

describe('POST /surface/form/submit and /skip', () => {
  it('submit terminates with terminated_by submit', async () => {
    const f = await liveForm()
    const res = await request(app).post('/surface/form/submit').set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ confirm_phase: 'none', status: 'open', form_status: 'skipped' })
    const { rows } = await ownerPool.query(`select payload from event where type = 'form_completed'`)
    expect(rows[0]!.payload.terminated_by).toBe('submit')
  })

  it('skip terminates with terminated_by skip and keeps earlier answers readable', async () => {
    const f = await liveForm()
    await request(app)
      .post('/surface/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'store', value: 'Google Play' })
    const res = await request(app).post('/surface/form/skip').set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.body.form_status).toBe('partial')
    const { rows } = await ownerPool.query(`select field_key, value from form_answer`)
    expect(rows).toEqual([{ field_key: 'store', value: 'Google Play' }])
  })

  it('refuses a second terminate on a terminal submission', async () => {
    const f = await liveForm()
    await request(app).post('/surface/form/skip').set('Authorization', `Bearer ${f.token}`).send({})
    const res = await request(app).post('/surface/form/submit').set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(409)
  })

  it('refuses an answer once the submission is terminal', async () => {
    const f = await liveForm()
    await request(app).post('/surface/form/skip').set('Authorization', `Bearer ${f.token}`).send({})
    const res = await request(app)
      .post('/surface/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'store', value: 'Google Play' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('no_form_pending')
  })
})
```

`liveForm()` is a fixture that seeds a workspace, an active agent, a player, a conversation with `confirm_phase = 'form'`, a published form with fields `store` (choice, options `['Apple App Store','Google Play']`), `quantity` (number), `proof` (attachment), an `in_progress` submission, a `form_offered` event, and mints a player token. Write it once at the top of the file beside `offered()`.

- [ ] **Step 2: Write the failing event tests**

Create `backend/tests/forms.events.test.ts` with the same harness:

```ts
describe('form events', () => {
  it('writes one form_field_answered per accepted answer, in position order, with no answer value', async () => {
    const f = await liveForm()
    await answer(f, 'store', 'Google Play')
    await answer(f, 'quantity', 3)

    const { rows } = await ownerPool.query(
      `select payload from event where type = 'form_field_answered' order by occurred_at, id`,
    )
    expect(rows).toHaveLength(2)
    // Exact key set, not a subset. A later change that adds `value` fails here
    // rather than quietly leaking player-written text into `event`.
    expect(Object.keys(rows[0]!.payload).sort()).toEqual(
      ['field_key', 'field_type', 'form_id', 'is_correction', 'position'].sort(),
    )
    expect(rows.map((r) => r.payload.position)).toEqual([0, 1])
    expect(rows[0]!.payload).toMatchObject({ field_key: 'store', field_type: 'choice', is_correction: false })
  })

  it('sets is_correction on the second answer for a field and not the first', async () => {
    const f = await liveForm()
    await answer(f, 'store', 'Google Play')
    await answer(f, 'store', 'Apple App Store')
    const { rows } = await ownerPool.query(
      `select payload from event where type = 'form_field_answered' order by created_at, id`,
    )
    expect(rows.map((r) => r.payload.is_correction)).toEqual([false, true])
  })

  it('writes neither an event nor an answer row for a rejected answer', async () => {
    const f = await liveForm()
    const res = await answer(f, 'store', 'Steam')
    expect(res.status).toBe(422)
    const events = await ownerPool.query(`select 1 from event where type = 'form_field_answered'`)
    const answers = await ownerPool.query(`select 1 from form_answer`)
    expect(events.rowCount).toBe(0)
    expect(answers.rowCount).toBe(0)
  })

  it('snapshots position from the submission version, not the current one', async () => {
    const f = await liveForm()
    // v2 reorders the fields. The live submission still points at v1.
    await seedFormVersion({
      workspaceId: f.workspaceId,
      formId: f.formId,
      version: 2,
      fields: [
        { key: 'quantity', label: 'Quantity', type: 'number', isRequired: false, position: 0 },
        { key: 'store', label: 'Store', type: 'choice', isRequired: true, position: 1, options: ['Apple App Store', 'Google Play'] },
      ],
    })
    await answer(f, 'store', 'Google Play')
    const { rows } = await ownerPool.query(`select payload from event where type = 'form_field_answered'`)
    expect(rows[0]!.payload.position).toBe(0)
  })

  it('stamps session_id when the session is verified', async () => {
    const f = await liveForm()
    const sessionId = await seedSession({ workspaceId: f.workspaceId, playerId: f.playerId })
    await answer(f, 'store', 'Google Play', sessionId)
    const { rows } = await ownerPool.query(`select session_id from event where type = 'form_field_answered'`)
    expect(rows[0]!.session_id).toBe(sessionId)
  })

  it('degrades session_id to null on a miss without rejecting the answer', async () => {
    const f = await liveForm()
    const otherWorkspace = await seedWorkspace()
    const otherPlayer = await seedPlayer(otherWorkspace)
    const foreign = await seedSession({ workspaceId: otherWorkspace, playerId: otherPlayer })
    const res = await answer(f, 'store', 'Google Play', foreign)
    expect(res.status).toBe(200)
    const { rows } = await ownerPool.query(`select session_id from event where type = 'form_field_answered'`)
    expect(rows[0]!.session_id).toBeNull()
  })

  it('rolls the answer row back when appendEvent fails', async () => {
    // The same assertion changeLog.test.ts makes, through a real transaction
    // rather than a mock: a row without its event, or an event without its row,
    // is exactly the divergence appendEvent exists to prevent.
    const f = await liveForm()
    const spy = vi.spyOn(appendEventModule, 'appendEvent').mockRejectedValueOnce(new Error('boom'))
    const res = await answer(f, 'store', 'Google Play')
    expect(res.status).toBeGreaterThanOrEqual(500)
    const answers = await ownerPool.query(`select 1 from form_answer`)
    expect(answers.rowCount).toBe(0)
    spy.mockRestore()
  })

  it('answered_count counts distinct keys, not events, when a field was corrected', async () => {
    const f = await liveForm()
    await answer(f, 'store', 'Google Play')
    await answer(f, 'store', 'Apple App Store')
    await request(app).post('/surface/form/submit').set('Authorization', `Bearer ${f.token}`).send({})
    const { rows } = await ownerPool.query(`select payload from event where type = 'form_completed'`)
    expect(rows[0]!.payload.answered_count).toBe(1)
    const events = await ownerPool.query(`select 1 from event where type = 'form_field_answered'`)
    expect(events.rowCount).toBe(2)
  })
})
```

`answer(f, key, value, sessionId?)` is a one-line helper wrapping the supertest POST. For the rollback test, import the module namespace so the spy binds to the same object the service calls: `import * as appendEventModule from '../src/shared/events/appendEvent.ts'` — and in `formService.ts` call it as `appendEvent(...)` from a normal named import, which Vitest's module mocking still intercepts under ESM. If the spy does not take, use `vi.mock('../src/shared/events/appendEvent.ts', async (orig) => …)` with a one-shot rejection instead.

- [ ] **Step 3: Run both files and watch them fail**

Run: `pnpm --filter @support/backend test forms.submission.test.ts forms.events.test.ts`
Expected: FAIL — the routes 404.

- [ ] **Step 4: Write the service**

Create `backend/src/surface/services/formService.ts`:

```ts
import { and, desc, eq } from 'drizzle-orm'
import type { z } from 'zod'
import {
  formAnswerValueSchemas,
  type ConversationStatusValue,
  type FormAnswerBody,
  type FormField,
  type FormTerminateBody,
} from '@support/types'
import { conversation, formAnswer, formSubmission, formVersion, session } from '../../shared/db/schema/index.ts'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts'
import {
  completeFormAndHandoff,
  emitFormTerminated,
  type TerminalFormStatus,
} from '../../domain/forms/index.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'

type AnswerBody = z.infer<typeof FormAnswerBody>
type TerminateBody = z.infer<typeof FormTerminateBody>

export type AnswerFormResult =
  | { ok: false; reason: 'not_found' | 'no_form_pending' | 'unknown_field' | 'invalid_value' | 'unsupported_field_type' }
  | { ok: true; isCorrection: boolean }

export type TerminateFormResult =
  | { ok: false; reason: 'not_found' | 'no_form_pending' }
  | { ok: true; formStatus: TerminalFormStatus; status: ConversationStatusValue }

/**
 * FK checks bypass RLS and event.session_id is ON DELETE RESTRICT, so an
 * unverified id would roll the whole answer back. Any miss degrades to null.
 * Attribution, never a gate.
 */
async function verifySession(tx: Tx, playerId: string, sessionId?: string): Promise<string | null> {
  if (!sessionId) return null
  const [found] = await tx
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.id, sessionId), eq(session.playerId, playerId)))
    .limit(1)
  return found?.id ?? null
}

/**
 * The player's latest conversation and its live submission. No conversation id
 * in any of these requests: the thread is resolved from the token under RLS,
 * the same rule getPlayerMessages and answerResolution follow, so the three can
 * never disagree about which conversation the card belonged to.
 */
async function liveSubmission(tx: Tx, playerId: string) {
  const [conv] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.playerId, playerId))
    .orderBy(desc(conversation.createdAt))
    .limit(1)
  if (!conv) return { conv: null, submission: null }

  const [submission] = await tx
    .select({
      id: formSubmission.id,
      formId: formSubmission.formId,
      formVersion: formSubmission.formVersion,
    })
    .from(formSubmission)
    .where(and(eq(formSubmission.conversationId, conv.id), eq(formSubmission.status, 'in_progress')))
    .orderBy(desc(formSubmission.startedAt))
    .limit(1)

  return { conv, submission: submission ?? null }
}

export async function answerForm(ctx: PlayerContext, body: AnswerBody): Promise<AnswerFormResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const sessionId = await verifySession(tx, ctx.playerId, body.session_id)
    const { conv, submission } = await liveSubmission(tx, ctx.playerId)
    if (!conv) return { ok: false as const, reason: 'not_found' as const }
    if (!submission) return { ok: false as const, reason: 'no_form_pending' as const }

    // Resolve against the submission's snapshotted version, never the current
    // one — a field reordered in v2 must not renumber a v1 answer in flight.
    const [version] = await tx
      .select({ fields: formVersion.fields })
      .from(formVersion)
      .where(and(eq(formVersion.formId, submission.formId), eq(formVersion.version, submission.formVersion)))
      .limit(1)

    const field: FormField | undefined = version?.fields.find((f) => f.key === body.field_key)
    // The guard that replaces the FK a form_field table would have given.
    if (!field) return { ok: false as const, reason: 'unknown_field' as const }
    if (field.type === 'attachment') return { ok: false as const, reason: 'unsupported_field_type' as const }

    const parsed = formAnswerValueSchemas[field.type].safeParse(body.value)
    if (!parsed.success) return { ok: false as const, reason: 'invalid_value' as const }
    // Membership cannot live in a standalone schema — it depends on this field's options.
    if (field.type === 'choice' && !(field.options ?? []).includes(parsed.data as string)) {
      return { ok: false as const, reason: 'invalid_value' as const }
    }

    const [prior] = await tx
      .select({ id: formAnswer.id })
      .from(formAnswer)
      .where(and(eq(formAnswer.formSubmissionId, submission.id), eq(formAnswer.fieldKey, field.key)))
      .limit(1)
    const isCorrection = prior !== undefined

    // Never an update: REVOKE UPDATE ON form_answer makes the append-only rule
    // structural, and the newest created_at wins on read.
    await tx.insert(formAnswer).values({
      workspaceId: ctx.workspaceId,
      formSubmissionId: submission.id,
      fieldKey: field.key,
      fieldType: field.type,
      value: parsed.data,
    })

    // Same transaction as the row it explains. No answer value in the payload:
    // its durable home is form_answer.value, which is RLS-scoped, append-only
    // and read through one path. The event records that a field was answered
    // and which — the whole of what drop-off analysis needs.
    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'form_field_answered',
      conversationId: conv.id,
      sessionId,
      actorId: ctx.playerId,
      actorType: 'player',
      payload: {
        form_id: submission.formId,
        field_key: field.key,
        field_type: field.type,
        position: field.position,
        is_correction: isCorrection,
      },
    })

    return { ok: true as const, isCorrection }
  })
}

export async function terminateForm(
  ctx: PlayerContext,
  body: TerminateBody,
  terminatedBy: 'submit' | 'skip',
): Promise<TerminateFormResult> {
  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    const sessionId = await verifySession(tx, ctx.playerId, body.session_id)
    const { conv, submission } = await liveSubmission(tx, ctx.playerId)
    if (!conv) return { ok: false as const, reason: 'not_found' as const }
    if (!submission) return { ok: false as const, reason: 'no_form_pending' as const }

    const completed = await completeFormAndHandoff(
      tx,
      {
        workspaceId: ctx.workspaceId,
        conversationId: conv.id,
        submissionId: submission.id,
        actorType: 'player',
        actorId: ctx.playerId,
        sessionId,
      },
      terminatedBy,
    )
    // A terminal submission has no transition out of it. The FOR UPDATE inside
    // completeFormAndHandoff means a submit racing a skip loses here rather than
    // double-writing.
    if (!completed) return { ok: false as const, reason: 'no_form_pending' as const }

    return { ok: true as const, completed }
  })

  if (!result.ok) return result

  // Emits only after commit.
  emitFormTerminated(ctx.workspaceId, result.completed)
  return { ok: true, formStatus: result.completed.formStatus, status: 'open' }
}
```

- [ ] **Step 5: Write the controller and router**

Create `backend/src/surface/controllers/formController.ts`:

```ts
import type { RequestHandler } from 'express'
import { FormAnswerBody, FormTerminateBody } from '@support/types'
import { sendError } from '../../errors.ts'
import { answerForm, terminateForm } from '../services/formService.ts'

const ERRORS = {
  not_found: [404, 'No conversation found for this player.'],
  no_form_pending: [409, 'There are no form questions to answer.'],
  unknown_field: [422, 'That question is not part of this form.'],
  invalid_value: [422, 'That answer does not match the question.'],
  unsupported_field_type: [422, 'That question type cannot be answered yet.'],
} as const

export const formAnswerHandler: RequestHandler = async (req, res) => {
  const body = FormAnswerBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'field_key must be a string and session_id, if present, a uuid.')
    return
  }

  const result = await answerForm(req.player!, body.data)
  if (!result.ok) {
    const [status, message] = ERRORS[result.reason]
    sendError(res, status, result.reason, message)
    return
  }

  res.status(200).json({ ok: true, is_correction: result.isCorrection })
}

/** Submit and skip differ only in the fact they record. §1.3 derives the status from the rows. */
function terminateHandler(terminatedBy: 'submit' | 'skip'): RequestHandler {
  return async (req, res) => {
    const body = FormTerminateBody.safeParse(req.body ?? {})
    if (!body.success) {
      sendError(res, 422, 'invalid_request', 'session_id, if present, must be a uuid.')
      return
    }

    const result = await terminateForm(req.player!, body.data, terminatedBy)
    if (!result.ok) {
      const [status, message] = ERRORS[result.reason]
      sendError(res, status, result.reason, message)
      return
    }

    res.status(200).json({ confirm_phase: 'none', status: result.status, form_status: result.formStatus })
  }
}

export const formSubmitHandler = terminateHandler('submit')
export const formSkipHandler = terminateHandler('skip')
```

Create `backend/src/surface/routers/formRouter.ts`:

```ts
import { Router } from 'express'
import { formAnswerHandler, formSkipHandler, formSubmitHandler } from '../controllers/formController.ts'

export const formRouter = Router()
formRouter.post('/form/answer', formAnswerHandler)
formRouter.post('/form/submit', formSubmitHandler)
formRouter.post('/form/skip', formSkipHandler)
```

Mount it in `backend/src/surface/router.ts` — add the import beside the others and `surfaceRouter.use(formRouter)` after `bootstrapRouter`, keeping the list alphabetical.

- [ ] **Step 6: Register the three paths in OpenAPI**

In `backend/src/docs/openapi.ts`, add `FormAnswerBody, FormTerminateBody` to the `@support/types` import and append three blocks beside the `/surface/resolution-answer` one:

```ts
registry.registerPath({
  method: 'post',
  path: '/surface/form/answer',
  summary: 'Player Answer One Form Question',
  description:
    'One question of the pinned form card. No conversation id — the submission is the live one on the player\'s latest conversation. Answers are append-only: a second answer for the same field_key is a correction, not an update, and the newest wins on read. 409 when no form is pending; 422 for an unknown field, a value of the wrong type, a choice outside its options, or an attachment.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: { body: { content: { 'application/json': { schema: FormAnswerBody } } } },
  responses: {
    200: {
      description: 'Answer accepted',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true), is_correction: z.boolean() }) } },
    },
    404: { description: 'No conversation for this player' },
    409: { description: 'No form pending' },
    422: { description: 'Unknown field, invalid value, or unsupported field type' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/surface/form/submit',
  summary: 'Player Submit Form',
  description:
    'Terminates the form and completes the gated handoff: the status is derived from the answer rows (completed / partial / skipped), an agent is assigned, the conversation opens, and a summary card is posted. 409 on an already-terminal submission.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: { body: { content: { 'application/json': { schema: FormTerminateBody } } } },
  responses: {
    200: {
      description: 'Form terminated and handoff completed',
      content: {
        'application/json': {
          schema: z.object({ confirm_phase: z.literal('none'), status: z.string(), form_status: z.string() }),
        },
      },
    },
    404: { description: 'No conversation for this player' },
    409: { description: 'No form pending' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/surface/form/skip',
  summary: 'Player Skip Form',
  description:
    'The "Skip and talk to an agent" button, present on every question and never removable — nothing about a form may block a player reaching a human. Identical end state to submit; only form_completed.terminated_by differs. Answers given before the skip are kept, so a partly-filled form terminates as partial, not skipped.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: { body: { content: { 'application/json': { schema: FormTerminateBody } } } },
  responses: {
    200: {
      description: 'Form skipped and handoff completed',
      content: {
        'application/json': {
          schema: z.object({ confirm_phase: z.literal('none'), status: z.string(), form_status: z.string() }),
        },
      },
    },
    404: { description: 'No conversation for this player' },
    409: { description: 'No form pending' },
  },
})
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @support/backend test forms. && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Verify the docs render**

Run: `pnpm dev` in one terminal, then `curl -s localhost:4000/docs/json | grep -c 'surface/form'`
Expected: `3`. Stop `pnpm dev`.

- [ ] **Step 9: Commit**

```bash
git add backend/src/surface backend/src/docs/openapi.ts backend/tests/forms.submission.test.ts backend/tests/forms.events.test.ts
git commit -m "feat(forms): /surface/form answer, submit and skip routes"
```

---

### Task 6: The form block on `GET /surface/messages`

**Files:**
- Modify: `backend/src/surface/services/messagesService.ts:238-257`
- Test: `backend/tests/surface.messages.test.ts`

**Interfaces:**
- Consumes: `PlayerFormView` from Task 2.
- Produces: `form` on every `GET /surface/messages` response — a `PlayerFormView` when `confirm_phase === 'form'` and a live submission exists, `null` otherwise.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/surface.messages.test.ts`:

```ts
  it('returns the resolved form and the answers so far while the card is up', async () => {
    const f = await liveForm() // same fixture shape as forms.submission.test.ts
    await ownerPool.query(
      `insert into form_answer (id, workspace_id, form_submission_id, field_key, field_type, value)
       values (gen_random_uuid(), $1, $2, 'store', 'choice', '"Google Play"'::jsonb)`,
      [f.workspaceId, f.submissionId],
    )

    const res = await request(app).get(`/surface/messages?session_id=${randomUUID()}`).set('Authorization', `Bearer ${f.token}`)

    expect(res.body.confirm_phase).toBe('form')
    expect(res.body.form.submission_id).toBe(f.submissionId)
    expect(res.body.form.version).toBe(1)
    expect(res.body.form.fields.map((x: { key: string }) => x.key)).toEqual(['store', 'quantity', 'proof'])
    expect(res.body.form.answers).toEqual([{ field_key: 'store', value: 'Google Play' }])
  })

  it('returns only the newest answer per field', async () => {
    const f = await liveForm()
    await seedFormAnswer({ workspaceId: f.workspaceId, submissionId: f.submissionId, fieldKey: 'store', fieldType: 'choice', value: 'Google Play', createdAt: new Date(Date.now() - 60_000) })
    await seedFormAnswer({ workspaceId: f.workspaceId, submissionId: f.submissionId, fieldKey: 'store', fieldType: 'choice', value: 'Apple App Store' })

    const res = await request(app).get(`/surface/messages?session_id=${randomUUID()}`).set('Authorization', `Bearer ${f.token}`)
    expect(res.body.form.answers).toEqual([{ field_key: 'store', value: 'Apple App Store' }])
  })

  it('returns form null when no card is up', async () => {
    const f = await liveForm()
    await ownerPool.query(`update conversation set confirm_phase = 'none' where id = $1`, [f.conversationId])
    const res = await request(app).get(`/surface/messages?session_id=${randomUUID()}`).set('Authorization', `Bearer ${f.token}`)
    expect(res.body.form).toBeNull()
  })
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @support/backend test surface.messages.test.ts`
Expected: FAIL — `res.body.form` is `undefined`.

- [ ] **Step 3: Extend `getPlayerMessages`**

Replace the body of `getPlayerMessages` in `backend/src/surface/services/messagesService.ts` from the `if (!found)` line down:

```ts
    // No conversation means no question on screen — 'none', not undefined, so
    // the banner has one thing to test and never a missing field. `form` follows
    // the same rule for the same reason.
    if (!found) return { conversation_id: null, messages: [], confirm_phase: 'none', form: null }

    const rows = await tx.select().from(message).where(eq(message.conversationId, found.id)).orderBy(message.seq)
    const messages = rows.map(toPlayerView).filter((m): m is PlayerMessageView => m !== null)

    return {
      conversation_id: found.id,
      messages,
      status: found.status,
      confirm_phase: found.confirmPhase,
      form: found.confirmPhase === 'form' ? await loadPlayerForm(tx, found.id) : null,
    }
```

and add below it:

```ts
/**
 * Everything the pinned card needs to render from cold. A reconnect mid-form
 * therefore resumes at the right question with earlier answers intact, which is
 * the whole reason the answers are written per step rather than batched at the
 * end.
 *
 * Fields come from the submission's snapshotted version, never the form's
 * current one: a form edited to v2 while a player is on question three must not
 * renumber the card underneath them.
 *
 * Returns null when confirm_phase says 'form' but no live submission exists —
 * the narrow window between a terminate committing and the phase update being
 * observed. A null there renders no card, which is correct.
 */
async function loadPlayerForm(tx: Tx, conversationId: string): Promise<PlayerFormView | null> {
  const [submission] = await tx
    .select({
      id: formSubmission.id,
      formId: formSubmission.formId,
      version: formSubmission.formVersion,
      formName: form.name,
      fields: formVersion.fields,
    })
    .from(formSubmission)
    .innerJoin(form, eq(form.id, formSubmission.formId))
    .innerJoin(
      formVersion,
      and(eq(formVersion.formId, formSubmission.formId), eq(formVersion.version, formSubmission.formVersion)),
    )
    .where(and(eq(formSubmission.conversationId, conversationId), eq(formSubmission.status, 'in_progress')))
    .orderBy(desc(formSubmission.startedAt))
    .limit(1)

  if (!submission) return null

  // The current answer for a field is the row with the greatest created_at for
  // that (form_submission_id, field_key). Older rows are correction history and
  // never reach the player — the card only needs what to prefill.
  const answers = await tx
    .selectDistinctOn([formAnswer.fieldKey], { fieldKey: formAnswer.fieldKey, value: formAnswer.value })
    .from(formAnswer)
    .where(eq(formAnswer.formSubmissionId, submission.id))
    .orderBy(formAnswer.fieldKey, desc(formAnswer.createdAt))

  return {
    submission_id: submission.id,
    form_id: submission.formId,
    form_name: submission.formName,
    version: submission.version,
    fields: [...submission.fields].sort((a, b) => a.position - b.position),
    answers: answers.map((a) => ({ field_key: a.fieldKey, value: a.value })),
  }
}
```

Add the imports: `form, formAnswer, formSubmission, formVersion` from `shared/db/schema/index.ts`, `type Tx` from `shared/db/withWorkspace.ts`, `type PlayerFormView` from `@support/types`, and `desc` (already imported).

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @support/backend test surface.messages.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/surface/services/messagesService.ts backend/tests/surface.messages.test.ts
git commit -m "feat(forms): return the live form and its answers from GET /surface/messages"
```

---

### Task 7: The abandonment sweeper

**Files:**
- Create: `backend/src/shared/jobs/formTimeout.ts`
- Modify: `backend/src/shared/jobs/queue.ts:8-46`
- Test: `backend/tests/forms.timeout.test.ts` (create)

**Interfaces:**
- Consumes: `completeFormAndHandoff`, `emitFormTerminated`.
- Produces: `FORM_TIMEOUT_MINUTES = 30`; `sweepAbandonedForms(options?: { now?: Date; timeoutMinutes?: number }): Promise<number>`.

Without this job, the gate is strictly worse than no gate: a player who force-quits mid-form leaves a conversation in `bot_active` with no agent assigned and nothing aware of it. That is *"nothing may prevent a player reaching a human"* violated by accident, so this ships with the slice.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/forms.timeout.test.ts`, modelled on `jobs.sessionTimeout.test.ts`:

```ts
const NOW = new Date('2026-08-17T12:00:00Z')
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)

describe('sweepAbandonedForms', () => {
  it('terminates a stale in_progress submission and reaches the same end state as a skip', async () => {
    const f = await offeredAt(minutesAgo(45), ['a'])

    expect(await sweepAbandonedForms({ now: NOW, timeoutMinutes: 30 })).toBe(1)

    const [conv] = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, f.conversationId)),
    )
    expect(conv!.status).toBe('open')
    expect(conv!.confirmPhase).toBe('none')
    expect(conv!.assignedAgentId).toBe(f.agentId)

    const [sub] = await withWorkspace(f.workspaceId, (tx) => tx.select().from(formSubmission))
    expect(sub!.status).toBe('partial')
    expect(sub!.submittedAt).not.toBeNull()

    const events = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.conversationId, f.conversationId)),
    )
    expect(events.filter((e) => e.type === 'bot_handoff')).toHaveLength(1)
    const completed = events.filter((e) => e.type === 'form_completed')
    expect(completed).toHaveLength(1)
    // The load-bearing distinction: a submission the sweeper closed and one the
    // player skipped are the same row and need opposite fixes.
    expect(completed[0]!.payload.terminated_by).toBe('timeout')
    expect(completed[0]!.actorType).toBe('system')
    expect(completed[0]!.actorId).toBeNull()
  })

  it('leaves a submission younger than the window alone', async () => {
    await offeredAt(minutesAgo(10), [])
    expect(await sweepAbandonedForms({ now: NOW, timeoutMinutes: 30 })).toBe(0)
  })

  it('leaves a conversation whose confirm_phase is not form alone', async () => {
    const f = await offeredAt(minutesAgo(45), [])
    await ownerPool.query(`update conversation set confirm_phase = 'none' where id = $1`, [f.conversationId])
    expect(await sweepAbandonedForms({ now: NOW, timeoutMinutes: 30 })).toBe(0)
    const [sub] = await withWorkspace(f.workspaceId, (tx) => tx.select().from(formSubmission))
    expect(sub!.status).toBe('in_progress')
  })

  it('is idempotent across runs', async () => {
    await offeredAt(minutesAgo(45), [])
    expect(await sweepAbandonedForms({ now: NOW, timeoutMinutes: 30 })).toBe(1)
    expect(await sweepAbandonedForms({ now: NOW, timeoutMinutes: 30 })).toBe(0)
  })

  it('sweeps across workspaces without bypassing RLS', async () => {
    await offeredAt(minutesAgo(45), [])
    await offeredAt(minutesAgo(45), [])
    expect(await sweepAbandonedForms({ now: NOW, timeoutMinutes: 30 })).toBe(2)
  })
})
```

`offeredAt(startedAt, answerKeys)` seeds a fresh workspace + active agent + player + conversation with `confirm_phase = 'form'` + published form + an `in_progress` submission with that `started_at` + the `form_offered` event, and returns the ids. It is the `offered()` helper from Task 4 with a `startedAt` parameter — copy it into this file rather than importing across test files.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @support/backend test forms.timeout.test.ts`
Expected: FAIL with `Cannot find module '../src/shared/jobs/formTimeout.ts'`.

- [ ] **Step 3: Write the sweeper**

Create `backend/src/shared/jobs/formTimeout.ts`:

```ts
import { and, eq, isNull, lt } from 'drizzle-orm'
import { conversation, formSubmission, workspace } from '../db/schema/index.ts'
import { withWorkspace, withoutWorkspace } from '../db/withWorkspace.ts'
import { completeFormAndHandoff, emitFormTerminated } from '../../domain/forms/index.ts'
import { logger } from '../logging/logger.ts'

/**
 * Far longer than any plausible fill time, far shorter than a support SLA. A
 * constant in one file, tunable without a schema change.
 */
export const FORM_TIMEOUT_MINUTES = 30

export type SweepAbandonedFormsOptions = {
  now?: Date
  timeoutMinutes?: number
}

/**
 * Gating the status transition creates a failure mode that does not exist
 * without it: a player who force-quits mid-form leaves a conversation in
 * bot_active with confirm_phase = 'form', no agent assigned, and nothing aware
 * of it. That is "nothing may prevent a player reaching a human" violated by
 * accident, which is why this job is part of the slice rather than a follow-up.
 *
 * Answers so far are kept, the status derives normally, and the ticket reaches
 * the queue. A player who returns later reads a thread in which they were handed
 * off — which is what the handoff line already told them.
 *
 * Sweeps every workspace by looping one tenant-scoped transaction rather than by
 * bypassing RLS, following closeStaleSessions. Unlike that job it opens one
 * transaction per submission: this one assigns agents and posts messages, and a
 * single bad row must not roll back and strand every other player in the
 * workspace.
 */
export async function sweepAbandonedForms(options: SweepAbandonedFormsOptions = {}): Promise<number> {
  const now = options.now ?? new Date()
  const timeoutMinutes = options.timeoutMinutes ?? FORM_TIMEOUT_MINUTES
  const cutoff = new Date(now.getTime() - timeoutMinutes * 60_000)

  const workspaces = await withoutWorkspace(async (tx) =>
    tx.select({ id: workspace.id }).from(workspace).where(isNull(workspace.disabledAt)),
  )

  let terminated = 0
  for (const ws of workspaces) {
    const stale = await withWorkspace(ws.id, async (tx) =>
      tx
        .select({ id: formSubmission.id, conversationId: formSubmission.conversationId })
        .from(formSubmission)
        .innerJoin(conversation, eq(conversation.id, formSubmission.conversationId))
        .where(
          and(
            eq(formSubmission.status, 'in_progress'),
            lt(formSubmission.startedAt, cutoff),
            eq(conversation.confirmPhase, 'form'),
          ),
        ),
    )

    for (const row of stale) {
      try {
        const result = await withWorkspace(ws.id, async (tx) =>
          completeFormAndHandoff(
            tx,
            {
              workspaceId: ws.id,
              conversationId: row.conversationId,
              submissionId: row.id,
              // No player took this action, so there is no player actor to
              // attribute it to and no session that accompanied it.
              actorType: 'system',
              actorId: null,
              sessionId: null,
            },
            'timeout',
          ),
        )
        // null means the player terminated it between the select and here. Not
        // an error — the ticket reached the queue either way.
        if (!result) continue
        terminated += 1
        emitFormTerminated(ws.id, result)
      } catch (error) {
        // One stranded conversation must not strand the rest. Until real
        // alerting exists, this log is the alert.
        logger.error('jobs', `form-timeout failed for submission ${row.id}`, {
          workspaceId: ws.id,
          conversationId: row.conversationId,
          error: error instanceof Error ? `${error.name} ${error.message}` : String(error),
        })
      }
    }
  }

  return terminated
}
```

- [ ] **Step 4: Register the repeatable job**

In `backend/src/shared/jobs/queue.ts`:

```ts
import { sweepAbandonedForms } from './formTimeout.ts'

const SESSION_TIMEOUT_JOB = 'session-timeout'
const FORM_TIMEOUT_JOB = 'form-timeout'
```

After the existing `upsertJobScheduler` call:

```ts
  // Same five-minute cadence and the same stable-jobId rule: restarting the
  // process re-uses this schedule rather than stacking a second one.
  await queue.upsertJobScheduler(
    FORM_TIMEOUT_JOB,
    { pattern: '*/5 * * * *' },
    { name: FORM_TIMEOUT_JOB, opts: { removeOnComplete: 50, removeOnFail: 100 } },
  )
```

and replace the worker's processor body:

```ts
    async (job) => {
      if (job.name === SESSION_TIMEOUT_JOB) {
        const closed = await closeStaleSessions()
        if (closed > 0) logger.info('jobs', `closed ${closed} stale session(s)`)
        return
      }
      if (job.name === FORM_TIMEOUT_JOB) {
        const terminated = await sweepAbandonedForms()
        if (terminated > 0) logger.info('jobs', `terminated ${terminated} abandoned form(s)`)
      }
    },
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @support/backend test forms.timeout.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/shared/jobs backend/tests/forms.timeout.test.ts
git commit -m "feat(forms): abandonment sweeper so gating never strands a player"
```

---

### Task 8: `FormCard.tsx`

**Files:**
- Modify: `frontend/src/features/chat/api/playerChatApi.ts`
- Create: `frontend/src/surfaces/webview/components/chat/FormCard.tsx`
- Create: `frontend/src/surfaces/webview/components/chat/FormCard.test.tsx`

**Interfaces:**
- Consumes: `PlayerFormView`, `FormField` from `@support/types`.
- Produces:
  ```ts
  export function FormCard(props: {
    form: PlayerFormView
    onAnswer: (fieldKey: string, value: unknown) => Promise<unknown>
    onSubmit: () => void
    onSkip: () => void
    busy: boolean
  }): JSX.Element
  ```
  and the three API functions `postFormAnswer(token, fieldKey, value, sessionId?)`, `submitForm(token, sessionId?)`, `skipForm(token, sessionId?)`.

- [ ] **Step 1: Add the three API functions**

Append to `frontend/src/features/chat/api/playerChatApi.ts`:

```ts
/**
 * One question, one request. Considered and rejected: collecting every answer
 * client-side and submitting once — it loses everything if the player drops
 * mid-form, and to preserve partial answers on skip it has to send them anyway.
 */
export function postFormAnswer(
  token: string,
  fieldKey: string,
  value: unknown,
  sessionId?: string,
): Promise<FormAnswerResponse> {
  return apiCall(`/surface/form/answer`, token, {
    method: 'POST',
    body: JSON.stringify(sessionId ? { field_key: fieldKey, value, session_id: sessionId } : { field_key: fieldKey, value }),
  })
}

export function submitForm(token: string, sessionId?: string): Promise<FormTerminateResponse> {
  return apiCall(`/surface/form/submit`, token, {
    method: 'POST',
    body: JSON.stringify(sessionId ? { session_id: sessionId } : {}),
  })
}

export function skipForm(token: string, sessionId?: string): Promise<FormTerminateResponse> {
  return apiCall(`/surface/form/skip`, token, {
    method: 'POST',
    body: JSON.stringify(sessionId ? { session_id: sessionId } : {}),
  })
}
```

with `FormAnswerResponse, FormTerminateResponse` added to the type import at the top.

- [ ] **Step 2: Write the failing card test**

Create `frontend/src/surfaces/webview/components/chat/FormCard.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { PlayerFormView } from '@support/types'
import { FormCard } from './FormCard.tsx'

const FORM: PlayerFormView = {
  submission_id: 's1',
  form_id: 'f1',
  form_name: 'Purchase receipt',
  version: 1,
  fields: [
    { key: 'store', label: 'Store', type: 'choice', isRequired: true, position: 0, options: ['Apple App Store', 'Google Play'] },
    { key: 'order_id', label: 'Order or receipt ID', type: 'short_text', isRequired: true, position: 1 },
    { key: 'purchase_date', label: 'Date of purchase', type: 'date', isRequired: true, position: 2 },
  ],
  answers: [],
}

function setup(form: PlayerFormView = FORM) {
  const onAnswer = vi.fn().mockResolvedValue({ ok: true, is_correction: false })
  const onSubmit = vi.fn()
  const onSkip = vi.fn()
  render(<FormCard form={form} onAnswer={onAnswer} onSubmit={onSubmit} onSkip={onSkip} busy={false} />)
  return { onAnswer, onSubmit, onSkip }
}

describe('FormCard', () => {
  it('shows one question at a time with a counter', () => {
    setup()
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
    expect(screen.getByText('Store')).toBeInTheDocument()
    expect(screen.queryByText('Order or receipt ID')).not.toBeInTheDocument()
  })

  it('renders choice as buttons, not a select', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Google Play' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('shows skip on the first question and on the last', async () => {
    const { onSkip } = setup()
    expect(screen.getByRole('button', { name: /skip and talk to an agent/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^next$/i }))
    expect(screen.getByRole('button', { name: /skip and talk to an agent/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /skip and talk to an agent/i }))
    expect(onSkip).toHaveBeenCalledOnce()
  })

  it('does not block Next on an unanswered required field', () => {
    setup()
    expect(screen.getByRole('button', { name: /^next$/i })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
  })

  it('posts an answer when the value changed and advances', async () => {
    const { onAnswer } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Google Play' }))
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    expect(onAnswer).toHaveBeenCalledWith('store', 'Google Play')
    expect(await screen.findByText('2 of 3')).toBeInTheDocument()
  })

  it('hides Back on question one and shows it afterwards, prefilled', async () => {
    const { onAnswer } = setup()
    expect(screen.queryByRole('button', { name: /^back$/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Google Play' }))
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    await screen.findByText('2 of 3')
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Google Play' })).toHaveAttribute('aria-pressed', 'true')
    onAnswer.mockClear()
    // Unchanged prefill: pressing Next writes nothing. Re-submitting an identical
    // value would inflate the correction rate with events recording no correction.
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('posts a correction when a prefilled answer is changed', async () => {
    const { onAnswer } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Google Play' }))
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    await screen.findByText('2 of 3')
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    onAnswer.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Apple App Store' }))
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    expect(onAnswer).toHaveBeenCalledWith('store', 'Apple App Store')
  })

  it('resumes at the first unanswered question with earlier answers prefilled', () => {
    setup({ ...FORM, answers: [{ field_key: 'store', value: 'Google Play' }] })
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^back$/i })).toBeInTheDocument()
  })

  it('calls onSubmit from the last question', async () => {
    const { onSubmit } = setup()
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^next$/i }))
    await screen.findByText('3 of 3')
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }))
    expect(onSubmit).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter frontend test FormCard`
Expected: FAIL — the module does not exist.

- [ ] **Step 4: Write the card**

Create `frontend/src/surfaces/webview/components/chat/FormCard.tsx`:

```tsx
import { useMemo, useState } from 'react'
import type { FormField, PlayerFormView } from '@support/types'
import { SupportButton } from '@/surfaces/webview/components/SupportButton'
import { cn } from '@/surfaces/webview/lib/cn'

type FormCardProps = {
  form: PlayerFormView
  onAnswer: (fieldKey: string, value: unknown) => Promise<unknown>
  onSubmit: () => void
  onSkip: () => void
  busy: boolean
}

/** Empty means "nothing to send": a blank value is never posted, required or not. */
function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

/**
 * The questions, one at a time, pinned above the composer — not a modal and not
 * conversation turns. The card writes no message rows: answers live in
 * form_answer, and duplicating them into the transcript would put the same fact
 * in two tables that can disagree while filling the agent's thread with
 * questionnaire noise.
 *
 * Progress state (which question, what has been typed) is local and deliberately
 * never refetched mid-form. `form.answers` seeds it once — that is what makes a
 * reconnect resume at the right question rather than at question one.
 */
export function FormCard({ form, onAnswer, onSubmit, onSkip, busy }: FormCardProps) {
  const fields = useMemo(() => [...form.fields].sort((a, b) => a.position - b.position), [form.fields])

  // The value the server already holds for each field. `draft` diverges from it
  // as the player types; the difference is exactly what decides whether Next
  // posts anything.
  const [committed, setCommitted] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(form.answers.map((a) => [a.field_key, a.value])),
  )
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(form.answers.map((a) => [a.field_key, a.value])),
  )
  const [index, setIndex] = useState(() => {
    const answered = new Set(form.answers.map((a) => a.field_key))
    const first = fields.findIndex((f) => !answered.has(f.key))
    return first === -1 ? Math.max(fields.length - 1, 0) : first
  })
  const [sending, setSending] = useState(false)

  const field = fields[index]
  if (!field) return null

  const isLast = index === fields.length - 1
  const value = draft[field.key]
  const changed = !isEmpty(value) && value !== committed[field.key]
  const disabled = busy || sending

  const advance = async () => {
    setSending(true)
    try {
      // Pressing Next on an unchanged prefilled answer writes nothing:
      // re-submitting an identical value would inflate the correction rate with
      // events that record no correction, and grow an append-only table with
      // rows that differ only by timestamp.
      if (changed) {
        await onAnswer(field.key, value)
        setCommitted((current) => ({ ...current, [field.key]: value }))
      }
      if (isLast) onSubmit()
      else setIndex((current) => current + 1)
    } finally {
      setSending(false)
    }
  }

  const set = (next: unknown) => setDraft((current) => ({ ...current, [field.key]: next }))

  return (
    <div role="group" aria-label={form.form_name} className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        {/* Back is not politeness: a player who mistypes a receipt ID on a
            four-question form has no other recovery. */}
        {index > 0 ? (
          <button
            type="button"
            className="min-h-11 text-sm text-muted"
            onClick={() => setIndex((current) => current - 1)}
            disabled={disabled}
          >
            Back
          </button>
        ) : (
          <span />
        )}
        <span className="text-sm text-muted">{`${index + 1} of ${fields.length}`}</span>
      </div>

      <p className="text-lg font-semibold text-text">{field.label}</p>

      <FieldInput field={field} value={value} onChange={set} disabled={disabled} />

      <SupportButton
        variant="primary"
        className="min-h-11 w-full px-4 py-2.5 text-base"
        // Required fields do not block Next. is_required is soft, because
        // nothing about a form may block a player reaching a human.
        disabled={disabled}
        onClick={() => void advance()}
      >
        {isLast ? 'Submit' : 'Next'}
      </SupportButton>

      {/* The product spec's own label. Present on every question, first to last,
          and never removable. */}
      <button
        type="button"
        className="min-h-11 text-sm text-muted underline"
        onClick={onSkip}
        disabled={disabled}
      >
        Skip and talk to an agent
      </button>
    </div>
  )
}

/**
 * A map from the six usable types to inputs. `choice` renders as buttons, not a
 * <select> — the product mockup draws it that way and it is one tap on a phone.
 * `attachment` and `time` are unreachable: no seeded form uses either, and the
 * answer route rejects attachment outright.
 */
function FieldInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FormField
  value: unknown
  onChange: (next: unknown) => void
  disabled: boolean
}) {
  const inputClass = cn(
    'min-h-11 w-full rounded-card bg-surface px-4 py-3 text-base text-text placeholder:text-muted',
    'border border-transparent focus:border-accent outline-none disabled:opacity-60',
  )

  switch (field.type) {
    case 'choice':
      return (
        <div className="flex flex-col gap-2">
          {(field.options ?? []).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={value === option}
              disabled={disabled}
              onClick={() => onChange(option)}
              className={cn(
                'min-h-11 rounded-card px-4 py-2.5 text-base',
                value === option ? 'bg-accent text-accent-fg' : 'bg-surface text-text',
              )}
            >
              {option}
            </button>
          ))}
        </div>
      )
    case 'long_text':
      return (
        <textarea
          rows={3}
          aria-label={field.label}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputClass, 'resize-none')}
        />
      )
    case 'number':
      return (
        <input
          type="number"
          inputMode="decimal"
          aria-label={field.label}
          disabled={disabled}
          value={typeof value === 'number' ? String(value) : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          className={inputClass}
        />
      )
    case 'date':
      return (
        <input
          type="date"
          aria-label={field.label}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className={inputClass}
        />
      )
    case 'time':
      return (
        <input
          type="time"
          aria-label={field.label}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className={inputClass}
        />
      )
    case 'attachment':
      // Declared but inert until the attachment table exists. Rendering nothing
      // still leaves Next and Skip live, so it can never trap a player.
      return <p className="text-sm text-muted">This question cannot be answered here yet.</p>
    case 'short_text':
    default:
      return (
        <input
          type="text"
          aria-label={field.label}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      )
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter frontend test FormCard && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/chat/api/playerChatApi.ts frontend/src/surfaces/webview/components/chat/FormCard.tsx frontend/src/surfaces/webview/components/chat/FormCard.test.tsx
git commit -m "feat(forms): the pinned one-question-at-a-time card"
```

---

### Task 9: Wire the card into `SupportChat` and fix the `:168` bug

**Files:**
- Modify: `frontend/src/surfaces/webview/pages/SupportChat.tsx:105-110,164-168,188,228-253,285`
- Modify: `frontend/src/surfaces/webview/pages/SupportChat.test.tsx`

**Interfaces:**
- Consumes: `FormCard`, `postFormAnswer`, `submitForm`, `skipForm`.
- Produces: no exports; behaviour only.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/surfaces/webview/pages/SupportChat.test.tsx`:

```tsx
const FORM = {
  submission_id: 's1',
  form_id: 'f1',
  form_name: 'Purchase receipt',
  version: 1,
  fields: [
    { key: 'store', label: 'Store', type: 'choice', isRequired: true, position: 0, options: ['Apple App Store', 'Google Play'] },
    { key: 'order_id', label: 'Order or receipt ID', type: 'short_text', isRequired: true, position: 1 },
  ],
  answers: [],
}

describe('the form card', () => {
  it('does not render the resolution banner while confirm_phase is form', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(
      messages({ status: 'bot_active', confirm_phase: 'form', form: FORM }),
    )
    renderChat()
    expect(await screen.findByText('Store')).toBeInTheDocument()
    // The :168 bug: `!== 'none'` made a third enum value silently render the
    // yes/no banner underneath the card.
    expect(screen.queryByText('Is your issue resolved?')).not.toBeInTheDocument()
  })

  it('disables the composer while the card is showing', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(
      messages({ status: 'bot_active', confirm_phase: 'form', form: FORM }),
    )
    renderChat()
    await screen.findByText('Store')
    expect(screen.getByLabelText('Message')).toBeDisabled()
  })

  it('resumes mid-form at the right question with earlier answers present', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(
      messages({
        status: 'bot_active',
        confirm_phase: 'form',
        form: { ...FORM, answers: [{ field_key: 'store', value: 'Google Play' }] },
      }),
    )
    renderChat()
    expect(await screen.findByText('2 of 2')).toBeInTheDocument()
    expect(screen.getByText('Order or receipt ID')).toBeInTheDocument()
  })

  it('still renders the resolution banner on bot_article', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(
      messages({ status: 'bot_active', confirm_phase: 'bot_article', form: null }),
    )
    renderChat()
    expect(await screen.findByText('Is your issue resolved?')).toBeInTheDocument()
  })

  it('renders no card when confirm_phase is form but the form block is null', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(
      messages({ status: 'bot_active', confirm_phase: 'form', form: null }),
    )
    renderChat()
    await waitFor(() => expect(screen.getByLabelText('Message')).not.toBeDisabled())
  })
})
```

Add `form: null` to the `messages()` fixture's defaults, and add `postFormAnswer, submitForm, skipForm` to the mocked module's imports.

- [ ] **Step 2: Run and watch fail**

Run: `pnpm --filter frontend test SupportChat`
Expected: FAIL — no card renders, and the resolution banner renders during the form phase.

- [ ] **Step 3: Fix the phase check and derive the form flag**

In `frontend/src/surfaces/webview/pages/SupportChat.tsx`, replace line 168:

```ts
  // Explicit, not `!== 'none'`. The old test made every future enum value render
  // the yes/no banner by default, and 'form' is the value that proved it: the
  // banner would have appeared underneath the form card asking about an article
  // nobody had offered.
  const phase = messagesQuery.data?.confirm_phase ?? 'none'
  const confirmPending = phase === 'bot_article' || phase === 'agent_ask'
  const activeForm = phase === 'form' ? (messagesQuery.data?.form ?? null) : null
```

Extend `isTyping` and the composer:

```ts
  const isTyping =
    messagesQuery.data?.status === 'bot_active' &&
    chatMessages[chatMessages.length - 1]?.authorType === 'player' &&
    !settled &&
    !confirmPending &&
    activeForm === null
```

```tsx
      <ChatComposer
        onSend={(body) => send.mutate(body)}
        disabled={send.isPending || confirmPending || activeForm !== null || settled}
      />
```

- [ ] **Step 4: Add the three mutations**

Beside the existing `answer` mutation:

```ts
  /**
   * Deliberately does not invalidate the messages query. The card owns its own
   * progress until terminate, and a refetch mid-form would remount it back to
   * whatever the server thinks the first unanswered question is — which, for a
   * player who went Back to correct question one, is the wrong one.
   */
  const formAnswer = useMutation({
    mutationFn: ({ fieldKey, value }: { fieldKey: string; value: unknown }) =>
      postFormAnswer(boot!.token, fieldKey, value, boot!.sessionId),
  })

  const formTerminate = useMutation({
    mutationFn: (action: 'submit' | 'skip') =>
      action === 'submit' ? submitForm(boot!.token, boot!.sessionId) : skipForm(boot!.token, boot!.sessionId),
    onSuccess: () => {
      // The terminate posts the summary card and flips the status, so the whole
      // thread is stale — unlike an answer, which changes nothing on screen.
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot?.sessionId] })
    },
  })
```

- [ ] **Step 5: Render the card in the banner slot**

Immediately above the `{confirmPending && …}` block:

```tsx
      {activeForm && (
        <div role="dialog" aria-modal="true" aria-label={activeForm.form_name} className={BANNER_CLASS}>
          {/* Keyed by the submission so an unrelated refetch — a socket
              message:new, a read receipt — cannot reset the player's progress. */}
          <FormCard
            key={activeForm.submission_id}
            form={activeForm}
            onAnswer={(fieldKey, value) => formAnswer.mutateAsync({ fieldKey, value })}
            onSubmit={() => formTerminate.mutate('submit')}
            onSkip={() => formTerminate.mutate('skip')}
            busy={formTerminate.isPending}
          />
        </div>
      )}
```

Add the imports for `FormCard` and the three API functions.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter frontend test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/surfaces/webview/pages/SupportChat.tsx frontend/src/surfaces/webview/pages/SupportChat.test.tsx
git commit -m "feat(forms): render the form card and fix the confirm-phase banner check"
```

---

### Task 10: Full verification and recorded deviations

**Files:**
- Modify: `docs/decisions/spec-contradictions.md`
- Test: the whole suite.

- [ ] **Step 1: Record the deviations**

Append two entries to `docs/decisions/spec-contradictions.md`, matching the file's existing entry format:

1. **`form_offered`'s payload carries `handoff_reason`.** The 2026-08-17 spec pins it to `{ form_id, form_version, field_count }`, but the same spec requires `bot_handoff` at terminate to carry `reason` "as today", and the reason is known only at offer time — no column holds it and the decision object is gone by then. Event payloads are this repo's snapshot mechanism, so the reason rides on the event that explains the offer. `completeFormAndHandoff` reads the latest `form_offered` for the conversation and writes `reason: null` if it is missing, rather than inventing one.
2. **HTTP status codes for `/surface/form/*`.** The spec pins none. `404 not_found`, `409 no_form_pending` (which also covers a terminate on an already-terminal submission — a terminal state has no transition out of it, so "there is no form pending" is literally true), `422` for `invalid_request` / `unknown_field` / `invalid_value` / `unsupported_field_type`. Follows `resolutionController`'s `ERRORS` map.

- [ ] **Step 2: Run the whole suite**

Run: `pnpm db:setup && pnpm test && pnpm typecheck`
Expected: PASS, with no skipped form tests.

- [ ] **Step 3: Walk the loop by hand**

Run `pnpm dev`, open the webview, and drive one conversation through the offer:

1. Send a message that classifies to a subintent with a seeded form and gets no article (or answer "No" to an offered article).
2. Confirm the handoff line appears immediately, the card appears above it, and the composer is greyed out.
3. Confirm in Drizzle Studio (`pnpm db:studio`) that the conversation is still `bot_active`, `assigned_agent_id` is null, and no `bot_handoff` event exists.
4. Answer one question, reload the page, and confirm the card resumes on question two with question one's answer prefilled.
5. Press **Back**, change the answer, press **Next**, and confirm a second `form_answer` row exists and its `form_field_answered` event has `is_correction: true`.
6. Skip. Confirm the summary card appears, the conversation is `open`, an agent is assigned, and exactly one `bot_handoff` plus one `form_completed` with `terminated_by: 'skip'` exist.
7. Repeat 1–2 on a second conversation, then run the sweeper by hand:
   ```bash
   pnpm --filter @support/backend exec tsx -e "import('./src/shared/jobs/formTimeout.ts').then(m => m.sweepAbandonedForms({ timeoutMinutes: 0 }).then(console.log))"
   ```
   Confirm it prints `1` and the conversation reached the queue with `terminated_by: 'timeout'`.

- [ ] **Step 4: Confirm the no-form path is untouched**

Send a message that classifies to a subintent with no form (roughly 25 of the seeded subintents) and hand off. Confirm: agent assigned, `status = 'open'`, `confirm_phase = 'none'`, exactly one `bot_handoff`, no `form_submission` row, no card.

- [ ] **Step 5: Commit**

```bash
git add docs/decisions/spec-contradictions.md
git commit -m "docs: record the two forms-slice-2 deviations"
```

---

## Spec coverage check

| Spec section | Task |
|---|---|
| §2.1 when a form is offered (three reasons, three exclusions) | 3 |
| §2.2 split transaction, gated status, three events, `confirm_phase = 'form'` | 1, 3, 4 |
| §2.3 three routes, five-step write, terminal refusal, openapi | 5 |
| §2.4 extended `GET /surface/messages`, `emitPhaseChanged` on both transitions | 3 (offer), 4 (terminate), 6 (read) |
| §2.4 the `SupportChat.tsx:168` bug | 9 |
| §2.5 card, Back, prefill, no-op Next, skip on every question, composer disable, choice as buttons, soft required, no message rows | 8, 9 |
| §2.6 abandonment sweeper, 30 minutes, 5-minute cadence | 7 |
| §2.7 `forms.offer` / `forms.submission` / `forms.events` / `forms.timeout` / frontend | 3, 4, 5, 7, 8, 9 |
