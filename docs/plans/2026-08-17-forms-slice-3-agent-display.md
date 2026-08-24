# Forms Slice 3 — Agent Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent opens the context rail on a handed-off ticket and reads what the player answered, what they left blank, and whether they skipped — labelled against the version of the form they were actually asked.

**Architecture:** One `form` block added to the existing `GET /agent/conversations/:id/context` payload (no new endpoint — one rail, one query, one failure mode), assembled by a pure fold over the submission's snapshotted `form_version.fields` and its latest answer rows. On the frontend, a third stacked section `FormPanel.tsx` in the rail's `context/` subfolder, two pure copy functions with their own tests on the `ticketOutcome.ts` pattern, one narrow query invalidation on `conversation:phase_changed`, and a queue label driven by data `AgentConversationSummary` already carries.

**Tech Stack:** Express 5, TypeScript, Zod, Drizzle ORM, PostgreSQL 17 with RLS, Vitest + supertest (backend); React 19, TanStack Query, Tailwind, Vitest + Testing Library (frontend); `@asteasolutions/zod-to-openapi` registry.

**Source spec:** `docs/specs/2026-08-17-player-side-forms-design.md` §3.1–§3.5 (approved). Slice 3 only.

**Constraining designs (both implemented, both must stay true):**
`docs/specs/2026-08-17-agent-player-context-frontend-design.md` and
`docs/specs/2026-08-17-agent-player-context-backend-design.md`.

---

## What this plan assumes has already landed

Slices 1 and 2 of the same spec. Do not implement any of it; if any of it is missing, stop and say so rather than building it here.

| Assumed                                                                        | Where                                                                 |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `form`, `form_version`, `form_submission`, `form_answer` tables + RLS policies | `backend/src/shared/db/schema/forms.ts`                               |
| `form_field_type` and `form_status` pg enums                                   | `backend/src/shared/db/schema/enums.ts`                               |
| `FORM_FIELD_TYPES`, `FormFieldType`, `formFieldSchema`, `FormField`            | `packages/types/src/forms.ts`                                         |
| `confirm_phase` enum carries `'form'`                                          | `backend/src/shared/db/schema/enums.ts`, `packages/types/src/chat.ts` |
| Submissions are created at handoff and terminated on submit/skip/timeout       | `backend/src/domain/forms/completeFormAndHandoff.ts`                  |
| `form_offered`, `form_field_answered`, `form_completed` events are written     | `appendEvent` call sites                                              |
| Three seeded published forms                                                   | `backend/src/shared/db/seedForms.ts`                                  |

**Step 0 for the whole plan — run this first and read the output:**

```bash
cd /Users/hassanrashid/Desktop/git/mindstorm/crm/app
ls backend/src/shared/db/schema/forms.ts packages/types/src/forms.ts
grep -n "export const form" backend/src/shared/db/schema/forms.ts
grep -n "confirmPhase" backend/src/shared/db/schema/enums.ts
grep -n "ConfirmPhaseValue" packages/types/src/chat.ts
grep -n "seedForm" backend/tests/helpers/db.ts
```

You need three facts from it, and every task below depends on them:

1. The **Drizzle export names** in `schema/forms.ts`. This plan writes `form`, `formVersion`, `formSubmission`, `formAnswer` with camelCase columns (`formSubmission.formVersion`, `formSubmission.startedAt`, `formAnswer.fieldKey`, `formAnswer.fieldType`, `formAnswer.createdAt`, `formVersion.fields`, `formVersion.version`). If slice 1 named them differently, use its names — do not rename slice 1's schema.
2. Whether `packages/types/src/forms.ts` already exports a **form-status** type. This plan calls it `FormStatusValue` with members `'in_progress' | 'completed' | 'partial' | 'skipped'`. Task 1 adds it if absent; reuse whatever slice 1 named it if present.
3. Whether `backend/tests/helpers/db.ts` already has `seedForm` / `seedFormVersion` / `seedFormSubmission` / `seedFormAnswer`. Task 2 adds them if absent.

---

## Scope boundaries

**In:** the `form` block on `GET /agent/conversations/:id/context`; `FormPanel.tsx`; the `conversation:phase_changed` invalidation; the "Answering questions" queue label; the §3.5 tests.

**Out — do not write any of it:** form editing from the rail, the admin form-builder, re-offering a form, correction history in the rail, any new endpoint, any schema change, any player-side change.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Read-only display.** No mutation, no route that writes, no control in the panel that submits anything. The form section is read-only in every one of its states.
- **Five states, one of which renders nothing.** No form → the section is **omitted entirely**, following the rail's existing precedent: `raw` is omitted when it is `{}` "rather than opening onto nothing" (`PlayerStatePanel.tsx:44-46`).
- **`partial` renders unanswered fields as visible "Not answered" rows, never dropped.** This is the assertion that carries the product requirement — the agent must be able to tell "declined" from "never offered".
- **Labels resolve against the submission's snapshotted `form_version`, never the current one.** Join `form_version` on `(form_id = submission.form_id AND version = submission.form_version)`. This is the first real consumer of `form_submission.form_version`.
- **Values render from the answer's own snapshotted `field_type`**, not from the resolved field. Only labels need the version join.
- **The current answer for a field is the row with the greatest `created_at`** for that `(form_submission_id, field_key)` (2026-08-11 spec, §"Reading answers"). Older rows stay queryable and are never shown.
- **Missing fields are derived**: the version's field keys minus the keys with ≥1 answer. No column records them.
- **The rail's `staleTime` is not dropped.** `5 * 60_000` stays. Exactly one invalidation trigger is added — `conversation:phase_changed` — and nothing else. A missed invalidation leaves the panel stale rather than wrong.
- **Two serializers rule** (CLAUDE.md): this is agent-facing only. No player-facing route reads any of it. The `message` table is never touched by the context endpoint and must stay untouched.
- **Permission checks run at the API** (CLAUDE.md). Everything runs inside `withWorkspace`, so RLS scopes every read and a cross-workspace id yields `404`, never `403`.
- **Any change to the context endpoint's response must be registered in `backend/src/docs/openapi.ts`** (CLAUDE.md). The path is already registered; its response schema gains the `form` block.
- **`markAgentMessagesRead` is still not called for an earlier ticket.** Nothing in this slice may touch `ThreadPanel.tsx`'s read-only guard (`ThreadPanel.tsx:173-181`).
- Never `console.*` — use `logger` from `backend/src/shared/logging/logger.ts`.
- No hard deletes anywhere. No `DELETE` route.
- Backend tests require Postgres up. Run from `backend/`: `pnpm vitest run tests/<file>`.
- Frontend tests run from `frontend/`: `pnpm vitest run src/<path>`.
- **Do not add a `Co-Authored-By` trailer to commits.**

---

## File Structure

| Path                                                                                   | Change                                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/types/src/agent-context.ts`                                                  | `AgentFormFieldView`, `AgentFormView`; `form` on the context response                       |
| `packages/types/src/forms.ts`                                                          | `FormStatusValue` (only if slice 1 did not already export it)                               |
| `backend/src/agent/services/conversationContextService.ts`                             | `buildFormFieldViews` (pure, exported), `getFormView`, one line in `getConversationContext` |
| `backend/src/docs/openapi.ts`                                                          | `AgentFormViewSchema`; `form` added to the context response schema                          |
| `backend/tests/helpers/db.ts`                                                          | `seedForm`, `seedFormVersion`, `seedFormSubmission`, `seedFormAnswer` (if absent)           |
| `backend/tests/agent.formContext.test.ts`                                              | **new** — the backend half of §3.5                                                          |
| `frontend/src/surfaces/agent-console/pages/Inbox/components/context/formStatusLine.ts` | **new**, pure                                                                               |
| `.../context/formStatusLine.test.ts`                                                   | **new**                                                                                     |
| `.../context/formAnswerValue.ts`                                                       | **new**, pure                                                                               |
| `.../context/formAnswerValue.test.ts`                                                  | **new**                                                                                     |
| `.../context/FormPanel.tsx`                                                            | **new**                                                                                     |
| `.../components/ContextRail.tsx`                                                       | mount `FormPanel`; socket subscription for one invalidation                                 |
| `.../components/ContextRail.test.tsx`                                                  | socket mock; the five states; the invalidation                                              |
| `.../components/ConversationRow.tsx`                                                   | "Answering questions" label                                                                 |
| `.../components/ConversationList.test.tsx`                                             | label present / absent                                                                      |

`FormPanel.tsx` goes in the rail's `context/` subfolder beside `PlayerStatePanel.tsx` and `TicketList.tsx`, and the two branching bits are extracted as pure functions with their own tests, exactly as `ticketOutcome.ts` / `ticketOutcome.test.ts` already do it on this surface.

---

## Task 1: Shared types and the pure field-view fold

The whole slice's contract, plus the one piece of real branching on the backend, tested without a database.

**Files:**

- Modify: `packages/types/src/forms.ts` (conditionally — see Step 1)
- Modify: `packages/types/src/agent-context.ts`
- Modify: `backend/src/agent/services/conversationContextService.ts`
- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ContextRail.test.tsx:11-17` (helper must satisfy the widened response type)
- Test: `backend/tests/agent.formContext.test.ts` (created here, DB-free tests only)

**Interfaces:**

- Consumes: `FormField` and `FormFieldType` from `@support/types` (slice 1).
- Produces:
  - `type FormStatusValue = 'in_progress' | 'completed' | 'partial' | 'skipped'`
  - `type AgentFormFieldView = { key: string; label: string; position: number; field_type: FormFieldType; value: unknown; answered: boolean }`
  - `type AgentFormView = { form_name: string; form_version: number; status: FormStatusValue; field_count: number; answered_count: number; fields: AgentFormFieldView[] }`
  - `AgentConversationContextResponse.form: AgentFormView | null`
  - `buildFormFieldViews(fields: FormField[], answers: LatestAnswer[]): { rows: AgentFormFieldView[]; answeredCount: number }` exported from `backend/src/agent/services/conversationContextService.ts`
  - `type LatestAnswer = { fieldKey: string; fieldType: FormFieldType; value: unknown }` exported from the same file

- [ ] **Step 1: Make sure a form-status type exists**

Run:

```bash
cd /Users/hassanrashid/Desktop/git/mindstorm/crm/app
grep -n "in_progress" packages/types/src/forms.ts
```

If it prints nothing, append this to `packages/types/src/forms.ts`:

```typescript
/**
 * Mirrors the `form_status` pg enum. The three terminal values are derived from
 * the answer rows at terminate time, not from which button the player pressed:
 * every field answered is `completed`, some-but-not-all is `partial`, none is
 * `skipped`. Which action ended the submission lives in the `form_completed`
 * event's `terminated_by`, not here.
 */
export type FormStatusValue = 'in_progress' | 'completed' | 'partial' | 'skipped';
```

If it prints an existing status type under another name, use that name everywhere below instead of `FormStatusValue` and skip this edit. Either way, confirm it is re-exported from `packages/types/src/index.ts`:

```bash
grep -n "forms" packages/types/src/index.ts
```

If `./forms.ts` is not exported from the barrel, add `export * from './forms.ts'` to it.

- [ ] **Step 2: Write the failing test**

Create `backend/tests/agent.formContext.test.ts`. This first block is pure — no Postgres, no server. The DB-backed blocks arrive in Task 2 and append to the same file.

```typescript
import { describe, expect, it } from 'vitest';
import type { FormField } from '@support/types';
import { buildFormFieldViews } from '../src/agent/services/conversationContextService.ts';

const V1_FIELDS: FormField[] = [
  {
    key: 'store',
    label: 'Store',
    type: 'choice',
    isRequired: true,
    position: 0,
    options: ['Apple App Store', 'Google Play', 'Other'],
  },
  {
    key: 'order_or_receipt_id',
    label: 'Order or receipt ID',
    type: 'short_text',
    isRequired: true,
    position: 1,
  },
  { key: 'purchase_date', label: 'Date of purchase', type: 'date', isRequired: true, position: 2 },
  {
    key: 'what_you_expected',
    label: 'What you expected',
    type: 'long_text',
    isRequired: true,
    position: 3,
  },
];

describe('buildFormFieldViews', () => {
  it('renders every field in position order when all are answered', () => {
    const { rows, answeredCount } = buildFormFieldViews(V1_FIELDS, [
      { fieldKey: 'what_you_expected', fieldType: 'long_text', value: 'A refund' },
      { fieldKey: 'store', fieldType: 'choice', value: 'Google Play' },
      { fieldKey: 'purchase_date', fieldType: 'date', value: '2026-08-16' },
      { fieldKey: 'order_or_receipt_id', fieldType: 'short_text', value: 'GPA.1234' },
    ]);

    expect(rows.map((r) => r.key)).toEqual([
      'store',
      'order_or_receipt_id',
      'purchase_date',
      'what_you_expected',
    ]);
    expect(rows.every((r) => r.answered)).toBe(true);
    expect(answeredCount).toBe(4);
  });

  // The assertion that carries the product requirement: a gap is a row, not an
  // omission. An agent has to be able to tell "the player did not answer this"
  // from "this was never asked".
  it('keeps unanswered fields as rows rather than dropping them', () => {
    const { rows, answeredCount } = buildFormFieldViews(V1_FIELDS, [
      { fieldKey: 'store', fieldType: 'choice', value: 'Google Play' },
      { fieldKey: 'order_or_receipt_id', fieldType: 'short_text', value: 'GPA.1234' },
    ]);

    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.answered)).toEqual([true, true, false, false]);
    expect(rows[2]).toMatchObject({
      key: 'purchase_date',
      label: 'Date of purchase',
      value: null,
      answered: false,
    });
    expect(answeredCount).toBe(2);
  });

  it('renders every field as a gap when nothing was answered', () => {
    const { rows, answeredCount } = buildFormFieldViews(V1_FIELDS, []);
    expect(rows).toHaveLength(4);
    expect(rows.some((r) => r.answered)).toBe(false);
    expect(answeredCount).toBe(0);
  });

  // The answer snapshots its own field_type precisely so the value is
  // interpretable without resolving the version. A field retyped in v2 must not
  // change how a v1 answer reads.
  it('takes field_type from the answer, and only the label from the version', () => {
    const { rows } = buildFormFieldViews(
      [
        {
          key: 'purchase_date',
          label: 'Date of purchase',
          type: 'short_text',
          isRequired: true,
          position: 0,
        },
      ],
      [{ fieldKey: 'purchase_date', fieldType: 'date', value: '2026-08-16' }],
    );
    expect(rows[0]).toMatchObject({
      label: 'Date of purchase',
      field_type: 'date',
      value: '2026-08-16',
    });
  });

  it('takes field_type from the version for an unanswered field', () => {
    const { rows } = buildFormFieldViews(
      [
        {
          key: 'purchase_date',
          label: 'Date of purchase',
          type: 'date',
          isRequired: true,
          position: 0,
        },
      ],
      [],
    );
    expect(rows[0]).toMatchObject({ field_type: 'date', answered: false });
  });

  it('sorts by position rather than trusting array order', () => {
    const { rows } = buildFormFieldViews(
      [
        { key: 'b', label: 'B', type: 'short_text', isRequired: false, position: 1 },
        { key: 'a', label: 'A', type: 'short_text', isRequired: false, position: 0 },
      ],
      [],
    );
    expect(rows.map((r) => r.key)).toEqual(['a', 'b']);
  });

  // Cannot normally occur — the answer route validates field_key against this
  // same version — but appending beats dropping, exactly as getPlayerStateView
  // does for a blob key with no declared_field row. answered_count stays on the
  // questions actually asked, so "2 of 4" never reads above its denominator.
  it('appends an answer whose key is not in the version, labelled by its key', () => {
    const { rows, answeredCount } = buildFormFieldViews(
      [{ key: 'a', label: 'A', type: 'short_text', isRequired: false, position: 0 }],
      [
        { fieldKey: 'a', fieldType: 'short_text', value: 'yes' },
        { fieldKey: 'ghost', fieldType: 'short_text', value: 'orphan' },
      ],
    );
    expect(rows.map((r) => r.key)).toEqual(['a', 'ghost']);
    expect(rows[1]).toMatchObject({ label: 'ghost', answered: true });
    expect(answeredCount).toBe(1);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd backend && pnpm vitest run tests/agent.formContext.test.ts`
Expected: FAIL — `buildFormFieldViews` is not exported from `conversationContextService.ts`.

- [ ] **Step 4: Add the response types**

In `packages/types/src/agent-context.ts`, add the imports at the top:

```typescript
import type { FormFieldType, FormStatusValue } from './forms.ts';
```

and append these types:

```typescript
/**
 * One row of the form section. Every field in the submission's version gets one,
 * answered or not: a gap is a row, never an omission, because the agent has to
 * be able to tell "the player did not answer this" from "this was never asked".
 */
export type AgentFormFieldView = {
  key: string;
  /** From the submission's snapshotted form_version, never the current one. */
  label: string;
  position: number;
  /**
   * From the answer's own snapshotted field_type when answered — the value is
   * interpretable without resolving the version, which is why that column
   * exists. From the version's declared type when unanswered.
   */
  field_type: FormFieldType;
  /** null when the field has no answer row. Read `answered`, not this. */
  value: unknown;
  answered: boolean;
};

/**
 * The form section of the context rail. `null` on the response when this
 * conversation was never offered a form — the frontend omits the section
 * entirely rather than opening onto nothing, the same precedent `raw` sets.
 */
export type AgentFormView = {
  form_name: string;
  /** The submission's snapshot. The section header names it: "Purchase receipt · v1". */
  form_version: number;
  status: FormStatusValue;
  /** The version's field count. The denominator in "2 of 4". */
  field_count: number;
  /** Distinct answered keys that are in the version. Never exceeds field_count. */
  answered_count: number;
  /** In `position` order, answered and unanswered alike. */
  fields: AgentFormFieldView[];
};
```

Then add the field to the response type:

```typescript
export type AgentConversationContextResponse = {
  player_state: AgentPlayerStateView;
  tickets: AgentTicketSummary[];
  summary: {
    total_tickets: number;
    total_reopened: number;
    first_contact_at: string;
  };
  /**
   * null when this conversation has no form submission. Not an error and not an
   * empty object: the rail omits the section entirely.
   */
  form: AgentFormView | null;
};
```

Leave the existing doc comments on `tickets` and `summary` exactly as they are.

- [ ] **Step 5: Write the pure fold**

In `backend/src/agent/services/conversationContextService.ts`, extend the type import at the top:

```typescript
import type {
  AgentConversationContextResponse,
  AgentConversationDetail,
  AgentFormFieldView,
  AgentPlayerStateView,
  AgentTicketSummary,
  FormField,
  FormFieldType,
} from '@support/types';
```

and append to the file:

```typescript
/** One field's current answer: the row with the greatest `created_at` for its key. */
export type LatestAnswer = { fieldKey: string; fieldType: FormFieldType; value: unknown };

/**
 * The submission's snapshotted field list folded together with its current
 * answers. Pure, and exported so the behaviour that carries the product
 * requirement is testable without a database.
 *
 * Labels come from the version the player was actually asked. Types come from
 * the answers themselves. Unanswered fields stay in the list as rows — dropping
 * them would make a partial form indistinguishable from a shorter one.
 */
export function buildFormFieldViews(
  fields: FormField[],
  answers: LatestAnswer[],
): { rows: AgentFormFieldView[]; answeredCount: number } {
  const byKey = new Map(answers.map((answer) => [answer.fieldKey, answer]));
  const rows: AgentFormFieldView[] = [];
  let answeredCount = 0;

  // Sorted here rather than trusted from the jsonb array: this list is read as
  // the order the questions were asked in, and a mis-ordered row misreads.
  const ordered = [...fields].sort((a, b) => a.position - b.position);
  for (const field of ordered) {
    const answer = byKey.get(field.key);
    if (answer) answeredCount += 1;
    rows.push({
      key: field.key,
      label: field.label,
      position: field.position,
      field_type: answer ? answer.fieldType : field.type,
      value: answer ? answer.value : null,
      answered: answer !== undefined,
    });
  }

  // An answer whose key is not in the version cannot normally occur — the answer
  // route validates against this same version — but appending beats dropping,
  // the same call getPlayerStateView makes for an undeclared blob key. It does
  // not count toward answered_count: the denominator is the questions asked.
  const known = new Set(ordered.map((field) => field.key));
  for (const answer of answers) {
    if (known.has(answer.fieldKey)) continue;
    rows.push({
      key: answer.fieldKey,
      label: answer.fieldKey,
      position: rows.length,
      field_type: answer.fieldType,
      value: answer.value,
      answered: true,
    });
  }

  return { rows, answeredCount };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && pnpm vitest run tests/agent.formContext.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Fix the frontend test helper the widened type just broke**

`ContextRail.test.tsx:11-17` builds an `AgentConversationContextResponse` literal, which now lacks the required `form` field. Change the helper to:

```typescript
function contextResponse(playerState: AgentPlayerStateView): AgentConversationContextResponse {
  return {
    player_state: playerState,
    tickets: [],
    summary: { total_tickets: 0, total_reopened: 0, first_contact_at: '2026-04-12T00:00:00Z' },
    form: null,
  };
}
```

- [ ] **Step 8: Typecheck the workspace**

Run: `pnpm typecheck`
Expected: PASS. If `getConversationContext` is flagged for not returning `form`, that is Task 2 — but it should not be yet, because the object literal there is still missing a required property. If it _is_ flagged, add `form: null` to that return object as a placeholder and let Task 2 replace it; do not leave the typecheck red at the end of a task.

- [ ] **Step 9: Commit**

```bash
git add packages/types/src/agent-context.ts packages/types/src/forms.ts packages/types/src/index.ts \
        backend/src/agent/services/conversationContextService.ts \
        backend/tests/agent.formContext.test.ts \
        frontend/src/surfaces/agent-console/pages/Inbox/components/ContextRail.test.tsx
git commit -m "feat(agent-context): form view types and the pure field-view fold"
```

---

## Task 2: The `form` block on `GET /agent/conversations/:id/context`

Three scoped reads inside the transaction the endpoint already opens, folded by Task 1's function, plus the Swagger entry the repo requires.

**Files:**

- Modify: `backend/src/agent/services/conversationContextService.ts`
- Modify: `backend/src/docs/openapi.ts:497-527` (the context response schema)
- Modify: `backend/tests/helpers/db.ts`
- Test: `backend/tests/agent.formContext.test.ts` (append)

**Interfaces:**

- Consumes: `buildFormFieldViews`, `LatestAnswer`, `AgentFormView` from Task 1.
- Produces: `getFormView(tx: Tx, conversationId: string): Promise<AgentFormView | null>`, exported so the tests can call it inside `withWorkspace` the way `getPlayerStateView` and `getTicketHistory` already are; `form` present on every 200 from `/context`.

- [ ] **Step 1: Add the seed helpers**

Only if Step 0's grep showed they are absent. Append to `backend/tests/helpers/db.ts`:

```typescript
export async function seedForm(args: { workspaceId: string; name?: string }): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(`insert into form (id, workspace_id, name) values ($1, $2, $3)`, [
    id,
    args.workspaceId,
    args.name ?? `Form ${id.slice(0, 8)}`,
  ]);
  return id;
}

export async function seedFormVersion(args: {
  workspaceId: string;
  formId: string;
  version: number;
  fields: unknown[];
  published?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into form_version (id, workspace_id, form_id, version, fields, published_at)
     values ($1, $2, $3, $4, $5, case when $6 then now() else null end)`,
    [
      id,
      args.workspaceId,
      args.formId,
      args.version,
      JSON.stringify(args.fields),
      args.published ?? true,
    ],
  );
  return id;
}

export async function seedFormSubmission(args: {
  workspaceId: string;
  conversationId: string;
  formId: string;
  formVersion: number;
  status?: 'in_progress' | 'completed' | 'partial' | 'skipped';
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into form_submission (id, workspace_id, conversation_id, form_id, form_version, status)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      args.workspaceId,
      args.conversationId,
      args.formId,
      args.formVersion,
      args.status ?? 'in_progress',
    ],
  );
  return id;
}

export async function seedFormAnswer(args: {
  workspaceId: string;
  submissionId: string;
  fieldKey: string;
  fieldType: string;
  value: unknown;
  createdAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  // ownerPool connects as the migration role, so REVOKE UPDATE ON form_answer
  // FROM support_app does not apply here. Tests still never update a row.
  await ownerPool.query(
    `insert into form_answer (id, workspace_id, form_submission_id, field_key, field_type, value, created_at)
     values ($1, $2, $3, $4, $5, $6, coalesce($7, now()))`,
    [
      id,
      args.workspaceId,
      args.submissionId,
      args.fieldKey,
      args.fieldType,
      JSON.stringify(args.value),
      args.createdAt ?? null,
    ],
  );
  return id;
}
```

- [ ] **Step 2: Write the failing tests**

Append to `backend/tests/agent.formContext.test.ts`. Add these imports at the top of the file:

```typescript
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { getFormView } from '../src/agent/services/conversationContextService.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts';
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
} from './helpers/db.ts';
```

and this body:

```typescript
const app = express();
app.use(express.json());
app.use(requireAgentSession, conversationsRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function setupAgent(workspaceId: string) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Agent One') returning id`,
    [`a-${workspaceId.slice(0, 8)}@example.test`],
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  );
  return {
    agentId,
    token: await signAgentSession({ agent_id: agentId, workspace_id: workspaceId }),
  };
}

async function setupSubmission(args: {
  status?: 'in_progress' | 'completed' | 'partial' | 'skipped';
  v1Fields?: unknown[];
}) {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({ workspaceId, playerId });
  const formId = await seedForm({ workspaceId, name: 'Purchase receipt' });
  await seedFormVersion({ workspaceId, formId, version: 1, fields: args.v1Fields ?? V1_FIELDS });
  const submissionId = await seedFormSubmission({
    workspaceId,
    conversationId,
    formId,
    formVersion: 1,
    status: args.status ?? 'in_progress',
  });
  return { workspaceId, playerId, conversationId, formId, submissionId };
}

describe('getFormView', () => {
  it('returns null when the conversation has no submission', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    const view = await withWorkspace(workspaceId, (tx) => getFormView(tx, conversationId));
    expect(view).toBeNull();
  });

  it('names the form and the snapshotted version', async () => {
    const { workspaceId, conversationId } = await setupSubmission({ status: 'skipped' });
    const view = await withWorkspace(workspaceId, (tx) => getFormView(tx, conversationId));

    expect(view).toMatchObject({
      form_name: 'Purchase receipt',
      form_version: 1,
      status: 'skipped',
      field_count: 4,
      answered_count: 0,
    });
  });

  it('reads the greatest created_at per field_key and hides the older row', async () => {
    const { workspaceId, conversationId, submissionId } = await setupSubmission({});
    await seedFormAnswer({
      workspaceId,
      submissionId,
      fieldKey: 'order_or_receipt_id',
      fieldType: 'short_text',
      value: 'GPA.0000',
      createdAt: new Date('2026-08-17T10:00:00Z'),
    });
    await seedFormAnswer({
      workspaceId,
      submissionId,
      fieldKey: 'order_or_receipt_id',
      fieldType: 'short_text',
      value: 'GPA.1234',
      createdAt: new Date('2026-08-17T10:05:00Z'),
    });

    const view = await withWorkspace(workspaceId, (tx) => getFormView(tx, conversationId));
    const row = view!.fields.find((f) => f.key === 'order_or_receipt_id');
    expect(row).toMatchObject({ value: 'GPA.1234', answered: true });
    // A correction is one row in the rail, not two: revision history is noise.
    expect(view!.fields.filter((f) => f.key === 'order_or_receipt_id')).toHaveLength(1);
    expect(view!.answered_count).toBe(1);
  });

  // The whole reason form_submission.form_version exists. Editing a live form
  // creates v2; answers already collected stay readable against v1.
  it('labels against the submission version after the form is edited to v2', async () => {
    const { workspaceId, conversationId, formId, submissionId } = await setupSubmission({});
    await seedFormAnswer({
      workspaceId,
      submissionId,
      fieldKey: 'purchase_date',
      fieldType: 'date',
      value: '2026-08-16',
    });
    await seedFormVersion({
      workspaceId,
      formId,
      version: 2,
      fields: [
        {
          key: 'purchase_date',
          label: 'When you bought it',
          type: 'short_text',
          isRequired: true,
          position: 0,
        },
      ],
    });

    const view = await withWorkspace(workspaceId, (tx) => getFormView(tx, conversationId));
    expect(view!.form_version).toBe(1);
    expect(view!.field_count).toBe(4);
    const row = view!.fields.find((f) => f.key === 'purchase_date');
    expect(row!.label).toBe('Date of purchase');
    // Type comes off the answer, so retyping the field in v2 changes nothing here.
    expect(row!.field_type).toBe('date');
  });
});

describe('GET /agent/conversations/:id/context form block', () => {
  it('returns form: null when the conversation was never offered one', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${conversationId}/context`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.form).toBeNull();
    // The other two sections are unaffected by an absent form.
    expect(res.body.player_state).toBeDefined();
    expect(res.body.tickets).toBeDefined();
  });

  it('carries the partial form with its gaps intact', async () => {
    const { workspaceId, conversationId, submissionId } = await setupSubmission({
      status: 'partial',
    });
    await seedFormAnswer({
      workspaceId,
      submissionId,
      fieldKey: 'store',
      fieldType: 'choice',
      value: 'Google Play',
    });
    await seedFormAnswer({
      workspaceId,
      submissionId,
      fieldKey: 'order_or_receipt_id',
      fieldType: 'short_text',
      value: 'GPA.1234',
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${conversationId}/context`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.form.status).toBe('partial');
    expect(res.body.form.answered_count).toBe(2);
    expect(res.body.form.field_count).toBe(4);
    expect(res.body.form.fields.map((f: { answered: boolean }) => f.answered)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('404s a conversation in another workspace rather than leaking its form', async () => {
    const { conversationId } = await setupSubmission({});
    const otherWorkspaceId = await seedWorkspace();
    const { token } = await setupAgent(otherWorkspaceId);

    const res = await request(app)
      .get(`/conversations/${conversationId}/context`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd backend && pnpm vitest run tests/agent.formContext.test.ts`
Expected: FAIL — `getFormView` is not exported; the endpoint's body has no `form` key.

- [ ] **Step 4: Write `getFormView` and wire it in**

In `backend/src/agent/services/conversationContextService.ts`, extend the schema import:

```typescript
import {
  agent,
  conversation,
  declaredField,
  event,
  form,
  formAnswer,
  formSubmission,
  formVersion,
  intent,
  player,
  playerStateSnapshot,
  subintent,
} from '../../shared/db/schema/index.ts';
```

and add `AgentFormView` to the `@support/types` type import. Then append:

```typescript
/**
 * The rail's form section, or null when this conversation was never offered a
 * form — the common case, and not an error. The frontend omits the section
 * entirely rather than opening onto nothing.
 *
 * Three reads, all inside the caller's transaction so the whole rail is one
 * consistent snapshot:
 *
 * 1. the submission, joined to `form` for its name
 * 2. the version the submission snapshotted — never the current one, which is
 *    the entire reason form_submission.form_version exists
 * 3. every answer row, folded to the greatest created_at per field_key
 *
 * The answers are folded in JS rather than with DISTINCT ON: a submission holds
 * one row per field plus corrections, so this is a handful of rows, and it keeps
 * the read inside the typed query builder.
 */
export async function getFormView(tx: Tx, conversationId: string): Promise<AgentFormView | null> {
  const [submission] = await tx
    .select({
      id: formSubmission.id,
      formId: formSubmission.formId,
      version: formSubmission.formVersion,
      status: formSubmission.status,
      formName: form.name,
    })
    .from(formSubmission)
    .innerJoin(form, eq(form.id, formSubmission.formId))
    .where(eq(formSubmission.conversationId, conversationId))
    // UNIQUE (conversation_id, form_id) and "offered once per conversation" mean
    // there is at most one today. Newest-first with limit 1 so a future second
    // form shows the current one rather than an arbitrary row.
    .orderBy(desc(formSubmission.startedAt))
    .limit(1);

  if (!submission) return null;

  const [version] = await tx
    .select({ fields: formVersion.fields })
    .from(formVersion)
    .where(
      and(eq(formVersion.formId, submission.formId), eq(formVersion.version, submission.version)),
    )
    .limit(1);

  // FK (form_id, form_version) -> form_version (form_id, version) makes the
  // miss impossible; an empty list beats a throw if the constraint ever slips.
  const fields = version?.fields ?? [];

  const answerRows = await tx
    .select({
      fieldKey: formAnswer.fieldKey,
      fieldType: formAnswer.fieldType,
      value: formAnswer.value,
    })
    .from(formAnswer)
    .where(eq(formAnswer.formSubmissionId, submission.id))
    .orderBy(asc(formAnswer.createdAt), asc(formAnswer.id));

  // Oldest first, so the last write for a key wins — which is the read rule:
  // the current answer is the row with the greatest created_at. Older rows stay
  // queryable; revision history in a rail nobody asked for is noise.
  const latest = new Map<string, LatestAnswer>();
  for (const row of answerRows) latest.set(row.fieldKey, row);

  const { rows, answeredCount } = buildFormFieldViews(fields, [...latest.values()]);

  return {
    form_name: submission.formName,
    form_version: submission.version,
    status: submission.status,
    field_count: fields.length,
    answered_count: answeredCount,
    fields: rows,
  };
}
```

Then in `getConversationContext`, after the `getTicketHistory` call:

```typescript
const formView = await getFormView(tx, conversationId);
```

and add `form: formView,` to the returned object, after `summary`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && pnpm vitest run tests/agent.formContext.test.ts`
Expected: PASS, all blocks.

Then check nothing else regressed on this endpoint:

Run: `cd backend && pnpm vitest run tests/agent.conversationContext.test.ts`
Expected: PASS.

- [ ] **Step 6: Register the block in the OpenAPI document**

In `backend/src/docs/openapi.ts`, above the `/agent/conversations/{id}/context` `registerPath` call (it starts at line 497), add:

```typescript
const FormFieldTypeSchema = z.enum([
  'short_text',
  'long_text',
  'number',
  'date',
  'time',
  'choice',
  'attachment',
]);

const AgentFormViewSchema = z.object({
  form_name: z.string(),
  form_version: z.number().int(),
  status: z.enum(['in_progress', 'completed', 'partial', 'skipped']),
  field_count: z.number().int(),
  answered_count: z.number().int(),
  fields: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      position: z.number().int(),
      field_type: FormFieldTypeSchema,
      value: z.unknown(),
      answered: z.boolean(),
    }),
  ),
});
```

Add `form: AgentFormViewSchema.nullable(),` to the 200 response schema object, after `summary`, and extend that path's `description` string with:

```
Plus `form`: the form the player was asked before handoff, or null when the subintent had none. Labels resolve against the submission's snapshotted form_version, never the current one; values carry the answer's own snapshotted field_type. Unanswered fields are present as rows with `answered: false` — a gap is a row, never an omission.
```

- [ ] **Step 7: Verify the Swagger document still builds**

Run: `cd backend && pnpm vitest run tests/` — or, if the suite is slow, start the API (`pnpm dev`) and fetch `http://localhost:4000/docs/json`, confirming the `/agent/conversations/{id}/context` 200 schema has a `form` property.
Expected: no schema-registration error; `form` present and nullable.

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/agent/services/conversationContextService.ts backend/src/docs/openapi.ts \
        backend/tests/helpers/db.ts backend/tests/agent.formContext.test.ts
git commit -m "feat(agent-context): serve the form block on the conversation context endpoint"
```

---

## Task 3: The two pure copy functions

The rail already splits its one piece of real branching into `ticketOutcome.ts` with its own test and no mounting. The form section has two: the status line and the value formatter. Same treatment.

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/Inbox/components/context/formStatusLine.ts`
- Create: `frontend/src/surfaces/agent-console/pages/Inbox/components/context/formStatusLine.test.ts`
- Create: `frontend/src/surfaces/agent-console/pages/Inbox/components/context/formAnswerValue.ts`
- Create: `frontend/src/surfaces/agent-console/pages/Inbox/components/context/formAnswerValue.test.ts`

**Interfaces:**

- Consumes: `FormStatusValue`, `FormFieldType` from `@support/types`.
- Produces:
  - `formStatusLine(status: FormStatusValue, answeredCount: number, fieldCount: number): string`
  - `formAnswerValue(fieldType: FormFieldType, value: unknown, answered: boolean): string`
  - `NOT_ANSWERED` — the exact string `'Not answered'`, exported so the panel and its tests cannot drift on it

- [ ] **Step 1: Write the failing tests**

Create `formStatusLine.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { formStatusLine } from './formStatusLine.ts';

describe('formStatusLine', () => {
  // bot_active conversations sit in the unassigned queue, so an agent can open
  // a ticket while the player is still on question two. The line says so.
  it('counts progress while the player is still answering', () => {
    expect(formStatusLine('in_progress', 2, 4)).toBe('Player is answering · 2 of 4');
    expect(formStatusLine('in_progress', 0, 4)).toBe('Player is answering · 0 of 4');
  });

  it('reports a completed form', () => {
    expect(formStatusLine('completed', 4, 4)).toBe('All 4 questions answered');
    expect(formStatusLine('completed', 1, 1)).toBe('All 1 question answered');
  });

  // The spec's own phrasing for what the agent reads on a partial form.
  it('splits a partial form into answered and not', () => {
    expect(formStatusLine('partial', 2, 6)).toBe('2 answered · 4 not answered');
    expect(formStatusLine('partial', 3, 4)).toBe('3 answered · 1 not answered');
  });

  // A skipped form must read as a decision, not as an absence — the agent has
  // to know to ask rather than wonder where the details went.
  it('says the player skipped', () => {
    expect(formStatusLine('skipped', 0, 4)).toBe('Player skipped the questions');
  });
});
```

Create `formAnswerValue.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { NOT_ANSWERED, formAnswerValue } from './formAnswerValue.ts';

describe('formAnswerValue', () => {
  // The row exists precisely so this string is visible. Never an empty cell.
  it('labels an unanswered field', () => {
    expect(formAnswerValue('short_text', null, false)).toBe(NOT_ANSWERED);
    expect(NOT_ANSWERED).toBe('Not answered');
  });

  it('renders text and choice answers verbatim', () => {
    expect(formAnswerValue('short_text', 'GPA.1234', true)).toBe('GPA.1234');
    expect(formAnswerValue('long_text', 'It charged me twice', true)).toBe('It charged me twice');
    expect(formAnswerValue('choice', 'Google Play', true)).toBe('Google Play');
  });

  it('formats a date answer', () => {
    expect(formAnswerValue('date', '2026-08-16', true)).toBe('16 Aug 2026');
  });

  // The type comes off the answer row, not off the current version. Same value,
  // different snapshotted type, different rendering — which is what makes a v1
  // answer still readable after v2 retypes the field.
  it('renders by the snapshotted type, not by the value shape', () => {
    expect(formAnswerValue('short_text', '2026-08-16', true)).toBe('2026-08-16');
  });

  it('renders numbers and times', () => {
    expect(formAnswerValue('number', 3, true)).toBe('3');
    expect(formAnswerValue('number', 0, true)).toBe('0');
    expect(formAnswerValue('time', '14:30', true)).toBe('14:30');
  });

  it('does not crash on an unparseable date or an unexpected shape', () => {
    expect(formAnswerValue('date', 'not-a-date', true)).toBe('not-a-date');
    expect(formAnswerValue('short_text', { a: 1 }, true)).toBe('{"a":1}');
    expect(formAnswerValue('short_text', null, true)).toBe(NOT_ANSWERED);
  });

  // attachment is declared-but-inert: no attachment table, so no answer of this
  // type can exist yet. Naming it beats rendering a raw uuid blob if one ever does.
  it('names an attachment rather than dumping it', () => {
    expect(formAnswerValue('attachment', { attachmentId: 'abc' }, true)).toBe('Attachment');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Inbox/components/context/`
Expected: FAIL — both modules do not exist.

- [ ] **Step 3: Write the implementations**

Create `formStatusLine.ts`:

```typescript
import type { FormStatusValue } from '@support/types';

/**
 * The one line under the form's name. Split out for the same reason
 * ticketOutcome is: it is the piece with real branching, and it is testable
 * without mounting anything.
 *
 * Four statuses, four sentences. `skipped` never reads as an absence — the
 * player declined, and the agent has to know to ask rather than wonder where
 * the details went.
 */
export function formStatusLine(
  status: FormStatusValue,
  answeredCount: number,
  fieldCount: number,
): string {
  switch (status) {
    case 'in_progress':
      return `Player is answering · ${answeredCount} of ${fieldCount}`;
    case 'completed':
      return `All ${fieldCount} question${fieldCount === 1 ? '' : 's'} answered`;
    case 'partial':
      return `${answeredCount} answered · ${fieldCount - answeredCount} not answered`;
    case 'skipped':
      return 'Player skipped the questions';
  }
}
```

Create `formAnswerValue.ts`:

```typescript
import type { FormFieldType } from '@support/types';

/** The visible text for a field the player did not answer. Never an empty cell. */
export const NOT_ANSWERED = 'Not answered';

function shortDate(value: string): string {
  // Answers are stored as YYYY-MM-DD. Parsed as UTC so a local timezone west of
  // Greenwich cannot render the day before the one the player picked.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Renders one answer, keyed on the field type the *answer row* snapshotted —
 * never the current version's type. That snapshot is why a value is
 * interpretable without resolving the version at all.
 */
export function formAnswerValue(
  fieldType: FormFieldType,
  value: unknown,
  answered: boolean,
): string {
  if (!answered || value === null || value === undefined) return NOT_ANSWERED;
  if (fieldType === 'attachment') return 'Attachment';
  if (fieldType === 'date' && typeof value === 'string') return shortDate(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Inbox/components/context/`
Expected: PASS — the two new files plus the existing `ticketOutcome.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Inbox/components/context/formStatusLine.ts \
        frontend/src/surfaces/agent-console/pages/Inbox/components/context/formStatusLine.test.ts \
        frontend/src/surfaces/agent-console/pages/Inbox/components/context/formAnswerValue.ts \
        frontend/src/surfaces/agent-console/pages/Inbox/components/context/formAnswerValue.test.ts
git commit -m "feat(context-rail): pure copy functions for the form section"
```

---

## Task 4: `FormPanel.tsx` and the five states

A third stacked section below Player state and Tickets. Same rail, no tabs, no new surface.

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/Inbox/components/context/FormPanel.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ContextRail.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Inbox/components/ContextRail.test.tsx`

**Interfaces:**

- Consumes: `AgentFormView` (Task 1), `formStatusLine`, `formAnswerValue`, `NOT_ANSWERED` (Task 3).
- Produces: `FormPanel({ form }: { form: AgentFormView })`, mounted in `ContextRail` only when `data.form` is truthy.

- [ ] **Step 1: Write the failing tests**

Append to `ContextRail.test.tsx`. Add `AgentFormView` to the `@support/types` type import at the top, then:

```typescript
function formView(overrides: Partial<AgentFormView> = {}): AgentFormView {
  return {
    form_name: 'Purchase receipt',
    form_version: 1,
    status: 'completed',
    field_count: 2,
    answered_count: 2,
    fields: [
      {
        key: 'store',
        label: 'Store',
        position: 0,
        field_type: 'choice',
        value: 'Google Play',
        answered: true,
      },
      {
        key: 'purchase_date',
        label: 'Date of purchase',
        position: 1,
        field_type: 'date',
        value: '2026-08-16',
        answered: true,
      },
    ],
    ...overrides,
  };
}

function railWithForm(form: AgentFormView | null) {
  vi.mocked(fetchConversationContext).mockResolvedValue({
    ...contextResponse({ status: 'no_session' }),
    form,
  });
  return renderRail();
}

describe('ContextRail form section', () => {
  // State 1 of five, and the one that renders nothing. Same precedent as `raw`
  // being `{}`: an empty panel explaining an absence is worse than no panel.
  it('omits the section entirely when there is no form', async () => {
    railWithForm(null);
    await screen.findByText('No session was attached to this ticket');
    expect(screen.queryByText('Form')).not.toBeInTheDocument();
    expect(screen.queryByText(/Purchase receipt/)).not.toBeInTheDocument();
  });

  it('names the form and the version the player was actually asked', async () => {
    railWithForm(formView());
    expect(await screen.findByText('Purchase receipt · v1')).toBeInTheDocument();
  });

  it('renders every field of a completed form, labelled, in position order', async () => {
    railWithForm(formView());
    expect(await screen.findByText('All 2 questions answered')).toBeInTheDocument();
    const labels = screen.getAllByRole('term').map((el) => el.textContent);
    expect(labels).toEqual(['Store', 'Date of purchase']);
    expect(screen.getByText('Google Play')).toBeInTheDocument();
    expect(screen.getByText('16 Aug 2026')).toBeInTheDocument();
  });

  it('counts progress while the form is still being answered', async () => {
    railWithForm(
      formView({
        status: 'in_progress',
        field_count: 2,
        answered_count: 1,
        fields: [
          formView().fields[0]!,
          {
            key: 'purchase_date',
            label: 'Date of purchase',
            position: 1,
            field_type: 'date',
            value: null,
            answered: false,
          },
        ],
      }),
    );
    expect(await screen.findByText('Player is answering · 1 of 2')).toBeInTheDocument();
  });

  // The assertion that carries the product requirement. A gap is a visible row.
  it('renders a partial form gaps and all, rather than dropping the blanks', async () => {
    railWithForm(
      formView({
        status: 'partial',
        answered_count: 1,
        fields: [
          formView().fields[0]!,
          {
            key: 'purchase_date',
            label: 'Date of purchase',
            position: 1,
            field_type: 'date',
            value: null,
            answered: false,
          },
        ],
      }),
    );
    expect(await screen.findByText('1 answered · 1 not answered')).toBeInTheDocument();
    expect(screen.getByText('Date of purchase')).toBeInTheDocument();
    expect(screen.getByText('Not answered')).toBeInTheDocument();
  });

  // A skipped form must be a visible row, never a missing section: the agent has
  // to be able to tell "declined" from "never offered".
  it('says the player skipped, and does not list four empty rows', async () => {
    railWithForm(
      formView({
        status: 'skipped',
        answered_count: 0,
        fields: formView().fields.map((f) => ({ ...f, value: null, answered: false })),
      }),
    );
    expect(await screen.findByText('Player skipped the questions')).toBeInTheDocument();
    expect(screen.getByText('Purchase receipt · v1')).toBeInTheDocument();
    expect(screen.queryByText('Not answered')).not.toBeInTheDocument();
  });

  // Values render off the answer's own snapshotted field_type. A field retyped
  // in a later version does not change how an older answer reads.
  it('renders a value by its snapshotted field_type', async () => {
    railWithForm(
      formView({
        field_count: 1,
        answered_count: 1,
        fields: [
          {
            key: 'purchase_date',
            label: 'Date of purchase',
            position: 0,
            field_type: 'short_text',
            value: '2026-08-16',
            answered: true,
          },
        ],
      }),
    );
    expect(await screen.findByText('2026-08-16')).toBeInTheDocument();
    expect(screen.queryByText('16 Aug 2026')).not.toBeInTheDocument();
  });

  // Read-only in every state. Nothing here edits, re-offers, or submits.
  it('offers no controls', async () => {
    railWithForm(formView());
    await screen.findByText('Purchase receipt · v1');
    const section = screen.getByRole('region', { name: 'Form' });
    expect(within(section).queryAllByRole('button')).toHaveLength(0);
    expect(within(section).queryAllByRole('textbox')).toHaveLength(0);
  });

  // The rail is one query, so a malformed form block must not take the other two
  // sections down with it.
  it('renders the other sections when the form block is absent from the payload', async () => {
    const { form: _omitted, ...withoutForm } = {
      ...contextResponse({ status: 'not_captured' }),
      form: null,
    };
    vi.mocked(fetchConversationContext).mockResolvedValue(
      withoutForm as unknown as AgentConversationContextResponse,
    );
    renderRail();
    expect(await screen.findByText('No player state was captured')).toBeInTheDocument();
    expect(screen.getByText('Tickets')).toBeInTheDocument();
  });
});
```

Add `within` to the `@testing-library/react` import at the top of the file.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Inbox/components/ContextRail.test.tsx`
Expected: FAIL — nothing renders "Purchase receipt · v1".

- [ ] **Step 3: Write `FormPanel.tsx`**

```tsx
import type { AgentFormView } from '@support/types';
import { cn } from '../../../../lib/cn.ts';
import { formAnswerValue } from './formAnswerValue.ts';
import { formStatusLine } from './formStatusLine.ts';

/**
 * The third stacked section of the rail: what the bot asked before handoff and
 * what came back. Read-only in every state — nothing here edits a form,
 * re-offers one, or shows correction history.
 *
 * Four states render; the fifth — no form at all — is the caller omitting this
 * component entirely, the same call the raw section makes when it is `{}`.
 *
 * Labels come from the API already resolved against the submission's version,
 * and values carry the answer's own snapshotted type. This component resolves
 * nothing.
 */
export function FormPanel({ form }: { form: AgentFormView }) {
  // A skipped form has no answers by construction, so listing every field as
  // "Not answered" would repeat the status line four times. In every other
  // state the gaps are the point and stay visible as rows.
  const showFields = form.status !== 'skipped' && form.fields.length > 0;

  return (
    <section className="px-4 py-3" aria-label="Form">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Form</h3>
      <p className="mt-1 text-sm font-medium text-text">
        {form.form_name} · v{form.form_version}
      </p>
      <p className="mt-0.5 text-xs text-muted">
        {formStatusLine(form.status, form.answered_count, form.field_count)}
      </p>
      {showFields && (
        <dl className="mt-2 flex flex-col gap-1.5">
          {form.fields.map((field) => (
            <div key={field.key} className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-xs text-muted">{field.label}</dt>
              <dd
                className={cn(
                  'truncate text-right text-sm',
                  field.answered ? 'text-text' : 'text-muted italic',
                )}
              >
                {formAnswerValue(field.field_type, field.value, field.answered)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Mount it in the rail**

In `ContextRail.tsx`, add the import:

```typescript
import { FormPanel } from './context/FormPanel.tsx';
```

and render it below `TicketList`, inside the `contextQuery.data ?` branch:

```tsx
<TicketList
  tickets={contextQuery.data.tickets}
  summary={contextQuery.data.summary}
  currentId={conversationId}
  onSelect={(id) => void navigate(`/inbox/${id}`)}
/>;
{
  /* Five states, and this is the one that renders nothing: no form
                  means no section, following the raw-is-{} precedent. */
}
{
  contextQuery.data.form ? <FormPanel form={contextQuery.data.form} /> : null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Inbox/components/ContextRail.test.tsx`
Expected: PASS, including the pre-existing player-state and ticket-list blocks.

- [ ] **Step 6: Typecheck and lint**

Run: `cd frontend && pnpm typecheck`
Expected: PASS (this runs `tsc --noEmit` and `eslint .`).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Inbox/components/context/FormPanel.tsx \
        frontend/src/surfaces/agent-console/pages/Inbox/components/ContextRail.tsx \
        frontend/src/surfaces/agent-console/pages/Inbox/components/ContextRail.test.tsx
git commit -m "feat(context-rail): render the form section in all five states"
```

---

## Task 5: One narrow invalidation on `conversation:phase_changed`

The rail's query is deliberately socket-free with a long `staleTime`, because the snapshot is immutable and ticket history moves on the order of days. **A form in progress is not immutable**, and the unassigned queue is `assigned_agent_id IS NULL AND status NOT IN (resolved, closed)` — which includes `bot_active`, so an agent genuinely can open a ticket while the player is on question two. One trigger, for the one mutable thing in the panel. The `staleTime` is not dropped.

**Files:**

- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ContextRail.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Inbox/components/ContextRail.test.tsx`

**Interfaces:**

- Consumes: `createSocket` from `frontend/src/features/chat/api/socket.ts` (same import `ThreadPanel.tsx` and `ConversationList.tsx` use).
- Produces: nothing new; the rail's `['conversation', id, 'context']` query refetches on `conversation:phase_changed` and on nothing else.

- [ ] **Step 1: Write the failing tests**

The existing `ContextRail.test.tsx` does not mock the socket module. Add the mock at the top of the file, on the `ConversationList.test.tsx` pattern — captured handlers, not a black hole:

```typescript
const socket = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  closed: 0,
}));

vi.mock('../../../../../features/chat/api/socket.ts', () => ({
  createSocket: () => ({
    on: (event: string, handler: (payload: unknown) => void) => {
      socket.handlers.set(event, handler);
    },
    emit: vi.fn(),
    close: () => {
      socket.closed += 1;
    },
  }),
}));
```

Extend the existing `beforeEach` to clear it:

```typescript
beforeEach(() => {
  vi.resetAllMocks();
  socket.handlers.clear();
  socket.closed = 0;
});
```

and add `act` and `waitFor` to the `@testing-library/react` import. Then append:

```typescript
describe('ContextRail invalidation', () => {
  it('refetches the context when the conversation phase changes', async () => {
    vi.mocked(fetchConversationContext).mockResolvedValue({
      ...contextResponse({ status: 'no_session' }),
      form: formView({ status: 'in_progress', answered_count: 1 }),
    });
    renderRail();
    await screen.findByText('Purchase receipt · v1');
    expect(fetchConversationContext).toHaveBeenCalledTimes(1);

    const handler = socket.handlers.get('conversation:phase_changed');
    if (!handler) throw new Error('the rail never subscribed to conversation:phase_changed');
    act(() => handler({ conversation_id: 'c1', confirm_phase: 'none' }));

    // A form in progress is the one mutable thing in the panel, and this is the
    // only event that moves it.
    await waitFor(() => expect(fetchConversationContext).toHaveBeenCalledTimes(2));
  });

  it('ignores unrelated socket traffic', async () => {
    vi.mocked(fetchConversationContext).mockResolvedValue(
      contextResponse({ status: 'no_session' }),
    );
    renderRail();
    await screen.findByText('No session was attached to this ticket');
    expect(fetchConversationContext).toHaveBeenCalledTimes(1);

    // The rail subscribes to exactly one event. Player state is immutable by
    // construction and ticket history moves on the order of days; refetching
    // the whole rail on every inbound message would undo the long staleTime.
    expect(socket.handlers.has('message:new')).toBe(false);
    expect(socket.handlers.has('message:read')).toBe(false);
    expect(socket.handlers.has('conversation:changed')).toBe(false);
  });

  it('closes the socket on unmount', async () => {
    vi.mocked(fetchConversationContext).mockResolvedValue(
      contextResponse({ status: 'no_session' }),
    );
    const { unmount } = renderRail();
    await screen.findByText('No session was attached to this ticket');
    unmount();
    expect(socket.closed).toBe(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Inbox/components/ContextRail.test.tsx`
Expected: FAIL — "the rail never subscribed to conversation:phase_changed".

- [ ] **Step 3: Subscribe, to exactly one event**

In `ContextRail.tsx`, extend the imports:

```typescript
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createSocket } from '../../../../../features/chat/api/socket.ts';
```

Inside the component, above the `useQuery`, add `const queryClient = useQueryClient()`, and below it:

```typescript
// The one narrow trigger. The staleTime above is not dropped: player state is
// immutable by construction and ticket history moves on the order of days.
// The exception is a form in progress, and bot_active conversations sit in the
// unassigned queue, so an agent can open a ticket mid-form. A missed
// invalidation leaves the panel stale rather than wrong, and the next
// navigation corrects it.
useEffect(() => {
  const socket = createSocket(token, 'agent');
  // Inside 'connect', not once at setup: rooms live on the server's socket
  // instance, so every reconnect lands in a socket that has joined nothing.
  socket.on('connect', () => {
    socket.emit('join_conversation', { conversation_id: conversationId });
  });
  socket.on('conversation:phase_changed', () => {
    void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'context'] });
  });
  return () => {
    socket.emit('leave_conversation', { conversation_id: conversationId });
    socket.close();
  };
}, [token, conversationId, queryClient]);
```

Do not subscribe to anything else, and do not change `staleTime`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Inbox/components/ContextRail.test.tsx`
Expected: PASS, all blocks.

- [ ] **Step 5: Confirm read-only tickets are still unaffected**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx`
Expected: PASS — in particular the assertion that `markAgentMessagesRead` is **not** called for a read-only ticket. Nothing in this slice touches that guard; this run is the proof, not the fix.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Inbox/components/ContextRail.tsx \
        frontend/src/surfaces/agent-console/pages/Inbox/components/ContextRail.test.tsx
git commit -m "feat(context-rail): invalidate the context query on conversation:phase_changed"
```

---

## Task 6: The "Answering questions" queue label

No new data. `AgentConversationSummary` already carries `confirm_phase` (`conversationsService.ts:19,46`; `packages/types/src/chat.ts:73`), and slice 2 added `'form'` to the enum. Without the label, an unassigned `bot_active` ticket with no agent and a half-filled form reads as a stuck ticket.

**Files:**

- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationRow.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx`

**Interfaces:**

- Consumes: `AgentConversationSummary.confirm_phase` — already on the type and already in the list query's select. **Do not add a column, a field, or a query.**
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the failing test**

Append to `ConversationList.test.tsx`:

```typescript
describe('ConversationList form label', () => {
  it('labels a row whose player is still answering the form', async () => {
    vi.spyOn(agentApi, 'fetchInbox').mockImplementation((_token, status) =>
      Promise.resolve({
        conversations:
          status === 'unassigned'
            ? [{ ...UNASSIGNED_CONVERSATION, status: 'bot_active' as const, confirm_phase: 'form' as const }]
            : [],
      }),
    )

    renderWithClient(<ConversationList token="tok" selectedId={null} onSelect={() => {}} />)

    // Without this, an unassigned bot_active ticket with no agent and a
    // half-filled form reads as a stuck ticket.
    expect(await screen.findByText('Answering questions')).toBeInTheDocument()
  })

  it('does not label a row in any other phase', async () => {
    vi.spyOn(agentApi, 'fetchInbox').mockImplementation((_token, status) =>
      Promise.resolve({ conversations: status === 'unassigned' ? [UNASSIGNED_CONVERSATION] : [] }),
    )

    renderWithClient(<ConversationList token="tok" selectedId={null} onSelect={() => {}} />)

    await screen.findByText('player-42')
    expect(screen.queryByText('Answering questions')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx`
Expected: FAIL — "Answering questions" is not in the document.

- [ ] **Step 3: Render the label**

In `ConversationRow.tsx`, replace the badge row (lines 57-60) with:

```tsx
<div className="flex items-center justify-between gap-2">
  <span className="truncate text-sm font-medium">{conversation.player.external_player_id}</span>
  <span className="flex shrink-0 items-center gap-1.5">
    {/* No new data: confirm_phase already rides on the summary. A
              bot_active ticket sits in the unassigned queue, so without this a
              half-filled form reads as a stuck ticket. */}
    {conversation.confirm_phase === 'form' && (
      <span className="text-xs text-muted">Answering questions</span>
    )}
    <Badge variant={STATUS_BADGE_VARIANT[conversation.status]}>{conversation.status}</Badge>
  </span>
</div>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx`
Expected: PASS, including the pre-existing claim-flow and socket blocks.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationRow.tsx \
        frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx
git commit -m "feat(inbox): label a queue row whose player is answering the form"
```

---

## Task 7: Full-suite verification against §3.5

No code. This task exists because every prior task ran a subset, and the endpoint's response type changed under every consumer of it.

**Files:** none modified unless something below fails.

- [ ] **Step 1: Run the whole suite**

Run (from the repo root, Postgres and Redis up):

```bash
pnpm test
```

Expected: PASS. If `backend/tests/agent.conversationContext.test.ts` or any frontend test that builds an `AgentConversationContextResponse` literal fails on a missing `form` property, add `form: null` to that literal — the type is intentionally required so no consumer can silently forget it.

- [ ] **Step 2: Typecheck the workspace**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Walk the spec's verification list and tick each one**

Every item in §3.5 must map to a test that exists and passes. Confirm each by name:

| §3.5 requirement                                                                  | Test                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each of the five states renders, including the omission                           | `ContextRail.test.tsx` → "omits the section entirely when there is no form", "counts progress while the form is still being answered", "renders every field of a completed form…", "renders a partial form gaps and all…", "says the player skipped…" |
| `partial` renders gaps rather than dropping them                                  | `ContextRail.test.tsx` → "renders a partial form gaps and all…"; `agent.formContext.test.ts` → "keeps unanswered fields as rows rather than dropping them"                                                                                            |
| Labels resolve against the submission's version after a v2 edit                   | `agent.formContext.test.ts` → "labels against the submission version after the form is edited to v2"                                                                                                                                                  |
| Values render from the answer's snapshotted `field_type`                          | `formAnswerValue.test.ts` → "renders by the snapshotted type…"; `ContextRail.test.tsx` → "renders a value by its snapshotted field_type"; `agent.formContext.test.ts` → "takes field_type from the answer…"                                           |
| The rail invalidates on `conversation:phase_changed` and not on unrelated traffic | `ContextRail.test.tsx` → "refetches the context when the conversation phase changes", "ignores unrelated socket traffic"                                                                                                                              |
| `/context` returns `form: null` when the subintent has no form                    | `agent.formContext.test.ts` → "returns form: null when the conversation was never offered one"                                                                                                                                                        |
| The other two rail sections render normally when the form block errors            | `ContextRail.test.tsx` → "renders the other sections when the form block is absent from the payload"                                                                                                                                                  |
| Read-only tickets unaffected; `markAgentMessagesRead` still not called            | `ThreadPanel.test.tsx` (unchanged, must still pass); `ContextRail.test.tsx` → "offers no controls"                                                                                                                                                    |
| Queue label (§3.4)                                                                | `ConversationList.test.tsx` → "labels a row whose player is still answering the form", "does not label a row in any other phase"                                                                                                                      |

- [ ] **Step 4: Check the Swagger document by eye**

Run `pnpm dev`, open `http://localhost:4000/docs`, find **Agent Conversation Context**, and confirm the 200 schema shows `form` as a nullable object with `form_name`, `form_version`, `status`, `field_count`, `answered_count` and `fields`.

- [ ] **Step 5: Commit anything Step 1 needed**

```bash
git add -A
git commit -m "test: keep context response consumers in step with the form block"
```

Skip this step if nothing changed.

---

## Self-review notes

Recorded so the executing engineer knows these were decided, not overlooked.

1. **Why the API returns `form: null` and the frontend does the omitting.** §3.5 asks for `form: null` explicitly, and the omission is a rendering decision — the same shape the rail already uses for `raw`, which is returned in full and collapsed or hidden client-side.

2. **Why `answered_count` and `field_count` are on the payload rather than counted in the panel.** The panel could count `fields.filter(f => f.answered)`, but `field_count` is the version's field count and an orphaned answer row (a key not in the version) must not inflate the denominator. Deriving it server-side, next to the version that defines it, is the only place both numbers are unambiguous.

3. **Why the skipped state hides the field rows.** The five-state table gives `skipped` one line of copy and nothing else, and a skipped submission has zero answers by construction, so every row would read "Not answered" — repeating the status line four times. `partial` is where gaps carry information and they stay visible there.

4. **Why the answers are folded in JS instead of `DISTINCT ON`.** A submission is one row per field plus corrections. `INDEX (form_submission_id, field_key, created_at)` still serves the ordered read, and folding keeps the query inside Drizzle's typed builder alongside the other two reads in the same transaction.

5. **Why `getFormView` reads the newest submission rather than asserting there is one.** `UNIQUE (conversation_id, form_id)` permits one submission per form, not one per conversation. Re-offering is out of scope today, so `limit 1` newest-first is a no-op — and if a second form is ever offered, the rail shows the current one rather than an arbitrary row.

6. **Why no `logger` call was added.** Nothing here is a decision worth watching happen and nothing has a negative outcome to make falsifiable. The events that answer questions about form turns (`form_offered`, `form_field_answered`, `form_completed`) are slice 2's, already written.
