# Forms builder — admin implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the admin authoring surface for forms — backend CRUD/publish/archive/mapping routes plus the `/forms` console page — per `docs/specs/2026-08-19-forms-builder-admin-design.md`.

**Architecture:** Mirrors the existing `articles` slice end to end: `formsRouter` → `formsController` → `formsService` (Express + Zod + Drizzle, `withWorkspace` transaction scoping), and a `KnowledgeBase`-shaped frontend page (`FormTable` + `FormEditorSheet` in a `Sheet`, deep-linkable via `/forms/:id`). No schema or RLS changes — `form`/`form_version`/`subintent.form_id` already exist (`backend/src/shared/db/schema/forms.ts`, `taxonomy.ts`) and RLS already covers every workspace-scoped table generically (`backend/src/shared/db/sql/002_rls.sql`).

**Tech Stack:** Express 5, Zod, Drizzle ORM, Vitest + supertest (backend); React, TanStack Query, react-router-dom, shadcn/ui, Vitest + Testing Library (frontend).

## Global Constraints

- No hard deletes, no form-deletion route — archive only (`CLAUDE.md`).
- Every new route registered in `backend/src/docs/openapi.ts` (`CLAUDE.md`, spec).
- Any client-supplied id used as a FK must be confirmed visible with a scoped `SELECT` first — FK checks bypass RLS (`CLAUDE.md`).
- Permission checks run at the API; hiding a control in the UI is never the enforcement point (`CLAUDE.md`).
- Tailwind v4 utilities only, tokens (`bg-surface`, `text-text`, `text-accent`, `rounded-card`, etc.) for anything in `components`/`features`, surface-local classes otherwise — no hand-written CSS (`CLAUDE.md`).
- `attachment` and `time` field types must never be offered by the field-type picker, and the service layer must reject them even though `formFieldsSchema` alone permits them (spec).
- No drag-and-drop library — up/down buttons only (spec).
- Expect `404`, not `403`, from RLS-invisible resources — "not yours" and "not there" are indistinguishable (`CLAUDE.md`).

---

## Parallelization map

Task 1 is a hard prerequisite for everything else (both backend and frontend import `@support/types`). After Task 1 lands, the rest fans out:

```
Task 1 (types) ──┬─→ Task 2 (formsService) ──┬─→ Task 4 (controller+router+mount+CORS) ──┬─→ Task 5 (OpenAPI)
                  │                          │                                          └─→ Task 6 (backend tests)
                  ├─→ Task 3 (taxonomy read)  │
                  │                          │
                  ├─→ Task 7 (agentApi.ts) ───┴─→ Task 9 (FormTable.tsx) ──┐
                  │                                                       ├─→ Task 11 (Forms.tsx + route + test)
                  └─→ Task 8 (formForm.ts + test) ──→ Task 10 (FormEditorSheet.tsx) ─┘
```

Batches you can hand to independent subagents concurrently:

- **Batch A** (after Task 1): Tasks 2, 3, 7, 8 — no dependencies on each other.
- **Batch B**: Task 4 (needs 2), Task 9 (needs 7).
- **Batch C**: Task 5, Task 6 (both need 4; Task 6 also needs 3), Task 10 (needs 7 and 8).
- **Batch D**: Task 11 (needs 9 and 10).

---

### Task 1: Shared types — admin form contracts

**Files:**

- Modify: `packages/types/src/forms.ts`
- Modify: `packages/types/src/articles.ts`

**Interfaces:**

- Produces: `CreateFormBody`, `UpdateFormBody`, `SetFormSubintentsBody` (Zod schemas), `FormSummary`, `FormsListResponse`, `FormMappedSubintent`, `FormVersionView`, `FormDetail`, `CreateFormResponse` (types) — every later backend/frontend task imports these from `@support/types`.
- Modifies `IntentSubintentView` (adds `formId: string | null`, `archivedAt: string | null`) — read by Task 3 and Task 10.

- [ ] **Step 1: Add admin form types to `packages/types/src/forms.ts`**

Append to the end of the file:

```ts
export const CreateFormBody = z.object({ name: z.string().min(1).max(200) });

export const UpdateFormBody = z.object({
  name: z.string().min(1).max(200).optional(),
  fields: formFieldsSchema.optional(),
});

export const SetFormSubintentsBody = z.object({ subintentIds: z.array(z.uuid()) });

export type FormSummary = {
  id: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
  mappedSubintentCount: number;
  publishedVersion: number | null;
  hasDraft: boolean;
};
export type FormsListResponse = { forms: FormSummary[] };

export type FormMappedSubintent = { id: string; name: string; intentId: string };

export type FormVersionView = { version: number; fields: FormField[]; publishedAt: string | null };

export type FormDetail = {
  id: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
  draft: FormVersionView | null;
  published: FormVersionView | null;
  subintents: FormMappedSubintent[];
};

export type CreateFormResponse = { id: string; draftVersionId: string };
```

- [ ] **Step 2: Add `formId`/`archivedAt` to `IntentSubintentView` in `packages/types/src/articles.ts`**

Change:

```ts
export type IntentSubintentView = { id: string; name: string };
```

to:

```ts
export type IntentSubintentView = {
  id: string;
  name: string;
  formId: string | null;
  archivedAt: string | null;
};
```

- [ ] **Step 3: Typecheck the types package**

Run: `pnpm --filter @support/types typecheck` (or `pnpm typecheck` from repo root if the package has no standalone script — check `packages/types/package.json` first)
Expected: no errors. `IntentsResponse`'s consumers (`taxonomyService.listIntents`, `agentApi.ts`'s `fetchIntents` callers) will show type errors until Tasks 3/7 update them — that is expected and resolved by those tasks, not this one.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/forms.ts packages/types/src/articles.ts
git commit -m "types: add forms-admin contracts and additive intents fields"
```

---

### Task 2: Backend service — `formsService.ts`

**Files:**

- Create: `backend/src/agent/services/formsService.ts`
- Test: `backend/tests/agent.forms.test.ts` (this task adds only the service-level tests; Task 6 adds the router-level ones — see that task for why they're split)

**Interfaces:**

- Consumes: `withWorkspace` (`backend/src/shared/db/withWorkspace.ts`, signature `withWorkspace<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T>`), `form`/`formVersion` tables (`backend/src/shared/db/schema/forms.ts`), `subintent` table (`backend/src/shared/db/schema/taxonomy.ts`), `AgentContext` (`backend/src/shared/middleware/requireAgentSession.ts`, has `agentId`/`workspaceId`), `formFieldsSchema`/`publishedFormFieldsSchema` (`@support/types`).
- Produces: `listForms`, `createForm`, `getForm`, `updateForm`, `publishForm`, `archiveForm`, `setFormSubintents` — consumed by Task 4's controller.

- [ ] **Step 1: Write the failing tests for `listForms` and `createForm`**

Create `backend/tests/agent.forms.test.ts`:

```ts
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';
import {
  listForms,
  createForm,
  getForm,
  updateForm,
  publishForm,
  archiveForm,
  setFormSubintents,
} from '../src/agent/services/formsService.ts';

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function seedCtx(workspaceId: string): Promise<{ agentId: string; workspaceId: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Test Agent') returning id`,
    [`agent-${Math.random().toString(36).slice(2)}@example.test`],
  );
  return { agentId: rows[0]!.id, workspaceId };
}

describe('createForm', () => {
  it('creates a form with a v1 empty draft', async () => {
    const workspaceId = await seedWorkspace();
    const ctx = await seedCtx(workspaceId);

    const result = await createForm(ctx, 'Bug Report');

    const detail = await getForm(ctx, result.id);
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe('Bug Report');
    expect(detail!.draft).toEqual({ version: 1, fields: [], publishedAt: null });
    expect(detail!.published).toBeNull();
  });
});

describe('listForms', () => {
  it('reports mappedSubintentCount, publishedVersion and hasDraft', async () => {
    const workspaceId = await seedWorkspace();
    const ctx = await seedCtx(workspaceId);
    const created = await createForm(ctx, 'Bug Report');

    const before = await listForms(ctx);
    expect(before.forms).toEqual([
      expect.objectContaining({
        id: created.id,
        publishedVersion: null,
        hasDraft: true,
        mappedSubintentCount: 0,
      }),
    ]);

    await updateForm(ctx, created.id, {
      fields: [
        { key: 'summary', label: 'Summary', type: 'short_text', isRequired: true, position: 0 },
      ],
    });
    await publishForm(ctx, created.id);

    const after = await listForms(ctx);
    expect(after.forms).toEqual([
      expect.objectContaining({ id: created.id, publishedVersion: 1, hasDraft: false }),
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter backend test agent.forms.test.ts`
Expected: FAIL — `formsService.ts` does not exist yet.

- [ ] **Step 3: Implement `formsService.ts`**

Create `backend/src/agent/services/formsService.ts`:

```ts
import { and, asc, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { formFieldsSchema, publishedFormFieldsSchema } from '@support/types';
import type {
  FormDetail,
  FormSummary,
  FormsListResponse,
  CreateFormResponse,
  FormField,
} from '@support/types';
import { form, formVersion } from '../../shared/db/schema/forms.ts';
import { subintent } from '../../shared/db/schema/taxonomy.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';

const DISALLOWED_FIELD_TYPES = new Set(['attachment', 'time']);

function assertNoDisallowedTypes(fields: FormField[]): boolean {
  return fields.every((f) => !DISALLOWED_FIELD_TYPES.has(f.type));
}

export async function listForms(ctx: AgentContext): Promise<FormsListResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const forms = await tx.select().from(form).orderBy(desc(form.createdAt));
    const versions = await tx
      .select({
        formId: formVersion.formId,
        version: formVersion.version,
        publishedAt: formVersion.publishedAt,
      })
      .from(formVersion);

    const mappedCounts = await tx
      .select({ formId: subintent.formId })
      .from(subintent)
      .where(
        inArray(
          subintent.formId,
          forms.map((f) => f.id),
        ),
      );

    const summaries: FormSummary[] = forms.map((f) => {
      const own = versions.filter((v) => v.formId === f.id);
      const published = own.filter((v) => v.publishedAt !== null);
      const highestPublished =
        published.length > 0 ? Math.max(...published.map((v) => v.version)) : null;
      const hasDraft = own.some((v) => v.publishedAt === null);
      return {
        id: f.id,
        name: f.name,
        archivedAt: f.archivedAt ? f.archivedAt.toISOString() : null,
        createdAt: f.createdAt.toISOString(),
        mappedSubintentCount: mappedCounts.filter((m) => m.formId === f.id).length,
        publishedVersion: highestPublished,
        hasDraft,
      };
    });
    return { forms: summaries };
  });
}

export async function createForm(ctx: AgentContext, name: string): Promise<CreateFormResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .insert(form)
      .values({ workspaceId: ctx.workspaceId, name, createdBy: ctx.agentId })
      .returning({ id: form.id });
    const [version] = await tx
      .insert(formVersion)
      .values({ workspaceId: ctx.workspaceId, formId: row!.id, version: 1, fields: [] })
      .returning({ id: formVersion.id });
    return { id: row!.id, draftVersionId: version!.id };
  });
}

async function loadDetail(
  tx: Parameters<Parameters<typeof withWorkspace>[1]>[0],
  formId: string,
): Promise<FormDetail | null> {
  const [row] = await tx.select().from(form).where(eq(form.id, formId)).limit(1);
  if (!row) return null;

  const versions = await tx
    .select()
    .from(formVersion)
    .where(eq(formVersion.formId, formId))
    .orderBy(desc(formVersion.version));
  const draftRow = versions.find((v) => v.publishedAt === null) ?? null;
  const publishedRow =
    versions.filter((v) => v.publishedAt !== null).sort((a, b) => b.version - a.version)[0] ?? null;

  const mapped = await tx
    .select({ id: subintent.id, name: subintent.name, intentId: subintent.intentId })
    .from(subintent)
    .where(eq(subintent.formId, formId))
    .orderBy(asc(subintent.name));

  return {
    id: row.id,
    name: row.name,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    draft: draftRow
      ? { version: draftRow.version, fields: draftRow.fields, publishedAt: null }
      : null,
    published: publishedRow
      ? {
          version: publishedRow.version,
          fields: publishedRow.fields,
          publishedAt: publishedRow.publishedAt!.toISOString(),
        }
      : null,
    subintents: mapped.map((m) => ({ id: m.id, name: m.name, intentId: m.intentId })),
  };
}

export async function getForm(ctx: AgentContext, formId: string): Promise<FormDetail | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => loadDetail(tx, formId));
}

export type UpdateFormResult =
  | { ok: true; form: FormDetail }
  | { ok: false; reason: 'not_found' | 'disallowed_field_type' | 'invalid_fields' };

export async function updateForm(
  ctx: AgentContext,
  formId: string,
  patch: { name?: string; fields?: FormField[] },
): Promise<UpdateFormResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(form).where(eq(form.id, formId)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };

    if (patch.fields !== undefined) {
      const parsed = formFieldsSchema.safeParse(patch.fields);
      if (!parsed.success) return { ok: false, reason: 'invalid_fields' };
      if (!assertNoDisallowedTypes(parsed.data))
        return { ok: false, reason: 'disallowed_field_type' };
    }

    if (patch.name !== undefined) {
      await tx.update(form).set({ name: patch.name }).where(eq(form.id, formId));
    }

    if (patch.fields !== undefined) {
      const versions = await tx
        .select()
        .from(formVersion)
        .where(eq(formVersion.formId, formId))
        .orderBy(desc(formVersion.version));
      const latest = versions[0]!;
      if (latest.publishedAt === null) {
        await tx
          .update(formVersion)
          .set({ fields: patch.fields })
          .where(eq(formVersion.id, latest.id));
      } else {
        await tx.insert(formVersion).values({
          workspaceId: ctx.workspaceId,
          formId,
          version: latest.version + 1,
          fields: patch.fields,
        });
      }
    }

    return { ok: true, form: (await loadDetail(tx, formId))! };
  });
}

export type PublishFormResult =
  { ok: true; form: FormDetail } | { ok: false; reason: 'not_found' | 'no_draft' | 'empty_draft' };

export async function publishForm(ctx: AgentContext, formId: string): Promise<PublishFormResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(form).where(eq(form.id, formId)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };

    const [draft] = await tx
      .select()
      .from(formVersion)
      .where(and(eq(formVersion.formId, formId), isNull(formVersion.publishedAt)))
      .limit(1);
    if (!draft) return { ok: false, reason: 'no_draft' };

    const parsed = publishedFormFieldsSchema.safeParse(draft.fields);
    if (!parsed.success) return { ok: false, reason: 'empty_draft' };

    await tx
      .update(formVersion)
      .set({ publishedAt: new Date(), publishedBy: ctx.agentId })
      .where(eq(formVersion.id, draft.id));

    return { ok: true, form: (await loadDetail(tx, formId))! };
  });
}

export type ArchiveFormResult = { ok: true; form: FormDetail } | { ok: false; reason: 'not_found' };

export async function archiveForm(ctx: AgentContext, formId: string): Promise<ArchiveFormResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .update(form)
      .set({ archivedAt: new Date() })
      .where(eq(form.id, formId))
      .returning({ id: form.id });
    if (!row) return { ok: false, reason: 'not_found' };
    return { ok: true, form: (await loadDetail(tx, formId))! };
  });
}

export type SetFormSubintentsResult =
  { ok: true; form: FormDetail } | { ok: false; reason: 'not_found' | 'invalid_subintent' };

export async function setFormSubintents(
  ctx: AgentContext,
  formId: string,
  subintentIds: string[],
): Promise<SetFormSubintentsResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx
      .select({ id: form.id })
      .from(form)
      .where(eq(form.id, formId))
      .limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };

    if (subintentIds.length > 0) {
      const visible = await tx
        .select({ id: subintent.id })
        .from(subintent)
        .where(and(inArray(subintent.id, subintentIds), isNull(subintent.archivedAt)));
      if (visible.length !== subintentIds.length) return { ok: false, reason: 'invalid_subintent' };
    }

    const clearWhere =
      subintentIds.length > 0
        ? and(eq(subintent.formId, formId), notInArray(subintent.id, subintentIds))
        : eq(subintent.formId, formId);
    await tx.update(subintent).set({ formId: null }).where(clearWhere);

    if (subintentIds.length > 0) {
      await tx.update(subintent).set({ formId }).where(inArray(subintent.id, subintentIds));
    }

    return { ok: true, form: (await loadDetail(tx, formId))! };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter backend test agent.forms.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/services/formsService.ts backend/tests/agent.forms.test.ts
git commit -m "feat(forms): add formsService with auto-fork versioning"
```

---

### Task 3: Backend read-path — additive `formId`/`archivedAt` on `GET /agent/intents`

**Files:**

- Modify: `backend/src/agent/services/taxonomyService.ts`
- Test: `backend/tests/agent.taxonomy.test.ts`

**Interfaces:**

- Consumes: `IntentSubintentView` (Task 1, now carries `formId`/`archivedAt`).
- Produces: `listIntents` returning the additive fields — consumed by Task 6 (mapping tests) and Task 10 (subintent picker).

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/agent.taxonomy.test.ts`, inside `describe('GET /intents', ...)`:

```ts
it('includes formId and archivedAt on each subintent', async () => {
  const workspaceId = await seedWorkspace();
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
    [workspaceId],
  );
  const { rows: formRows } = await ownerPool.query<{ id: string }>(
    `insert into form (workspace_id, name) values ($1, 'Refund Form') returning id`,
    [workspaceId],
  );
  await ownerPool.query(
    `insert into subintent (workspace_id, intent_id, name, form_id) values ($1, $2, 'Refunds', $3)`,
    [workspaceId, rows[0]!.id, formRows[0]!.id],
  );
  const { token } = await seedAgentWithRole(workspaceId, 'agent');

  const res = await request(app)
    .get('/intents')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);

  expect(res.body.intents[0].subintents[0]).toEqual({
    id: expect.any(String),
    name: 'Refunds',
    formId: formRows[0]!.id,
    archivedAt: null,
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter backend test agent.taxonomy.test.ts`
Expected: FAIL — `formId`/`archivedAt` are `undefined` in the response.

- [ ] **Step 3: Update `listIntents`**

In `backend/src/agent/services/taxonomyService.ts`, change the subintent select and mapping:

```ts
const subintents = await tx
  .select({
    id: subintent.id,
    name: subintent.name,
    intentId: subintent.intentId,
    formId: subintent.formId,
    archivedAt: subintent.archivedAt,
  })
  .from(subintent)
  .orderBy(asc(subintent.name));
return {
  intents: intents.map((i) => ({
    id: i.id,
    name: i.name,
    subintents: subintents
      .filter((s) => s.intentId === i.id)
      .map((s) => ({
        id: s.id,
        name: s.name,
        formId: s.formId,
        archivedAt: s.archivedAt ? s.archivedAt.toISOString() : null,
      })),
  })),
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter backend test agent.taxonomy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/services/taxonomyService.ts backend/tests/agent.taxonomy.test.ts
git commit -m "feat(taxonomy): expose formId and archivedAt on GET /agent/intents"
```

---

### Task 4: Backend controller + router + mount + CORS

**Files:**

- Create: `backend/src/agent/controllers/formsController.ts`
- Create: `backend/src/agent/routers/formsRouter.ts`
- Modify: `backend/src/agent/router.ts`
- Modify: `backend/src/app.ts`

**Interfaces:**

- Consumes: `formsService` exports (Task 2), `requireWorkspaceRole`/`requireAdminRole` (`backend/src/shared/middleware/`), `sendError` (`backend/src/errors.ts`), `CreateFormBody`/`UpdateFormBody`/`SetFormSubintentsBody` (Task 1).
- Produces: `formsRouter`, mounted on `agentRouter` — consumed by Task 5 (OpenAPI) and Task 6 (router tests).

- [ ] **Step 1: Confirm CORS allows PATCH, and fix it if not**

Read `backend/src/app.ts`. Its `cors()` call currently lists `methods: ['GET', 'POST']` — PATCH is missing, yet `articlesRouter.patch('/articles/:id', ...)` already exists and is called by `updateArticle` in the console. This means either the console currently shares an origin with the API (no preflight), or this is a live gap for any deployment where they don't. Since the spec allows falling back to POST-with-verb-suffix if PATCH isn't available, but PATCH is _already_ the established pattern for `articles`, fix the actual gap instead of avoiding it a second time:

Change:

```ts
      methods: ['GET', 'POST'],
```

to:

```ts
      methods: ['GET', 'POST', 'PATCH'],
```

- [ ] **Step 2: Write the controller**

Create `backend/src/agent/controllers/formsController.ts`:

```ts
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { CreateFormBody, UpdateFormBody, SetFormSubintentsBody } from '@support/types';
import { sendError } from '../../errors.ts';
import {
  archiveForm,
  createForm,
  getForm,
  listForms,
  publishForm,
  setFormSubintents,
  updateForm,
} from '../services/formsService.ts';

const FormIdParams = z.object({ id: z.uuid() });

export const listFormsHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await listForms(req.agent!));
};

export const createFormHandler: RequestHandler = async (req, res) => {
  const body = CreateFormBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'name is required.');
    return;
  }
  res.status(201).json(await createForm(req.agent!, body.data.name));
};

export const getFormHandler: RequestHandler = async (req, res) => {
  const params = FormIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid form id is required.');
    return;
  }
  const found = await getForm(req.agent!, params.data.id);
  if (!found) {
    sendError(res, 404, 'not_found', 'Form not found.');
    return;
  }
  res.status(200).json(found);
};

export const updateFormHandler: RequestHandler = async (req, res) => {
  const params = FormIdParams.safeParse(req.params);
  const body = UpdateFormBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'A valid form id and patch body are required.');
    return;
  }
  const result = await updateForm(req.agent!, params.data.id, body.data);
  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : 422;
    sendError(
      res,
      status,
      result.reason === 'not_found' ? 'not_found' : 'invalid_request',
      formErrorMessage(result.reason),
    );
    return;
  }
  res.status(200).json(result.form);
};

export const publishFormHandler: RequestHandler = async (req, res) => {
  const params = FormIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid form id is required.');
    return;
  }
  const result = await publishForm(req.agent!, params.data.id);
  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : 409;
    sendError(
      res,
      status,
      result.reason === 'not_found' ? 'not_found' : 'conflict',
      formErrorMessage(result.reason),
    );
    return;
  }
  res.status(200).json(result.form);
};

export const archiveFormHandler: RequestHandler = async (req, res) => {
  const params = FormIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid form id is required.');
    return;
  }
  const result = await archiveForm(req.agent!, params.data.id);
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Form not found.');
    return;
  }
  res.status(200).json(result.form);
};

export const setFormSubintentsHandler: RequestHandler = async (req, res) => {
  const params = FormIdParams.safeParse(req.params);
  const body = SetFormSubintentsBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'A valid form id and subintentIds array are required.');
    return;
  }
  const result = await setFormSubintents(req.agent!, params.data.id, body.data.subintentIds);
  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : 422;
    sendError(
      res,
      status,
      result.reason === 'not_found' ? 'not_found' : 'invalid_request',
      formErrorMessage(result.reason),
    );
    return;
  }
  res.status(200).json(result.form);
};

function formErrorMessage(reason: string): string {
  switch (reason) {
    case 'disallowed_field_type':
      return 'attachment and time fields cannot be added by the form builder.';
    case 'invalid_fields':
      return 'One or more fields failed validation.';
    case 'no_draft':
      return 'There is no draft to publish.';
    case 'empty_draft':
      return 'A published form must have at least one field.';
    case 'invalid_subintent':
      return 'One or more subintent ids are invalid, archived, or belong to another workspace.';
    default:
      return 'Request could not be completed.';
  }
}
```

- [ ] **Step 3: Write the router**

Create `backend/src/agent/routers/formsRouter.ts`:

```ts
import { Router } from 'express';
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts';
import { requireWorkspaceRole } from '../../shared/middleware/requireWorkspaceRole.ts';
import {
  archiveFormHandler,
  createFormHandler,
  getFormHandler,
  listFormsHandler,
  publishFormHandler,
  setFormSubintentsHandler,
  updateFormHandler,
} from '../controllers/formsController.ts';

const canBuildForms = requireWorkspaceRole('team_lead', 'admin');

export const formsRouter = Router();
formsRouter.get('/forms', canBuildForms, listFormsHandler);
formsRouter.post('/forms', canBuildForms, createFormHandler);
formsRouter.get('/forms/:id', canBuildForms, getFormHandler);
formsRouter.patch('/forms/:id', canBuildForms, updateFormHandler);
formsRouter.post('/forms/:id/publish', requireAdminRole, publishFormHandler);
formsRouter.post('/forms/:id/archive', requireAdminRole, archiveFormHandler);
formsRouter.patch('/forms/:id/subintents', canBuildForms, setFormSubintentsHandler);
```

- [ ] **Step 4: Mount the router**

In `backend/src/agent/router.ts`, add the import and registration:

```ts
import { formsRouter } from './routers/formsRouter.ts';
```

```ts
agentRouter.use(formsRouter);
```

(placed alongside the other `agentRouter.use(...)` calls, after `taxonomyRouter`)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter backend typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/agent/controllers/formsController.ts backend/src/agent/routers/formsRouter.ts backend/src/agent/router.ts backend/src/app.ts
git commit -m "feat(forms): add formsController/formsRouter, mount on agentRouter, allow PATCH in CORS"
```

---

### Task 5: OpenAPI registration

**Files:**

- Modify: `backend/src/docs/openapi.ts`

**Interfaces:**

- Consumes: `CreateFormBody`, `UpdateFormBody`, `SetFormSubintentsBody` (Task 1), `bearerAgentJwt` security scheme (already defined in the file, used by the `/agent/articles` registrations).

- [ ] **Step 1: Add route registrations**

Add after the `/agent/articles/{id}/archive` registration block (around the existing bot-config registrations):

```ts
registry.registerPath({
  method: 'get',
  path: '/agent/forms',
  summary: 'Agent List Forms',
  description:
    'Lists all forms for this workspace with mapping/version summary. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: { 200: { description: 'Forms list' }, 403: { description: 'Forbidden' } },
});

registry.registerPath({
  method: 'post',
  path: '/agent/forms',
  summary: 'Agent Create Form',
  description: 'Creates a form with an empty v1 draft. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(200) }) } },
    },
  },
  responses: { 201: { description: 'Form created' }, 403: { description: 'Forbidden' } },
});

registry.registerPath({
  method: 'get',
  path: '/agent/forms/{id}',
  summary: 'Agent Get Form',
  description:
    'Fetches one form: draft fields, published fields/version, mapped subintents. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 200: { description: 'Form detail' }, 404: { description: 'Not found' } },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/forms/{id}',
  summary: 'Agent Update Form',
  description:
    'Edits name and/or fields. Editing fields on a published form auto-forks a new draft version. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(200).optional(),
            fields: z.array(z.any()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Form updated' },
    404: { description: 'Not found' },
    422: { description: 'Invalid fields or a disallowed field type (attachment/time)' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/forms/{id}/publish',
  summary: 'Agent Publish Form',
  description: 'Publishes the current draft version. Admin only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Form published' },
    404: { description: 'Not found' },
    409: { description: 'No draft to publish, or the draft has zero fields' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/forms/{id}/archive',
  summary: 'Agent Archive Form',
  description: 'Archives a form. Idempotent. No cascade to mapped subintents. Admin only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 200: { description: 'Form archived' }, 404: { description: 'Not found' } },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/forms/{id}/subintents',
  summary: 'Agent Set Form Subintents',
  description: 'Replaces the full set of subintents mapped to this form. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: { 'application/json': { schema: z.object({ subintentIds: z.array(z.uuid()) }) } },
    },
  },
  responses: {
    200: { description: 'Mapping replaced' },
    404: { description: 'Form not found' },
    422: { description: 'A subintent id is invalid, archived, or belongs to another workspace' },
  },
});
```

- [ ] **Step 2: Verify the doc builds**

Run: `pnpm --filter backend dev` (or the backend's build/typecheck script) and open `http://localhost:4000/docs/json`
Expected: valid JSON containing the seven new `/agent/forms...` paths, no thrown errors from `openapi.ts`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/docs/openapi.ts
git commit -m "docs(openapi): register the forms admin routes"
```

---

### Task 6: Backend router-level tests — permissions, RLS, state machine

**Files:**

- Modify: `backend/tests/agent.forms.test.ts` (adds the HTTP-layer describe blocks; Task 2 already created this file with service-level tests)

**Interfaces:**

- Consumes: `formsRouter` (Task 4), `requireAgentSession`, `signAgentSession`, `seedWorkspace`/`truncateAll`/`ownerPool` (`backend/tests/helpers/db.ts`), `req` (`backend/tests/helpers/http.ts`).

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/agent.forms.test.ts` (above the existing service-level `describe` blocks, add the router app setup at the top of the file instead of the bare service imports — see Step 3 for the merged file layout):

```ts
describe('permission matrix', () => {
  it('403s an Agent on every forms route', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app).get('/forms').set('Authorization', `Bearer ${token}`).expect(403);
    await request(app)
      .post('/forms')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' })
      .expect(403);
  });

  it('403s a Team Lead on publish and archive specifically, 200s on everything else', async () => {
    const workspaceId = await seedWorkspace();
    const { token: leadToken } = await seedAgentWithRole(workspaceId, 'team_lead');

    const created = await request(app)
      .post('/forms')
      .set('Authorization', `Bearer ${leadToken}`)
      .send({ name: 'X' })
      .expect(201);
    const id = created.body.id as string;

    await request(app)
      .patch(`/forms/${id}`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({
        fields: [{ key: 'q', label: 'Q', type: 'short_text', isRequired: false, position: 0 }],
      })
      .expect(200);

    await request(app)
      .post(`/forms/${id}/publish`)
      .set('Authorization', `Bearer ${leadToken}`)
      .expect(403);
    await request(app)
      .post(`/forms/${id}/archive`)
      .set('Authorization', `Bearer ${leadToken}`)
      .expect(403);
  });
});

describe('auto-fork versioning over HTTP', () => {
  it('forks only when the latest version is published; editing a draft never creates a second draft', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await request(app)
      .post('/forms')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' })
      .expect(201);
    const id = created.body.id as string;

    await request(app)
      .patch(`/forms/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fields: [{ key: 'q1', label: 'Q1', type: 'short_text', isRequired: false, position: 0 }],
      })
      .expect(200);
    await request(app)
      .patch(`/forms/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fields: [
          { key: 'q1', label: 'Q1 edited', type: 'short_text', isRequired: false, position: 0 },
        ],
      })
      .expect(200);

    const afterTwoEdits = await request(app)
      .get(`/forms/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(afterTwoEdits.body.draft.version).toBe(1);

    await request(app)
      .post(`/forms/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app)
      .patch(`/forms/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fields: [{ key: 'q1', label: 'Q1 v2', type: 'short_text', isRequired: false, position: 0 }],
      })
      .expect(200);

    const afterPublishThenEdit = await request(app)
      .get(`/forms/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(afterPublishThenEdit.body.draft.version).toBe(2);
    expect(afterPublishThenEdit.body.published.version).toBe(1);
  });

  it('rejects publish with 409 when there is no draft', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await request(app)
      .post('/forms')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' })
      .expect(201);
    const id = created.body.id as string;
    await request(app)
      .patch(`/forms/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fields: [{ key: 'q', label: 'Q', type: 'short_text', isRequired: false, position: 0 }],
      })
      .expect(200);
    await request(app)
      .post(`/forms/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app)
      .post(`/forms/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });

  it('rejects publish with 409 when the draft is empty', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await request(app)
      .post('/forms')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' })
      .expect(201);

    await request(app)
      .post(`/forms/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });

  it('rejects attachment and time field types with 422', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await request(app)
      .post('/forms')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' })
      .expect(201);

    await request(app)
      .patch(`/forms/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fields: [{ key: 'a', label: 'A', type: 'attachment', isRequired: false, position: 0 }],
      })
      .expect(422);
  });

  it('archive is idempotent', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await request(app)
      .post('/forms')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' })
      .expect(201);

    await request(app)
      .post(`/forms/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(app)
      .post(`/forms/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});

describe('setFormSubintents', () => {
  it('clears the old mapping and rejects a cross-workspace subintent id', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceA, 'admin');
    const created = await request(app)
      .post('/forms')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' })
      .expect(201);

    const { rows: intentRows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [workspaceA],
    );
    const { rows: subA } = await ownerPool.query<{ id: string }>(
      `insert into subintent (workspace_id, intent_id, name) values ($1, $2, 'Refunds') returning id`,
      [workspaceA, intentRows[0]!.id],
    );
    const { rows: intentB } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [workspaceB],
    );
    const { rows: subB } = await ownerPool.query<{ id: string }>(
      `insert into subintent (workspace_id, intent_id, name) values ($1, $2, 'Other') returning id`,
      [workspaceB, intentB[0]!.id],
    );

    await request(app)
      .patch(`/forms/${created.body.id}/subintents`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentIds: [subB[0]!.id] })
      .expect(422);

    await request(app)
      .patch(`/forms/${created.body.id}/subintents`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentIds: [subA[0]!.id] })
      .expect(200);

    const { rows: check } = await ownerPool.query<{ form_id: string | null }>(
      `select form_id from subintent where id = $1`,
      [subA[0]!.id],
    );
    expect(check[0]!.form_id).toBe(created.body.id);
  });

  it('a subintent never ends up mapped to two forms', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const formOne = await request(app)
      .post('/forms')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'One' })
      .expect(201);
    const formTwo = await request(app)
      .post('/forms')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Two' })
      .expect(201);

    const { rows: intentRows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [workspaceId],
    );
    const { rows: subRows } = await ownerPool.query<{ id: string }>(
      `insert into subintent (workspace_id, intent_id, name) values ($1, $2, 'Refunds') returning id`,
      [workspaceId, intentRows[0]!.id],
    );

    await request(app)
      .patch(`/forms/${formOne.body.id}/subintents`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentIds: [subRows[0]!.id] })
      .expect(200);
    await request(app)
      .patch(`/forms/${formTwo.body.id}/subintents`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentIds: [subRows[0]!.id] })
      .expect(200);

    const { rows: check } = await ownerPool.query<{ form_id: string | null }>(
      `select form_id from subintent where id = $1`,
      [subRows[0]!.id],
    );
    expect(check[0]!.form_id).toBe(formTwo.body.id);
  });
});

describe('workspace isolation', () => {
  it('GET /forms/:id 404s for a form id from another workspace', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const { token: tokenB } = await seedAgentWithRole(workspaceB, 'admin');
    const created = await request(app)
      .post('/forms')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'X' })
      .expect(201);
    const { token: tokenA } = await seedAgentWithRole(workspaceA, 'admin');

    await request(app)
      .get(`/forms/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);
  });
});
```

- [ ] **Step 2: Merge the file's top section so both the service-level and router-level tests share one setup**

Replace the top of `backend/tests/agent.forms.test.ts` (the imports and `seedCtx` helper from Task 2, Step 1) with a version that also stands up the router app and a `seedAgentWithRole` helper (same shape as `agent.taxonomy.test.ts`):

```ts
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { formsRouter } from '../src/agent/routers/formsRouter.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';
import {
  archiveForm,
  createForm,
  getForm,
  listForms,
  publishForm,
  setFormSubintents,
  updateForm,
} from '../src/agent/services/formsService.ts';

const app = express();
app.use(express.json());
app.use(requireAgentSession, formsRouter);
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

async function seedCtx(workspaceId: string): Promise<{ agentId: string; workspaceId: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Test Agent') returning id`,
    [`agent-${Math.random().toString(36).slice(2)}@example.test`],
  );
  return { agentId: rows[0]!.id, workspaceId };
}

async function seedAgentWithRole(
  workspaceId: string,
  role: 'agent' | 'team_lead' | 'admin',
): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Test Agent') returning id`,
    [`${role}-${Math.random().toString(36).slice(2)}@example.test`],
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, $3)`,
    [workspaceId, agentId, role],
  );
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
  return { agentId, token };
}
```

- [ ] **Step 3: Run the full file**

Run: `pnpm --filter backend test agent.forms.test.ts`
Expected: PASS — every `describe` block, service-level and router-level.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/agent.forms.test.ts
git commit -m "test(forms): cover permissions, auto-fork versioning, RLS isolation and mapping rules"
```

---

### Task 7: Frontend API client — `agentApi.ts` additions

**Files:**

- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`

**Interfaces:**

- Consumes: `apiCall` (`frontend/src/lib/httpClient.ts`), `FormsListResponse`/`FormDetail`/`CreateFormResponse` (Task 1, `@support/types`), `IntentsResponse` (already imported here for `fetchIntents`).
- Produces: `fetchForms`, `fetchForm`, `createForm`, `updateForm`, `publishForm`, `archiveForm`, `setFormSubintents` — consumed by Task 9 and Task 10.

- [ ] **Step 1: Add the functions**

Add to `frontend/src/surfaces/agent-console/api/agentApi.ts`, alongside the existing article functions, importing `FormsListResponse`, `FormDetail`, `CreateFormResponse`, `FormField` from `@support/types` at the top:

```ts
export function fetchForms(token: string): Promise<FormsListResponse> {
  return apiCall('/agent/forms', token);
}

export function fetchForm(token: string, id: string): Promise<FormDetail> {
  return apiCall(`/agent/forms/${id}`, token);
}

export function createForm(token: string, name: string): Promise<CreateFormResponse> {
  return apiCall('/agent/forms', token, { method: 'POST', body: JSON.stringify({ name }) });
}

export function updateForm(
  token: string,
  id: string,
  patch: { name?: string; fields?: FormField[] },
): Promise<FormDetail> {
  return apiCall(`/agent/forms/${id}`, token, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function publishForm(token: string, id: string): Promise<FormDetail> {
  return apiCall(`/agent/forms/${id}/publish`, token, { method: 'POST' });
}

export function archiveForm(token: string, id: string): Promise<FormDetail> {
  return apiCall(`/agent/forms/${id}/archive`, token, { method: 'POST' });
}

export function setFormSubintents(
  token: string,
  id: string,
  subintentIds: string[],
): Promise<FormDetail> {
  return apiCall(`/agent/forms/${id}/subintents`, token, {
    method: 'PATCH',
    body: JSON.stringify({ subintentIds }),
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter frontend typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts
git commit -m "feat(frontend): add forms admin API client functions"
```

---

### Task 8: Frontend client-side validation — `formForm.ts`

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/Forms/formForm.ts`
- Test: `frontend/src/surfaces/agent-console/pages/Forms/formForm.test.ts`

**Interfaces:**

- Consumes: `FormField`, `FormFieldType` (`@support/types`).
- Produces: `canPublish(draft, fields)`, `validateFields(fields)`, `nextPosition(fields)`, `slugifyKey(label, existingKeys)` — consumed by Task 10.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/surfaces/agent-console/pages/Forms/formForm.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { FormField } from '@support/types';
import { canPublish, nextPosition, slugifyKey, validateFields } from './formForm.ts';

function field(overrides: Partial<FormField> = {}): FormField {
  return {
    key: 'q1',
    label: 'Q1',
    type: 'short_text',
    isRequired: false,
    position: 0,
    ...overrides,
  };
}

describe('validateFields', () => {
  it('rejects a duplicate key', () => {
    const errors = validateFields([field({ position: 0 }), field({ position: 1 })]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a choice field with fewer than 2 options', () => {
    const errors = validateFields([field({ type: 'choice', options: ['only one'] })]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-choice field carrying options', () => {
    const errors = validateFields([field({ type: 'short_text', options: ['a', 'b'] })]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a valid field list', () => {
    const errors = validateFields([
      field({ key: 'a', position: 0 }),
      field({ key: 'b', position: 1, type: 'choice', options: ['x', 'y'] }),
    ]);
    expect(errors).toEqual([]);
  });
});

describe('canPublish', () => {
  it('is false with zero fields', () => {
    expect(canPublish([])).toBe(false);
  });

  it('is false when validation fails', () => {
    expect(canPublish([field(), field()])).toBe(false);
  });

  it('is true with at least one valid field', () => {
    expect(canPublish([field()])).toBe(true);
  });
});

describe('nextPosition', () => {
  it('returns 0 for an empty list', () => {
    expect(nextPosition([])).toBe(0);
  });

  it('returns one past the highest existing position', () => {
    expect(nextPosition([field({ position: 0 }), field({ position: 3 })])).toBe(4);
  });
});

describe('slugifyKey', () => {
  it('lowercases, replaces non-alphanumerics with underscores, and dedupes against existing keys', () => {
    expect(slugifyKey('Order Number!', [])).toBe('order_number');
    expect(slugifyKey('Order Number', ['order_number'])).toBe('order_number_2');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter frontend test formForm.test.ts`
Expected: FAIL — `formForm.ts` does not exist.

- [ ] **Step 3: Implement `formForm.ts`**

Create `frontend/src/surfaces/agent-console/pages/Forms/formForm.ts`:

```ts
import type { FormField } from '@support/types';

export function validateFields(fields: FormField[]): string[] {
  const errors: string[] = [];
  const seenKeys = new Set<string>();
  const seenPositions = new Set<number>();

  for (const field of fields) {
    if (seenKeys.has(field.key)) errors.push(`Duplicate field key "${field.key}".`);
    seenKeys.add(field.key);

    if (seenPositions.has(field.position))
      errors.push(`Duplicate field position ${field.position}.`);
    seenPositions.add(field.position);

    if (field.type === 'choice' && (!field.options || field.options.length < 2)) {
      errors.push(`"${field.label}" needs at least 2 options.`);
    }
    if (field.type !== 'choice' && field.options !== undefined) {
      errors.push(`"${field.label}" is a ${field.type} field and must not carry options.`);
    }
  }

  return errors;
}

export function canPublish(fields: FormField[]): boolean {
  return fields.length > 0 && validateFields(fields).length === 0;
}

export function nextPosition(fields: FormField[]): number {
  if (fields.length === 0) return 0;
  return Math.max(...fields.map((f) => f.position)) + 1;
}

export function slugifyKey(label: string, existingKeys: string[]): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  let candidate = base;
  let n = 2;
  while (existingKeys.includes(candidate)) {
    candidate = `${base}_${n}`;
    n += 1;
  }
  return candidate;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter frontend test formForm.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Forms/formForm.ts frontend/src/surfaces/agent-console/pages/Forms/formForm.test.ts
git commit -m "feat(frontend): add forms client-side field validation helpers"
```

---

### Task 9: Frontend — `FormTable.tsx`

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/Forms/components/FormTable.tsx`

**Interfaces:**

- Consumes: `fetchForms` (Task 7), `FormSummary` (`@support/types`), `Badge`/`Button`/`Table*` (`frontend/src/surfaces/agent-console/components/ui/*`), `cn` (`frontend/src/surfaces/agent-console/lib/cn.ts`).
- Produces: `FormTable` component with props `{ token: string; selectedId: string | null; onSelect: (id: string) => void; onNew: () => void }` — consumed by Task 11.

- [ ] **Step 1: Implement `FormTable.tsx`**

Mirrors `ArticleTable.tsx` exactly, with a status string computed from the three summary fields instead of a single enum:

```tsx
import { useQuery } from '@tanstack/react-query';
import type { FormSummary } from '@support/types';
import { fetchForms } from '../../../api/agentApi.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table.tsx';
import { cn } from '../../../lib/cn.ts';

function statusOf(f: FormSummary): {
  label: string;
  variant: 'secondary' | 'success' | 'outline' | 'warning';
} {
  if (f.archivedAt) return { label: 'Archived', variant: 'outline' };
  if (f.publishedVersion === null) return { label: 'Draft', variant: 'secondary' };
  if (f.hasDraft)
    return { label: `Published v${f.publishedVersion} · draft pending`, variant: 'warning' };
  return { label: `Published v${f.publishedVersion}`, variant: 'success' };
}

export function FormTable({
  token,
  selectedId,
  onSelect,
  onNew,
}: {
  token: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const forms = useQuery({ queryKey: ['admin-forms'], queryFn: () => fetchForms(token) });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Forms</span>
        <Button type="button" size="sm" onClick={onNew}>
          + New
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Shown for</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {forms.data?.forms.map((f) => {
              const status = statusOf(f);
              return (
                <TableRow
                  key={f.id}
                  onClick={() => onSelect(f.id)}
                  className={cn('cursor-pointer', selectedId === f.id && 'bg-accent-soft')}
                >
                  <TableCell className="font-medium">{f.name}</TableCell>
                  <TableCell className="text-muted">
                    {f.mappedSubintentCount === 0
                      ? '—'
                      : `${f.mappedSubintentCount} subintent${f.mappedSubintentCount === 1 ? '' : 's'}`}
                  </TableCell>
                  <TableCell>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Confirm `Badge`'s variant union includes `warning`**

Read `frontend/src/surfaces/agent-console/components/ui/badge.tsx`. It already lists `warning` among its variants (confirmed during research) — no change needed there.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter frontend typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Forms/components/FormTable.tsx
git commit -m "feat(frontend): add FormTable listing forms with mapping/status summary"
```

---

### Task 10: Frontend — `FormEditorSheet.tsx`

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.test.tsx`

**Interfaces:**

- Consumes: `fetchForm`/`createForm`/`updateForm`/`publishForm`/`archiveForm`/`setFormSubintents` (Task 7), `fetchIntents` (existing `agentApi.ts`, now typed with `formId`/`archivedAt` per Task 3), `validateFields`/`canPublish`/`nextPosition`/`slugifyKey` (Task 8), `Sheet*`/`Input`/`Button`/`Select*` (`components/ui/*`).
- Produces: `FormEditorSheet` component with props `{ token: string; formId: string | null; open: boolean; onOpenChange: (open: boolean) => void; onCreated: (id: string) => void }` — consumed by Task 11.

- [ ] **Step 1: Write the failing skeleton/loading test**

Create `frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as agentApi from '../../../api/agentApi.ts';
import { FormEditorSheet } from './FormEditorSheet.tsx';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('FormEditorSheet', () => {
  it('shows a skeleton while fetching, then the form once loaded', async () => {
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });
    vi.spyOn(agentApi, 'fetchForm').mockResolvedValue({
      id: 'f1',
      name: 'Bug Report',
      archivedAt: null,
      createdAt: new Date().toISOString(),
      draft: { version: 1, fields: [], publishedAt: null },
      published: null,
      subintents: [],
    });

    renderWithClient(
      <FormEditorSheet token="t" formId="f1" open onOpenChange={() => {}} onCreated={() => {}} />,
    );

    expect(screen.getByTestId('form-editor-skeleton')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByDisplayValue('Bug Report')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter frontend test FormEditorSheet.test.tsx`
Expected: FAIL — `FormEditorSheet.tsx` does not exist.

- [ ] **Step 3: Implement `FormEditorSheet.tsx`**

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormDetail, FormField, FormFieldType } from '@support/types';
import {
  archiveForm,
  createForm,
  fetchForm,
  fetchIntents,
  publishForm,
  setFormSubintents,
  updateForm,
} from '../../../api/agentApi.ts';
import { canPublish, nextPosition, slugifyKey, validateFields } from '../formForm.ts';
import { Button } from '../../../components/ui/button.tsx';
import { Input } from '../../../components/ui/input.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.tsx';
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../../../components/ui/sheet.tsx';
import { Skeleton } from '../../../components/ui/skeleton.tsx';

const FIELD_TYPE_OPTIONS: { value: FormFieldType; label: string }[] = [
  { value: 'short_text', label: 'Short text' },
  { value: 'long_text', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'choice', label: 'Choice' },
];

export function FormEditorSheet({
  token,
  formId,
  open,
  onOpenChange,
  onCreated,
}: {
  token: string;
  formId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const intents = useQuery({ queryKey: ['admin-intents'], queryFn: () => fetchIntents(token) });
  const selected = useQuery({
    queryKey: ['admin-form', formId],
    queryFn: () => fetchForm(token, formId!),
    enabled: formId !== null,
  });

  const loading = (formId !== null && selected.isLoading) || intents.isLoading;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{formId ? 'Edit Form' : 'New Form'}</SheetTitle>
        </SheetHeader>

        {loading ? (
          <div
            className="flex min-h-0 flex-1 flex-col gap-4 p-4"
            data-testid="form-editor-skeleton"
          >
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="min-h-64 flex-1" />
          </div>
        ) : selected.isError ? (
          <div className="flex min-h-0 flex-1 flex-col items-start gap-3 p-4">
            <p className="text-sm text-muted">This form could not be loaded.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void selected.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <FormEditorForm
            key={formId ?? 'new'}
            token={token}
            formId={formId}
            form={selected.data ?? null}
            allSubintents={(intents.data?.intents ?? []).flatMap((i) =>
              i.subintents.map((s) => ({ ...s, intentName: i.name })),
            )}
            onCreated={onCreated}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

type Draft = { name: string; fields: FormField[]; subintentIds: string[] };

function draftFrom(form: FormDetail | null): Draft {
  if (!form) return { name: '', fields: [], subintentIds: [] };
  return {
    name: form.name,
    fields: form.draft?.fields ?? form.published?.fields ?? [],
    subintentIds: form.subintents.map((s) => s.id),
  };
}

function FormEditorForm({
  token,
  formId,
  form,
  allSubintents,
  onCreated,
}: {
  token: string;
  formId: string | null;
  form: FormDetail | null;
  allSubintents: {
    id: string;
    name: string;
    intentId: string;
    formId: string | null;
    archivedAt: string | null;
    intentName: string;
  }[];
  onCreated: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(form));
  const fieldErrors = validateFields(draft.fields);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-forms'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-form', formId] });
  };

  const createDraft = useMutation({
    mutationFn: () => createForm(token, draft.name),
    onSuccess: async (created) => {
      await updateForm(token, created.id, { fields: draft.fields });
      if (draft.subintentIds.length > 0)
        await setFormSubintents(token, created.id, draft.subintentIds);
      invalidate();
      onCreated(created.id);
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const updated = await updateForm(token, formId!, { name: draft.name, fields: draft.fields });
      await setFormSubintents(token, formId!, draft.subintentIds);
      return updated;
    },
    onSuccess: invalidate,
  });

  const publish = useMutation({
    mutationFn: () => publishForm(token, formId!),
    onSuccess: invalidate,
  });
  const archive = useMutation({
    mutationFn: () => archiveForm(token, formId!),
    onSuccess: invalidate,
  });

  const nonArchived = allSubintents.filter((s) => s.archivedAt === null);

  function addField(type: FormFieldType) {
    const label = `Question ${draft.fields.length + 1}`;
    const key = slugifyKey(
      label,
      draft.fields.map((f) => f.key),
    );
    const newField: FormField = {
      key,
      label,
      type,
      isRequired: false,
      position: nextPosition(draft.fields),
      ...(type === 'choice' ? { options: ['Option 1', 'Option 2'] } : {}),
    };
    setDraft({ ...draft, fields: [...draft.fields, newField] });
  }

  function updateField(index: number, patch: Partial<FormField>) {
    setDraft({
      ...draft,
      fields: draft.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    });
  }

  function removeField(index: number) {
    setDraft({
      ...draft,
      fields: draft.fields.filter((_, i) => i !== index).map((f, i) => ({ ...f, position: i })),
    });
  }

  function moveField(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= draft.fields.length) return;
    const next = [...draft.fields];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setDraft({ ...draft, fields: next.map((f, i) => ({ ...f, position: i })) });
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted">Name</label>
          <Input
            placeholder="Form name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-muted">Fields</label>
          {draft.fields.map((field, index) => (
            <FieldRow
              key={field.key}
              field={field}
              onChange={(patch) => updateField(index, patch)}
              onRemove={() => removeField(index)}
              onMoveUp={index > 0 ? () => moveField(index, -1) : undefined}
              onMoveDown={index < draft.fields.length - 1 ? () => moveField(index, 1) : undefined}
            />
          ))}
          <div className="flex items-center gap-2 rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-muted">
            <span>Skip and talk to an agent</span>
            <span className="ml-auto text-xs">(always present, cannot be removed)</span>
          </div>
          <Select onValueChange={(value) => addField(value as FormFieldType)}>
            <SelectTrigger>
              <SelectValue placeholder="+ Add a field" />
            </SelectTrigger>
            <SelectContent>
              {FIELD_TYPE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {fieldErrors.map((err) => (
            <p key={err} className="text-xs text-red-600">
              {err}
            </p>
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted">Shown for</label>
          <div className="max-h-40 overflow-y-auto rounded-md border border-slate-200 p-2">
            {nonArchived.map((s) => (
              <label key={s.id} className="flex items-center gap-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={draft.subintentIds.includes(s.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      subintentIds: e.target.checked
                        ? [...draft.subintentIds, s.id]
                        : draft.subintentIds.filter((id) => id !== s.id),
                    })
                  }
                />
                {s.intentName} · {s.name}
              </label>
            ))}
          </div>
        </div>
      </div>

      <SheetFooter className="flex-row justify-end gap-2 border-t border-slate-200">
        {formId === null ? (
          <Button
            type="button"
            onClick={() => createDraft.mutate()}
            disabled={createDraft.isPending || !draft.name}
          >
            Create Draft
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => archive.mutate()}
              disabled={archive.isPending}
            >
              Archive
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => save.mutate()}
              disabled={save.isPending || !draft.name}
            >
              Save
            </Button>
            <Button
              type="button"
              onClick={() => publish.mutate()}
              disabled={!canPublish(draft.fields) || publish.isPending}
            >
              Publish
            </Button>
          </>
        )}
      </SheetFooter>
    </>
  );
}

function FieldRow({
  field,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  field: FormField;
  onChange: (patch: Partial<FormField>) => void;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-slate-200 p-2">
      <div className="flex items-center gap-2">
        <Input
          value={field.label}
          onChange={(e) => onChange({ label: e.target.value })}
          className="flex-1"
        />
        <span className="rounded bg-slate-100 px-2 py-1 text-xs text-muted">{field.type}</span>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={field.isRequired}
            onChange={(e) => onChange({ isRequired: e.target.checked })}
          />
          Required
        </label>
        <Button type="button" variant="outline" size="sm" onClick={onMoveUp} disabled={!onMoveUp}>
          ↑
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onMoveDown}
          disabled={!onMoveDown}
        >
          ↓
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onRemove}>
          ✕
        </Button>
      </div>
      <Input
        placeholder="Placeholder text"
        value={field.placeholder ?? ''}
        onChange={(e) => onChange({ placeholder: e.target.value || undefined })}
      />
      <Input
        placeholder="Helper text"
        value={field.helperText ?? ''}
        onChange={(e) => onChange({ helperText: e.target.value || undefined })}
      />
      {field.type === 'choice' && (
        <div className="flex flex-col gap-1">
          {(field.options ?? []).map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={opt}
                onChange={(e) => {
                  const options = [...(field.options ?? [])];
                  options[i] = e.target.value;
                  onChange({ options });
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  onChange({ options: (field.options ?? []).filter((_, idx) => idx !== i) })
                }
              >
                ✕
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange({
                options: [...(field.options ?? []), `Option ${(field.options?.length ?? 0) + 1}`],
              })
            }
          >
            + Add option
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter frontend test FormEditorSheet.test.tsx`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter frontend typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.tsx frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.test.tsx
git commit -m "feat(frontend): add FormEditorSheet with field editor and subintent mapping"
```

---

### Task 11: Frontend — `Forms.tsx` page, route registration

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/Forms/Forms.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Forms/Forms.test.tsx`
- Modify: `frontend/src/routes/AppRoutes.tsx`

**Interfaces:**

- Consumes: `FormTable` (Task 9), `FormEditorSheet` (Task 10), `loadAgentSession` (`frontend/src/surfaces/agent-console/lib/agentSession.ts`).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/surfaces/agent-console/pages/Forms/Forms.test.tsx`, mirroring `KnowledgeBase.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { loadAgentSession } from '../../lib/agentSession.ts';
import { Forms } from './Forms.tsx';

vi.mock('../../lib/agentSession.ts');

beforeEach(() => {
  vi.mocked(loadAgentSession).mockReturnValue({ token: 't' } as never);
});

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/forms" element={<Forms />} />
          <Route path="/forms/:id" element={<Forms />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Forms', () => {
  it('renders the forms list', () => {
    renderAt('/forms');
    expect(screen.getByText('Forms')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter frontend test Forms.test.tsx`
Expected: FAIL — `Forms.tsx` does not exist.

- [ ] **Step 3: Implement `Forms.tsx`**

Mirrors `KnowledgeBase.tsx` exactly, minus the `CategorySidebar` (forms have no category sidebar in the spec):

```tsx
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { loadAgentSession } from '../../lib/agentSession.ts';
import { FormTable } from './components/FormTable.tsx';
import { FormEditorSheet } from './components/FormEditorSheet.tsx';

export function Forms() {
  const session = loadAgentSession();
  const { id: routeFormId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(routeFormId ?? null);
  const [sheetOpen, setSheetOpen] = useState(routeFormId !== undefined);

  if (!session) return null;

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1">
        <FormTable
          token={session.token}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setSheetOpen(true);
          }}
          onNew={() => {
            setSelectedId(null);
            setSheetOpen(true);
          }}
        />
      </div>
      <FormEditorSheet
        token={session.token}
        formId={selectedId}
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open);
          if (!open) {
            setSelectedId(null);
            if (routeFormId) navigate('/forms', { replace: true });
          }
        }}
        onCreated={(id) => setSelectedId(id)}
      />
    </div>
  );
}
```

- [ ] **Step 4: Register the route**

In `frontend/src/routes/AppRoutes.tsx`, add the lazy import alongside `KnowledgeBase`'s:

```tsx
const Forms = lazy(async () => ({
  default: (await import('../surfaces/agent-console/pages/Forms/Forms.tsx')).Forms,
}));
```

and the routes alongside `articles`/`articles/:id`:

```tsx
<Route path="forms" element={<Forms />} />
<Route path="forms/:id" element={<Forms />} />
```

- [ ] **Step 5: Add a nav entry visible to Team Lead and Admin only**

Locate the existing nav list in `AppRoutes.tsx` or its layout component (wherever the `Articles`/`Knowledge Base` nav link is defined — check for a role-gated nav array pattern already used for `Bot Settings` or similar admin-only links). Add a `Forms` entry gated the same way; Agents get no link (the API 403s them regardless). If no such role-gated nav pattern exists yet in this codebase, add the link unconditionally and open a follow-up note rather than inventing new gating scaffolding — the spec explicitly says hiding the link is UX, not the enforcement point.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter frontend test Forms.test.tsx`
Expected: PASS

- [ ] **Step 7: Full frontend verification**

Run: `pnpm --filter frontend typecheck && pnpm --filter frontend test`
Expected: no type errors, full suite green.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Forms/Forms.tsx frontend/src/surfaces/agent-console/pages/Forms/Forms.test.tsx frontend/src/routes/AppRoutes.tsx
git commit -m "feat(frontend): add /forms route composing FormTable and FormEditorSheet"
```

---

## Final verification (after all tasks land)

- [ ] Run `pnpm typecheck` from repo root — no errors across backend, frontend, `@support/types`.
- [ ] Run `pnpm test` from repo root (Postgres must be up) — full suite green.
- [ ] Manual verification per the spec: create a form, publish it, map it to a subintent, trigger the bot handoff for that subintent in the webview, confirm the published fields (not a later unpublished edit) are what the player sees — then edit the published form's fields and confirm the change does _not_ retroactively alter the in-flight submission's rendering in the agent context rail. This exercises `resolveSubintentForm` (`backend/src/domain/forms/resolveSubintentForm.ts`), which this plan does not touch and must not need to.
