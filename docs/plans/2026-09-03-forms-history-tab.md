# Forms History Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "History" tab to the Forms admin editor showing every published version of a form, a diff against the prior version, and a restore action that copies an old version's fields into the current draft.

**Architecture:** No schema changes — `form_version` (`backend/src/shared/db/schema/forms.ts:40-65`) already stores one immutable snapshot per publish. Two new read endpoints (`GET /forms/:id/versions`, `GET /forms/:id/versions/:version`) expose only *published* rows (`publishedAt IS NOT NULL`) — a draft is the mutable working copy, not history yet, and has no `publishedBy` actor to show. A new `POST /forms/:id/versions/:version/restore` endpoint reuses the existing `updateForm` auto-fork logic (`formsService.ts:156-199`) to copy an old version's fields into the current draft, never publishing directly. The frontend adds a `Tabs` strip (Fields / History) inside `FormEditorSheet`, mirroring `pages/BotConfig`'s existing Prompt/Rules/Tools/History pattern — a new `FormVersionHistoryTab` component fetches the list, diffs adjacent snapshots client-side with a new `diffFormFields` util (mirroring `diffRules`), and gates restore behind the shared `ConfirmDialog`.

**Tech Stack:** Express 5 + Zod + Drizzle ORM (backend), React + TanStack Query + Radix `Tabs` (frontend), Vitest + Testing Library.

## Global Constraints

- Auth: `GET /forms/:id/versions` and `GET /forms/:id/versions/:version` use `requireTeamLeadOrAdmin` (same as other form reads). `POST /forms/:id/versions/:version/restore` uses `requireTeamLeadOrAdmin` too — restore only edits the draft, exactly like `PATCH /forms/:id`, which is Team Lead + Admin, not Admin-only (publish/archive are the Admin-only actions).
- No hard deletes, no mutation of `form_version` rows once written — restore always creates/updates the *draft* row, never touches a published row's `fields`.
- Register every new route in `backend/src/docs/openapi.ts` (repo convention, see CLAUDE.md "General").
- Tailwind v4 utilities only in any new frontend markup — no hand-written CSS classes.
- Every mutating frontend action that changes persisted state beyond a form field edit must go through `ConfirmDialog` — restore must never fire directly from a row button.

---

### Task 1: Backend — list and get form version endpoints

**Files:**
- Modify: `packages/types/src/forms.ts` (add version view types near `FormVersionView`, line 162)
- Modify: `backend/src/agent/services/formsService.ts` (add `listFormVersions`, `getFormVersion`)
- Modify: `backend/src/agent/controllers/formsController.ts` (add two handlers)
- Modify: `backend/src/agent/routers/formsRouter.ts` (add two routes)
- Modify: `backend/src/docs/openapi.ts` (register both routes)
- Test: `backend/tests/formsAdmin.test.ts` (add cases)

**Interfaces:**
- Produces: `FormVersionActorView = { id: string; display_name: string; email: string }`, `FormVersionSummaryView = { version: number; published_at: string; actor: FormVersionActorView }`, `FormVersionSnapshotView = FormVersionSummaryView & { fields: FormField[] }`, `FormVersionsListResponse = { versions: FormVersionSummaryView[] }` (all in `@support/types`)
- Produces: `listFormVersions(ctx: AgentContext, formId: string): Promise<FormVersionsListResponse | null>` — `null` means form not found
- Produces: `getFormVersion(ctx: AgentContext, formId: string, version: number): Promise<FormVersionSnapshotView | null>` — `null` means form or version not found
- Consumes: `AgentContext` (`shared/middleware/requireAgentSession.ts`), `withWorkspace` (`shared/db/withWorkspace.ts`), `form`/`formVersion`/`agent` tables (`shared/db/schema/index.ts`)

- [ ] **Step 1: Add the version view types**

In `packages/types/src/forms.ts`, right after `FormVersionView` (line 162):

```ts
export type FormVersionActorView = { id: string; display_name: string; email: string };

/** Only PUBLISHED versions are ever listed here — the current draft is the
 * mutable working copy, not history, and has no publishedBy actor to show. */
export type FormVersionSummaryView = {
  version: number;
  published_at: string;
  actor: FormVersionActorView;
};

export type FormVersionsListResponse = { versions: FormVersionSummaryView[] };

export type FormVersionSnapshotView = FormVersionSummaryView & { fields: FormField[] };
```

- [ ] **Step 2: Write the failing backend service test**

In `backend/tests/formsAdmin.test.ts`, add a new `describe` block after the closing `});` of `describe('forms permissions', ...)` (end of file, after line 346):

```ts
describe('form version history', () => {
  it('lists only published versions, newest first, and omits the draft', async () => {
    const workspaceId = await seedWorkspace();
    const { ctx } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await createForm(ctx, 'Refund');
    await updateForm(ctx, created.id, { fields: FIELDS });
    await publishForm(ctx, created.id);
    await updateForm(ctx, created.id, { fields: [] });

    const result = await listFormVersions(ctx, created.id);
    expect(result).not.toBeNull();
    expect(result!.versions.map((v) => v.version)).toEqual([1]);
    expect(result!.versions[0]!.actor.email).toBeTruthy();
  });

  it('returns null for an unknown form id', async () => {
    const workspaceId = await seedWorkspace();
    const { ctx } = await seedAgentWithRole(workspaceId, 'admin');
    const result = await listFormVersions(ctx, '00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('gets a single published version snapshot with its fields', async () => {
    const workspaceId = await seedWorkspace();
    const { ctx } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await createForm(ctx, 'Refund');
    await updateForm(ctx, created.id, { fields: FIELDS });
    await publishForm(ctx, created.id);

    const result = await getFormVersion(ctx, created.id, 1);
    expect(result).not.toBeNull();
    expect(result!.fields).toEqual(FIELDS);
  });

  it('returns null for a draft version number (never published)', async () => {
    const workspaceId = await seedWorkspace();
    const { ctx } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await createForm(ctx, 'Refund');
    await updateForm(ctx, created.id, { fields: FIELDS });

    const result = await getFormVersion(ctx, created.id, 1);
    expect(result).toBeNull();
  });
});

describe('form version history HTTP', () => {
  it('a Team Lead can list and get versions, an Agent gets 403', async () => {
    const workspaceId = await seedWorkspace();
    const { ctx, token: adminToken } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await createForm(ctx, 'Refund');
    await updateForm(ctx, created.id, { fields: FIELDS });
    await publishForm(ctx, created.id);
    const { token: agentToken } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .get(`/forms/${created.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    await request(app)
      .get(`/forms/${created.id}/versions/1`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    await request(app)
      .get(`/forms/${created.id}/versions`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(403);
  });

  it('404s on an unknown version number', async () => {
    const workspaceId = await seedWorkspace();
    const { ctx, token } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await createForm(ctx, 'Refund');
    await updateForm(ctx, created.id, { fields: FIELDS });
    await publishForm(ctx, created.id);

    await request(app)
      .get(`/forms/${created.id}/versions/99`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(404);
  });
});
```

Also update the two import blocks at the top of the file:

```ts
import { formsRouter } from '../src/agent/routers/formsRouter.ts';
import {
  archiveForm,
  createForm,
  getForm,
  getFormVersion,
  listFormVersions,
  publishForm,
  setFormSubintents,
  updateForm,
} from '../src/agent/services/formsService.ts';
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && pnpm vitest run tests/formsAdmin.test.ts`
Expected: FAIL — `listFormVersions`/`getFormVersion` are not exported, and the two routes 404.

- [ ] **Step 4: Implement `listFormVersions` and `getFormVersion` in `formsService.ts`**

Add `agent` to the existing schema import at the top of `backend/src/agent/services/formsService.ts` (line 10):

```ts
import { agent, form, formVersion, subintent } from '../../shared/db/schema/index.ts';
```

Add `isNotNull` to the drizzle-orm import (line 1):

```ts
import { and, desc, eq, inArray, isNotNull, isNull, notInArray } from 'drizzle-orm';
```

Add the `FormVersionsListResponse`/`FormVersionSnapshotView` types to the existing `@support/types` import block (top of file).

Append these two functions after `getForm` (after line 143):

```ts
/**
 * Only PUBLISHED versions — the current draft has no publishedBy actor and is
 * the mutable working copy, not a historical fact yet.
 */
export async function listFormVersions(
  ctx: AgentContext,
  formId: string,
): Promise<FormVersionsListResponse | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [formRow] = await tx.select({ id: form.id }).from(form).where(eq(form.id, formId)).limit(1);
    if (!formRow) return null;

    const rows = await tx
      .select({
        version: formVersion.version,
        publishedAt: formVersion.publishedAt,
        actorId: agent.id,
        actorDisplayName: agent.displayName,
        actorEmail: agent.email,
      })
      .from(formVersion)
      .innerJoin(agent, eq(agent.id, formVersion.publishedBy))
      .where(and(eq(formVersion.formId, formId), isNotNull(formVersion.publishedAt)))
      .orderBy(desc(formVersion.version));

    return {
      versions: rows.map((r) => ({
        version: r.version,
        published_at: r.publishedAt!.toISOString(),
        actor: { id: r.actorId, display_name: r.actorDisplayName, email: r.actorEmail },
      })),
    };
  });
}

export async function getFormVersion(
  ctx: AgentContext,
  formId: string,
  version: number,
): Promise<FormVersionSnapshotView | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .select({
        version: formVersion.version,
        fields: formVersion.fields,
        publishedAt: formVersion.publishedAt,
        actorId: agent.id,
        actorDisplayName: agent.displayName,
        actorEmail: agent.email,
      })
      .from(formVersion)
      .innerJoin(agent, eq(agent.id, formVersion.publishedBy))
      .where(
        and(
          eq(formVersion.formId, formId),
          eq(formVersion.version, version),
          isNotNull(formVersion.publishedAt),
        ),
      )
      .limit(1);
    if (!row) return null;

    return {
      version: row.version,
      published_at: row.publishedAt!.toISOString(),
      actor: { id: row.actorId, display_name: row.actorDisplayName, email: row.actorEmail },
      fields: row.fields,
    };
  });
}
```

- [ ] **Step 5: Add controller handlers**

In `backend/src/agent/controllers/formsController.ts`, add to the service import (line 5-13):

```ts
import {
  archiveForm,
  createForm,
  getForm,
  getFormVersion,
  listFormVersions,
  publishForm,
  setFormSubintents,
  updateForm,
} from '../services/formsService.ts';
```

Add a params schema next to `FormIdParams` (line 15):

```ts
const FormVersionParams = z.object({ id: z.uuid(), version: z.coerce.number().int().positive() });
```

Append handlers after `getFormHandler` (after line 33):

```ts
export const listFormVersionsHandler: RequestHandler = async (req, res) => {
  const params = FormIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const result = await listFormVersions(req.agent!, params.data.id);
  if (!result) {
    sendError(res, 404, 'not_found', 'Form not found.');
    return;
  }
  res.status(200).json(result);
};

export const getFormVersionHandler: RequestHandler = async (req, res) => {
  const params = FormVersionParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid and version a positive integer.');
    return;
  }
  const result = await getFormVersion(req.agent!, params.data.id, params.data.version);
  if (!result) {
    sendError(res, 404, 'not_found', 'Form version not found.');
    return;
  }
  res.status(200).json(result);
};
```

- [ ] **Step 6: Register the routes**

In `backend/src/agent/routers/formsRouter.ts`, add to the controller import and add two routes after the `subintents` route (after line 23):

```ts
import {
  archiveFormHandler,
  createFormHandler,
  getFormHandler,
  getFormVersionHandler,
  listFormsHandler,
  listFormVersionsHandler,
  publishFormHandler,
  setFormSubintentsHandler,
  updateFormHandler,
} from '../controllers/formsController.ts';

// ... existing routes ...
formsRouter.get('/forms/:id/versions', canBuildForms, listFormVersionsHandler);
formsRouter.get('/forms/:id/versions/:version', canBuildForms, getFormVersionHandler);
```

- [ ] **Step 7: Register both routes in openapi.ts**

In `backend/src/docs/openapi.ts`, add a `FormVersionSummarySchema`/`FormVersionSnapshotSchema` pair right after `FormFieldSchema` (after line 2017), and two `registerPath` calls right after the existing `/agent/forms/{id}/subintents` block (after line 2136, before the bot-config section starts at line 2138):

```ts
const FormVersionSummarySchema = z.object({
  version: z.number().int(),
  published_at: z.string(),
  actor: z.object({ id: z.uuid(), display_name: z.string(), email: z.string() }),
});

const FormVersionSnapshotSchema = FormVersionSummarySchema.extend({
  fields: z.array(FormFieldSchema),
});

registry.registerPath({
  method: 'get',
  path: '/agent/forms/{id}/versions',
  summary: 'Agent List Form Versions',
  description:
    'Published version history for a form, newest first. The current unpublished draft is never listed — it has no publishing actor and is not history yet. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'Version list',
      content: {
        'application/json': { schema: z.object({ versions: z.array(FormVersionSummarySchema) }) },
      },
    },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/agent/forms/{id}/versions/{version}',
  summary: 'Agent Get Form Version',
  description: 'The full field snapshot for one published version of a form. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid(), version: z.coerce.number().int().positive() }) },
  responses: {
    200: {
      description: 'Version snapshot',
      content: { 'application/json': { schema: FormVersionSnapshotSchema } },
    },
    403: { description: 'Forbidden' },
    404: { description: 'Not found, or the version was never published' },
  },
});
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd backend && pnpm vitest run tests/formsAdmin.test.ts`
Expected: PASS

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add packages/types/src/forms.ts backend/src/agent/services/formsService.ts backend/src/agent/controllers/formsController.ts backend/src/agent/routers/formsRouter.ts backend/src/docs/openapi.ts backend/tests/formsAdmin.test.ts
git commit -m "feat: add form version list/get endpoints"
```

---

### Task 2: Backend — restore form version endpoint

**Files:**
- Modify: `backend/src/agent/services/formsService.ts` (add `restoreFormVersion`)
- Modify: `backend/src/agent/controllers/formsController.ts` (add handler)
- Modify: `backend/src/agent/routers/formsRouter.ts` (add route)
- Modify: `backend/src/docs/openapi.ts` (register route)
- Test: `backend/tests/formsAdmin.test.ts`

**Interfaces:**
- Consumes: `updateForm` (Task 1's file, already in `formsService.ts:156-199`) — `UpdateFormInput`/`UpdateFormResult`
- Produces: `RestoreFormVersionResult = { ok: true; form: FormDetail } | { ok: false; reason: 'not_found' } | { ok: false; reason: 'version_not_found' }`
- Produces: `restoreFormVersion(ctx: AgentContext, formId: string, version: number): Promise<RestoreFormVersionResult>`

- [ ] **Step 1: Write the failing test**

Append to the `describe('form version history', ...)` block added in Task 1 (`backend/tests/formsAdmin.test.ts`):

```ts
it('restore copies a published version into the draft without touching the published row', async () => {
  const workspaceId = await seedWorkspace();
  const { ctx } = await seedAgentWithRole(workspaceId, 'admin');
  const created = await createForm(ctx, 'Refund');
  await updateForm(ctx, created.id, { fields: FIELDS });
  await publishForm(ctx, created.id);
  await updateForm(ctx, created.id, { fields: [] });
  await publishForm(ctx, created.id);
  // Now: v1 published with FIELDS, v2 published with [].

  const result = await restoreFormVersion(ctx, created.id, 1);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  expect(result.form.draft).toBeNull();
  expect(result.form.published!.version).toBe(2);
  expect(result.form.published!.fields).toEqual([]);

  const versions = await listFormVersions(ctx, created.id);
  expect(versions!.versions.map((v) => v.version)).toEqual([2, 1]);

  const afterRestoreCreatesDraft = await updateForm(ctx, created.id, { fields: FIELDS });
  expect(afterRestoreCreatesDraft.ok).toBe(true);
});

it('restore forks a new draft with the old fields when the latest version is published', async () => {
  const workspaceId = await seedWorkspace();
  const { ctx } = await seedAgentWithRole(workspaceId, 'admin');
  const created = await createForm(ctx, 'Refund');
  await updateForm(ctx, created.id, { fields: FIELDS });
  await publishForm(ctx, created.id);

  const result = await restoreFormVersion(ctx, created.id, 1);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  expect(result.form.draft!.version).toBe(2);
  expect(result.form.draft!.fields).toEqual(FIELDS);
  expect(result.form.draft!.publishedAt).toBeNull();
  expect(result.form.published!.version).toBe(1);
});

it('restore edits an existing draft in place with the old fields', async () => {
  const workspaceId = await seedWorkspace();
  const { ctx } = await seedAgentWithRole(workspaceId, 'admin');
  const created = await createForm(ctx, 'Refund');
  await updateForm(ctx, created.id, { fields: FIELDS });
  await publishForm(ctx, created.id);
  await updateForm(ctx, created.id, { fields: [] });

  const result = await restoreFormVersion(ctx, created.id, 1);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  expect(result.form.draft!.version).toBe(2);
  expect(result.form.draft!.fields).toEqual(FIELDS);
});

it('returns version_not_found for an unpublished or unknown version', async () => {
  const workspaceId = await seedWorkspace();
  const { ctx } = await seedAgentWithRole(workspaceId, 'admin');
  const created = await createForm(ctx, 'Refund');

  const result = await restoreFormVersion(ctx, created.id, 1);
  expect(result).toEqual({ ok: false, reason: 'version_not_found' });
});

it('returns not_found for an unknown form id', async () => {
  const workspaceId = await seedWorkspace();
  const { ctx } = await seedAgentWithRole(workspaceId, 'admin');

  const result = await restoreFormVersion(ctx, '00000000-0000-0000-0000-000000000000', 1);
  expect(result).toEqual({ ok: false, reason: 'not_found' });
});
```

Add `restoreFormVersion` to the service import at the top of the file (alongside `listFormVersions`/`getFormVersion` from Task 1).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && pnpm vitest run tests/formsAdmin.test.ts`
Expected: FAIL — `restoreFormVersion` is not exported.

- [ ] **Step 3: Implement `restoreFormVersion` in `formsService.ts`**

Append after `getFormVersion` (added in Task 1):

```ts
export type RestoreFormVersionResult =
  | { ok: true; form: FormDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_not_found' };

/**
 * Restores a prior PUBLISHED version's fields into the current draft — using
 * updateForm's existing auto-fork rule, so this behaves exactly like an admin
 * pasting the old fields in by hand: edits the draft in place if one exists,
 * forks a new draft off the latest published version otherwise. Never
 * publishes and never mutates the version being restored from.
 */
export async function restoreFormVersion(
  ctx: AgentContext,
  formId: string,
  version: number,
): Promise<RestoreFormVersionResult> {
  const target = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [formRow] = await tx.select({ id: form.id }).from(form).where(eq(form.id, formId)).limit(1);
    if (!formRow) return { ok: false as const, reason: 'not_found' as const };

    const [row] = await tx
      .select({ fields: formVersion.fields })
      .from(formVersion)
      .where(
        and(
          eq(formVersion.formId, formId),
          eq(formVersion.version, version),
          isNotNull(formVersion.publishedAt),
        ),
      )
      .limit(1);
    if (!row) return { ok: false as const, reason: 'version_not_found' as const };

    return { ok: true as const, fields: row.fields };
  });
  if (!target.ok) return target;

  const result = await updateForm(ctx, formId, { fields: target.fields });
  if (!result.ok) {
    // Unreachable: form existence was just confirmed above, and target.fields
    // came from a version that already passed forbidden-field-type validation
    // when it was originally saved.
    throw new Error(`restoreFormVersion: unexpected updateForm failure (${result.reason})`);
  }
  return { ok: true, form: result.form };
}
```

- [ ] **Step 4: Add the controller handler**

In `backend/src/agent/controllers/formsController.ts`, add `restoreFormVersion` to the service import, and append after `getFormVersionHandler`:

```ts
export const restoreFormVersionHandler: RequestHandler = async (req, res) => {
  const params = FormVersionParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid and version a positive integer.');
    return;
  }
  const result = await restoreFormVersion(req.agent!, params.data.id, params.data.version);
  if (!result.ok) {
    sendError(
      res,
      404,
      'not_found',
      result.reason === 'not_found' ? 'Form not found.' : 'Form version not found.',
    );
    return;
  }
  res.status(200).json(result.form);
};
```

- [ ] **Step 5: Register the route**

In `backend/src/agent/routers/formsRouter.ts`, add `restoreFormVersionHandler` to the controller import and append:

```ts
formsRouter.post(
  '/forms/:id/versions/:version/restore',
  canBuildForms,
  restoreFormVersionHandler,
);
```

- [ ] **Step 6: Register in openapi.ts**

Append after the `/agent/forms/{id}/versions/{version}` block from Task 1:

```ts
registry.registerPath({
  method: 'post',
  path: '/agent/forms/{id}/versions/{version}/restore',
  summary: 'Agent Restore Form Version',
  description:
    "Copies a prior published version's fields into the current draft — edits the draft in place if one exists, forks a new draft off the latest published version otherwise. Never publishes, never mutates the version restored from. Team Lead or Admin, same as PATCH /forms/{id}.",
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid(), version: z.coerce.number().int().positive() }) },
  responses: {
    200: { description: 'Form with the restored draft' },
    403: { description: 'Forbidden' },
    404: { description: 'Form not found, or the version was never published' },
  },
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd backend && pnpm vitest run tests/formsAdmin.test.ts`
Expected: PASS

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add backend/src/agent/services/formsService.ts backend/src/agent/controllers/formsController.ts backend/src/agent/routers/formsRouter.ts backend/src/docs/openapi.ts backend/tests/formsAdmin.test.ts
git commit -m "feat: add form version restore endpoint"
```

---

### Task 3: Frontend — `diffFormFields` utility

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/Forms/lib/diffFormFields.ts`
- Test: `frontend/src/surfaces/agent-console/pages/Forms/lib/diffFormFields.test.ts`

**Interfaces:**
- Produces: `type FormFieldDiffEntry = { key: string; kind: 'added' | 'removed' | 'changed'; description: string }`
- Produces: `diffFormFields(before: FormField[], after: FormField[]): FormFieldDiffEntry[]`
- Consumes: `FormField` from `@support/types` (`key`, `label`, `type`, `isRequired`, `position`, `options`)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/surfaces/agent-console/pages/Forms/lib/diffFormFields.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { FormField } from '@support/types';
import { diffFormFields } from './diffFormFields.ts';

const field = (overrides: Partial<FormField> = {}): FormField => ({
  key: 'order_id',
  label: 'Order ID',
  type: 'short_text',
  isRequired: true,
  position: 0,
  ...overrides,
});

describe('diffFormFields', () => {
  it('reports an added field', () => {
    const entries = diffFormFields([], [field()]);
    expect(entries).toEqual([
      { key: 'order_id', kind: 'added', description: 'Field "Order ID" added' },
    ]);
  });

  it('reports a removed field', () => {
    const entries = diffFormFields([field()], []);
    expect(entries).toEqual([
      { key: 'order_id', kind: 'removed', description: 'Field "Order ID" removed' },
    ]);
  });

  it('reports a label change', () => {
    const entries = diffFormFields([field()], [field({ label: 'Order Number' })]);
    expect(entries).toEqual([
      {
        key: 'order_id',
        kind: 'changed',
        description: 'Field "Order Number": label changed from "Order ID"',
      },
    ]);
  });

  it('reports a required-flag change', () => {
    const entries = diffFormFields([field()], [field({ isRequired: false })]);
    expect(entries).toEqual([
      { key: 'order_id', kind: 'changed', description: 'Field "Order ID": required → optional' },
    ]);
  });

  it('reports a type change', () => {
    const entries = diffFormFields([field()], [field({ type: 'long_text' })]);
    expect(entries).toEqual([
      {
        key: 'order_id',
        kind: 'changed',
        description: 'Field "Order ID": type changed from short_text to long_text',
      },
    ]);
  });

  it('reports an options change on a choice field', () => {
    const choice = field({ type: 'choice', options: ['A', 'B'] });
    const entries = diffFormFields([choice], [{ ...choice, options: ['A', 'B', 'C'] }]);
    expect(entries).toEqual([
      { key: 'order_id', kind: 'changed', description: 'Field "Order ID": options changed' },
    ]);
  });

  it('returns nothing for two identical field lists', () => {
    expect(diffFormFields([field()], [field()])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Forms/lib/diffFormFields.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `diffFormFields.ts`**

Create `frontend/src/surfaces/agent-console/pages/Forms/lib/diffFormFields.ts`:

```ts
import type { FormField } from '@support/types';

export type FormFieldDiffEntry = { key: string; kind: 'added' | 'removed' | 'changed'; description: string };

export function diffFormFields(before: FormField[], after: FormField[]): FormFieldDiffEntry[] {
  const beforeByKey = new Map(before.map((f) => [f.key, f]));
  const afterByKey = new Map(after.map((f) => [f.key, f]));
  const entries: FormFieldDiffEntry[] = [];

  for (const [key, field] of afterByKey) {
    const prior = beforeByKey.get(key);
    if (!prior) {
      entries.push({ key, kind: 'added', description: `Field "${field.label}" added` });
      continue;
    }
    if (prior.label !== field.label) {
      entries.push({
        key,
        kind: 'changed',
        description: `Field "${field.label}": label changed from "${prior.label}"`,
      });
    } else if (prior.isRequired !== field.isRequired) {
      entries.push({
        key,
        kind: 'changed',
        description: `Field "${field.label}": ${prior.isRequired ? 'required → optional' : 'optional → required'}`,
      });
    } else if (prior.type !== field.type) {
      entries.push({
        key,
        kind: 'changed',
        description: `Field "${field.label}": type changed from ${prior.type} to ${field.type}`,
      });
    } else if (JSON.stringify(prior.options) !== JSON.stringify(field.options)) {
      entries.push({ key, kind: 'changed', description: `Field "${field.label}": options changed` });
    }
  }
  for (const [key, field] of beforeByKey) {
    if (!afterByKey.has(key)) {
      entries.push({ key, kind: 'removed', description: `Field "${field.label}" removed` });
    }
  }
  return entries;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Forms/lib/diffFormFields.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Forms/lib/diffFormFields.ts frontend/src/surfaces/agent-console/pages/Forms/lib/diffFormFields.test.ts
git commit -m "feat: add diffFormFields utility"
```

---

### Task 4: Frontend — `FormVersionHistoryTab` component

**Files:**
- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts` (add `fetchFormVersions`, `fetchFormVersion`, `restoreFormVersion`)
- Create: `frontend/src/surfaces/agent-console/pages/Forms/components/FormVersionHistoryTab.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Forms/components/FormVersionHistoryTab.test.tsx`

**Interfaces:**
- Consumes: `diffFormFields` (Task 3), `ConfirmDialog` (`components/ConfirmDialog.tsx`), `Button`/`ScrollArea` (`components/ui/*`)
- Produces: `fetchFormVersions(token: string, formId: string): Promise<FormVersionsListResponse>`
- Produces: `fetchFormVersion(token: string, formId: string, version: number): Promise<FormVersionSnapshotView>`
- Produces: `restoreFormVersion(token: string, formId: string, version: number): Promise<FormDetail>`
- Produces: `FormVersionHistoryTab({ token, formId, onRestored }: { token: string; formId: string; onRestored: () => void })` — React component. `onRestored` fires after a successful restore so the caller can switch back to the Fields tab.

- [ ] **Step 1: Add the three API functions**

In `frontend/src/surfaces/agent-console/api/agentApi.ts`, add to the `@support/types` import block: `FormVersionsListResponse`, `FormVersionSnapshotView`. Then add after `setFormSubintents` (after line 668):

```ts
export function fetchFormVersions(token: string, formId: string): Promise<FormVersionsListResponse> {
  return call(`/agent/forms/${formId}/versions`, token);
}

export function fetchFormVersion(
  token: string,
  formId: string,
  version: number,
): Promise<FormVersionSnapshotView> {
  return call(`/agent/forms/${formId}/versions/${version}`, token);
}

export function restoreFormVersion(
  token: string,
  formId: string,
  version: number,
): Promise<FormDetail> {
  return call(`/agent/forms/${formId}/versions/${version}/restore`, token, { method: 'POST' });
}
```

- [ ] **Step 2: Write the failing component test**

Create `frontend/src/surfaces/agent-console/pages/Forms/components/FormVersionHistoryTab.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { FormVersionHistoryTab } from './FormVersionHistoryTab.tsx';
import * as agentApi from '../../../api/agentApi.ts';

function renderTab(onRestored = vi.fn()) {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <FormVersionHistoryTab token="t" formId="form-1" onRestored={onRestored} />
    </QueryClientProvider>,
  );
  return { onRestored };
}

const actor = { id: 'a', display_name: 'Admin', email: 'a@x.test' };

describe('FormVersionHistoryTab', () => {
  it('lists published versions newest-first', async () => {
    vi.spyOn(agentApi, 'fetchFormVersions').mockResolvedValue({
      versions: [
        { version: 2, published_at: '2026-08-27T00:00:00.000Z', actor },
        { version: 1, published_at: '2026-08-26T00:00:00.000Z', actor },
      ],
    });

    renderTab();

    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());
    expect(screen.getByText('v1')).toBeInTheDocument();
  });

  it('shows an empty state with no versions', async () => {
    vi.spyOn(agentApi, 'fetchFormVersions').mockResolvedValue({ versions: [] });

    renderTab();

    await waitFor(() => expect(screen.getByText('No published versions yet.')).toBeInTheDocument());
  });

  it('expands a version to show a field diff against the prior version', async () => {
    vi.spyOn(agentApi, 'fetchFormVersions').mockResolvedValue({
      versions: [
        { version: 2, published_at: '2026-08-27T00:00:00.000Z', actor },
        { version: 1, published_at: '2026-08-26T00:00:00.000Z', actor },
      ],
    });
    vi.spyOn(agentApi, 'fetchFormVersion').mockImplementation(async (_token, _formId, version) => ({
      version,
      published_at: version === 2 ? '2026-08-27T00:00:00.000Z' : '2026-08-26T00:00:00.000Z',
      actor,
      fields:
        version === 2
          ? [
              {
                key: 'order_id',
                label: 'Order Number',
                type: 'short_text',
                isRequired: true,
                position: 0,
              },
            ]
          : [
              {
                key: 'order_id',
                label: 'Order ID',
                type: 'short_text',
                isRequired: true,
                position: 0,
              },
            ],
    }));

    renderTab();
    await waitFor(() => screen.getByText('v2'));
    fireEvent.click(screen.getByText('v2'));

    await waitFor(() =>
      expect(
        screen.getByText('Field "Order Number": label changed from "Order ID"'),
      ).toBeInTheDocument(),
    );
  });

  it('restores a version only after confirming, and calls onRestored', async () => {
    vi.spyOn(agentApi, 'fetchFormVersions').mockResolvedValue({
      versions: [{ version: 1, published_at: '2026-08-26T00:00:00.000Z', actor }],
    });
    const restoreSpy = vi.spyOn(agentApi, 'restoreFormVersion').mockResolvedValue({} as never);

    const { onRestored } = renderTab();
    await waitFor(() => screen.getByText('v1'));

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(restoreSpy).not.toHaveBeenCalled();

    await waitFor(() => screen.getByRole('button', { name: 'Restore version' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore version' }));

    await waitFor(() => expect(restoreSpy).toHaveBeenCalledWith('t', 'form-1', 1));
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Forms/components/FormVersionHistoryTab.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `FormVersionHistoryTab.tsx`**

Create `frontend/src/surfaces/agent-console/pages/Forms/components/FormVersionHistoryTab.tsx`:

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchFormVersion, fetchFormVersions, restoreFormVersion } from '../../../api/agentApi.ts';
import { Button } from '../../../components/ui/button.tsx';
import { ScrollArea } from '../../../components/ui/scroll-area.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import { diffFormFields } from '../lib/diffFormFields.ts';

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

function VersionDiff({
  token,
  formId,
  version,
  priorVersion,
}: {
  token: string;
  formId: string;
  version: number;
  priorVersion: number | null;
}) {
  const currentQuery = useQuery({
    queryKey: ['form-version', formId, version],
    queryFn: () => fetchFormVersion(token, formId, version),
  });
  const priorQuery = useQuery({
    queryKey: ['form-version', formId, priorVersion],
    queryFn: () => fetchFormVersion(token, formId, priorVersion!),
    enabled: priorVersion !== null,
  });

  if (currentQuery.isLoading || (priorVersion !== null && priorQuery.isLoading)) {
    return <p className="text-xs text-muted">Loading diff…</p>;
  }
  if (priorVersion === null || !priorQuery.data || !currentQuery.data) {
    return <p className="text-xs text-muted">No prior changes.</p>;
  }

  const entries = diffFormFields(priorQuery.data.fields, currentQuery.data.fields);
  if (entries.length === 0) {
    return <p className="text-xs text-muted">No field changes.</p>;
  }

  return (
    <ul className="flex flex-col gap-1 text-xs">
      {entries.map((entry) => (
        <li key={entry.key + entry.description}>{entry.description}</li>
      ))}
    </ul>
  );
}

export function FormVersionHistoryTab({
  token,
  formId,
  onRestored,
}: {
  token: string;
  formId: string;
  onRestored: () => void;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);

  const versionsQuery = useQuery({
    queryKey: ['form-versions', formId],
    queryFn: () => fetchFormVersions(token, formId),
  });

  const restore = useMutation({
    mutationFn: (version: number) => restoreFormVersion(token, formId, version),
    onSuccess: () => {
      setRestoreTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-form', formId] });
      void queryClient.invalidateQueries({ queryKey: ['form-versions', formId] });
      onRestored();
    },
  });

  const versions = versionsQuery.data?.versions ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-2">
          {versions.map((entry, index) => (
            <li key={entry.version} className="rounded-md border border-slate-200 p-2 text-xs">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 text-left"
                onClick={() => setExpanded((v) => (v === entry.version ? null : entry.version))}
              >
                <span className="flex items-center gap-2">
                  <span className="font-semibold">v{entry.version}</span>
                  <span className="text-muted">{entry.actor.display_name}</span>
                  <span className="text-muted">{relativeTime(entry.published_at)}</span>
                </span>
              </button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => setRestoreTarget(entry.version)}
                disabled={restore.isPending}
              >
                Restore
              </Button>
              {expanded === entry.version && (
                <div className="mt-2 border-t border-slate-100 pt-2">
                  <VersionDiff
                    token={token}
                    formId={formId}
                    version={entry.version}
                    priorVersion={versions[index + 1]?.version ?? null}
                  />
                </div>
              )}
            </li>
          ))}
          {versions.length === 0 && (
            <li className="text-xs text-muted">No published versions yet.</li>
          )}
        </ul>
      </ScrollArea>
      {restore.isError && <p className="text-xs text-red-600">{restore.error?.message}</p>}
      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
        title="Restore this version?"
        description="This replaces the current draft with this version's fields. Publish separately when you're ready."
        confirmLabel="Restore version"
        confirming={restore.isPending}
        onConfirm={() => restoreTarget !== null && restore.mutate(restoreTarget)}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Forms/components/FormVersionHistoryTab.test.tsx`
Expected: PASS

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts frontend/src/surfaces/agent-console/pages/Forms/components/FormVersionHistoryTab.tsx frontend/src/surfaces/agent-console/pages/Forms/components/FormVersionHistoryTab.test.tsx
git commit -m "feat: add FormVersionHistoryTab component"
```

---

### Task 5: Frontend — wire the History tab into `FormEditorSheet`

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/Forms/Forms.test.tsx` (verify no regression)

**Interfaces:**
- Consumes: `FormVersionHistoryTab` (Task 4), `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` from `../../../components/ui/tabs.tsx`

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/surfaces/agent-console/pages/Forms/Forms.test.tsx`, inside `describe('Forms route-driven selection', ...)` (after the existing two `it` blocks, before the closing `});` at line 74):

```tsx
  it('shows a History tab for an existing form that switches away from Fields', async () => {
    vi.spyOn(agentApi, 'fetchFormVersions').mockResolvedValue({ versions: [] });

    renderAt('/forms/form-1');

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'History' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    await waitFor(() =>
      expect(screen.getByText('No published versions yet.')).toBeInTheDocument(),
    );
  });
```

Add `fireEvent` to the existing `@testing-library/react` import (line 2):

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Forms/Forms.test.tsx`
Expected: FAIL — no `tab` role named "History" exists yet.

- [ ] **Step 3: Wire `Tabs` into `FormEditorForm`**

In `frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.tsx`, add the import (near the other component imports, after line 43):

```ts
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs.tsx';
import { FormVersionHistoryTab } from './FormVersionHistoryTab.tsx';
```

Add tab state inside `FormEditorForm`, right after the existing `useState` declarations (after line 143, `const [archiveConfirmOpen, ...]`):

```ts
  const [activeTab, setActiveTab] = useState<'fields' | 'history'>('fields');
```

Replace the outer wrapper `<div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">` (line 231) through its matching closing `</div>` (line 453) with a `Tabs`-wrapped version. The existing content between those two lines (the left column with Name/Fields/ShownForPicker, and the right-hand live-preview column) becomes the `fields` tab's content unchanged:

```tsx
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'fields' | 'history')}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList className="mx-4 mt-2 w-fit">
          <TabsTrigger value="fields">Fields</TabsTrigger>
          {formId && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>
        <TabsContent
          value="fields"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden"
        >
          {/* ...unchanged existing content from line 232 through line 452... */}
        </TabsContent>
        {formId && (
          <TabsContent value="history" className="min-h-0 flex-1 overflow-auto p-4">
            <FormVersionHistoryTab
              token={token}
              formId={formId}
              onRestored={() => setActiveTab('fields')}
            />
          </TabsContent>
        )}
      </Tabs>
```

Do not move or alter anything inside the unchanged block (the `{archived && (...)}` banner through the `<FormLivePreview .../>` closing div) — it moves as-is into the `fields` `TabsContent`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Forms/Forms.test.tsx`
Expected: PASS

- [ ] **Step 5: Run the existing `FormEditorSheet` test suite for regressions**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Forms`
Expected: PASS — the Fields tab is the default `activeTab`, so all existing `FormEditorSheet.test.tsx`/`FormTable.test.tsx`/`ShownForPicker.test.tsx` assertions that query Name/Fields/live-preview elements still find them without change. If any assertion fails because it can no longer find an element, it means that element moved into the `fields` `TabsContent` and the test needs no change (Radix `Tabs` renders the active tab's content directly, not behind an extra hidden wrapper) — investigate the actual diff before assuming the test itself needs updating.

- [ ] **Step 6: Typecheck and full frontend suite**

Run: `pnpm typecheck && cd frontend && pnpm vitest run`
Expected: no errors, all tests pass

- [ ] **Step 7: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.tsx frontend/src/surfaces/agent-console/pages/Forms/Forms.test.tsx
git commit -m "feat: add History tab to the form editor"
```

---

## Post-plan manual check

- [ ] Run `pnpm dev`, open the agent console as an Admin, go to Forms, open a form that has at least one published version, click the History tab, expand a version to see the diff, click Restore, confirm in the dialog, and verify the Fields tab shows the restored fields as an unpublished draft.
