# Intents & Subintents Admin Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Admins full CRUD/lifecycle control over the intent → subintent taxonomy (rename, archive, move, merge) through a new admin tab, backed by six new Admin-gated endpoints, while `GET /agent/intents` and `CategorySidebar` keep working unchanged.

**Architecture:** Extends the existing `taxonomyRouter.ts` / `taxonomyController.ts` / `taxonomyService.ts` trio with six new admin-only mutation endpoints, each writing an `appendChangeLog` entry inside the same transaction as its mutation. The frontend adds a new `Taxonomy` page under `agent-console/pages/`, built from two new row components (`IntentRow`, `SubintentRow`) that read/write through six new `agentApi.ts` wrappers and the existing `GET /agent/intents` query.

**Tech Stack:** Express 5 + Zod + Drizzle ORM (backend), React + TanStack Query + shadcn/ui `Select` (frontend). No new dependencies.

**Spec:** `docs/specs/2026-08-19-intents-subintents-admin-design.md`

## Global Constraints

- Nothing is ever deleted — archive only (`archivedAt`). Enforced with `ON DELETE RESTRICT` everywhere already; this feature adds no hard deletes.
- The workspace's `isSystem` intent and its "Other" subintent can never be archived, merged, or moved. The "Other" subintent is identified the same way `resolveFallbackSubintent` (`backend/src/domain/bot/fallbackSubintent.ts`) already identifies it — do not add a new schema column for this.
- Rename is allowed at any time, at any level, with no restriction beyond the existing per-scope unique index.
- Archiving an intent is blocked (409) while it has a non-archived subintent or a published article pointing at it.
- Moving or merging a subintent is always recorded via `appendChangeLog` (before/after).
- Merge always picks a survivor: every `conversation.subintent_id` pointing at the loser is reassigned to the survivor in the same transaction, then the loser is archived with `mergedIntoId` set. The loser is never deleted.
- View (`GET /agent/intents`) stays available to any authenticated agent-session role (Agent, Team Lead, Admin). All six new mutation endpoints are gated with the existing `requireAdminRole` middleware.
- Every mutation writes a `change_log` entry with before/after values via `appendChangeLog`, in the same transaction as the mutation.
- Do **not** build a "create workspace" / auto-seed-Other flow — that's explicitly out of scope (see spec's "Known gap").
- Every new endpoint must be registered in `backend/src/docs/openapi.ts`.
- Frontend: Tailwind v4 utilities only, no hand-written CSS. Reuse existing `components/ui/*` primitives — no new UI library.

---

## Parallelization notes for whoever executes this plan

- **Tasks 1–5** (backend) share three files (`taxonomyService.ts`, `taxonomyController.ts`, `taxonomyRouter.ts`) plus `openapi.ts` and the integration test file — run these **strictly in order**, one subagent at a time.
- **Task 6** (frontend API client) is a single small file; run after Task 5.
- **Tasks 7 and 8** (`IntentRow.tsx`, `SubintentRow.tsx`) touch two independent new files with no import relationship between them — **dispatch these two in parallel.**
- **Task 9** depends on both 7 and 8 (imports both components). **Task 10** depends on Task 9. Run 9 then 10, sequentially.

---

### Task 1: Types + `GET /agent/intents` projection

**Files:**

- Modify: `packages/types/src/articles.ts`
- Modify: `backend/src/agent/services/taxonomyService.ts` (only the `listIntents` function in this task)
- Modify: `backend/tests/agent.taxonomy.test.ts` (only the existing `GET /intents` test)
- Test: `packages/types/tests/taxonomy.types.test.ts` (new)

**Interfaces:**

- Produces (used by every later task): `ConversationPriority`, `RenameIntentBody`, `RenameSubintentBody`, `MoveSubintentBody`, `MergeSubintentBody` (zod schemas), and response types `RenameIntentResponse`, `ArchiveIntentResponse`, `RenameSubintentResponse`, `ArchiveSubintentResponse`, `MoveSubintentResponse`, `MergeSubintentResponse`. Extended `IntentView` (`isSystem: boolean`, `archivedAt: string | null`) and `IntentSubintentView` (`defaultPriority: ConversationPriority | null`, `mergedIntoId: string | null`).

- [ ] **Step 1: Write the failing types test**

Create `packages/types/tests/taxonomy.types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  RenameIntentBody,
  RenameSubintentBody,
  MoveSubintentBody,
  MergeSubintentBody,
} from '../src/index.ts';

describe('RenameIntentBody', () => {
  it('accepts a well-formed name', () => {
    expect(RenameIntentBody.safeParse({ name: 'Billing' }).success).toBe(true);
  });
  it('rejects an empty name', () => {
    expect(RenameIntentBody.safeParse({ name: '' }).success).toBe(false);
  });
});

describe('RenameSubintentBody', () => {
  it('accepts name only', () => {
    expect(RenameSubintentBody.safeParse({ name: 'Refunds' }).success).toBe(true);
  });
  it('accepts defaultPriority only', () => {
    expect(RenameSubintentBody.safeParse({ defaultPriority: 'p2' }).success).toBe(true);
  });
  it('accepts both', () => {
    expect(RenameSubintentBody.safeParse({ name: 'Refunds', defaultPriority: 'p1' }).success).toBe(
      true,
    );
  });
  it('accepts an empty body — the endpoint allows a no-op patch', () => {
    expect(RenameSubintentBody.safeParse({}).success).toBe(true);
  });
  it('rejects an invalid priority', () => {
    expect(RenameSubintentBody.safeParse({ defaultPriority: 'p9' }).success).toBe(false);
  });
});

describe('MoveSubintentBody', () => {
  it('requires a uuid intentId', () => {
    expect(MoveSubintentBody.safeParse({ intentId: 'not-a-uuid' }).success).toBe(false);
    expect(
      MoveSubintentBody.safeParse({ intentId: '11111111-1111-1111-1111-111111111111' }).success,
    ).toBe(true);
  });
});

describe('MergeSubintentBody', () => {
  it('requires a uuid intoId', () => {
    expect(MergeSubintentBody.safeParse({ intoId: 'nope' }).success).toBe(false);
    expect(
      MergeSubintentBody.safeParse({ intoId: '11111111-1111-1111-1111-111111111111' }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @support/types test`
Expected: FAIL — `RenameIntentBody` etc. are not exported from `../src/index.ts`.

- [ ] **Step 3: Implement the types**

In `packages/types/src/articles.ts`, add near the existing `CreateIntentBody`/`CreateSubintentBody`:

```ts
export type ConversationPriority = 'p1' | 'p2' | 'p3' | 'p4';

export const RenameIntentBody = z.object({ name: z.string().min(1).max(120) });
export const RenameSubintentBody = z.object({
  name: z.string().min(1).max(120).optional(),
  defaultPriority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
});
export const MoveSubintentBody = z.object({ intentId: z.uuid() });
export const MergeSubintentBody = z.object({ intoId: z.uuid() });
```

Replace the existing view types with:

```ts
export type IntentSubintentView = {
  id: string;
  name: string;
  formId: string | null;
  archivedAt: string | null;
  defaultPriority: ConversationPriority | null;
  mergedIntoId: string | null;
};
export type IntentView = {
  id: string;
  name: string;
  isSystem: boolean;
  archivedAt: string | null;
  subintents: IntentSubintentView[];
};
export type IntentsResponse = { intents: IntentView[] };
export type CreateIntentResponse = { id: string; name: string };
export type CreateSubintentResponse = { id: string; name: string; intent_id: string };

export type RenameIntentResponse = { id: string; name: string };
export type ArchiveIntentResponse = { id: string; name: string; archivedAt: string };
export type RenameSubintentResponse = {
  id: string;
  name: string;
  defaultPriority: ConversationPriority | null;
};
export type ArchiveSubintentResponse = { id: string; name: string; archivedAt: string };
export type MoveSubintentResponse = { id: string; name: string; intentId: string };
export type MergeSubintentResponse = {
  id: string;
  name: string;
  archivedAt: string;
  mergedIntoId: string;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/types test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/articles.ts packages/types/tests/taxonomy.types.test.ts
git commit -m "types: add taxonomy admin request/response types"
```

- [ ] **Step 6: Update the failing backend integration test for the new projection**

In `backend/tests/agent.taxonomy.test.ts`, update the existing `'lists intents with nested subintents for any role'` test's final assertions:

```ts
expect(res.body.intents).toHaveLength(1);
expect(res.body.intents[0]).toEqual({
  id: rows[0]!.id,
  name: 'Billing',
  isSystem: false,
  archivedAt: null,
  subintents: [
    {
      id: expect.any(String),
      name: 'Refunds',
      formId: null,
      archivedAt: null,
      defaultPriority: null,
      mergedIntoId: null,
    },
  ],
});
```

(Delete the old two-line `expect(res.body.intents[0].name)...` / `expect(res.body.intents[0].subintents)...` pair it replaces.)

- [ ] **Step 7: Run to verify it fails**

Run: `pnpm --filter backend test -- agent.taxonomy`
Expected: FAIL — actual body is missing `isSystem`, `archivedAt`, `defaultPriority`, `mergedIntoId`.

- [ ] **Step 8: Update `listIntents` in `taxonomyService.ts`**

Replace the two `select` calls and the mapping inside `listIntents` with:

```ts
export async function listIntents(ctx: AgentContext): Promise<IntentsResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const intents = await tx
      .select({
        id: intent.id,
        name: intent.name,
        isSystem: intent.isSystem,
        archivedAt: intent.archivedAt,
      })
      .from(intent)
      .orderBy(asc(intent.name));
    const subintents = await tx
      .select({
        id: subintent.id,
        name: subintent.name,
        intentId: subintent.intentId,
        formId: subintent.formId,
        archivedAt: subintent.archivedAt,
        defaultPriority: subintent.defaultPriority,
        mergedIntoId: subintent.mergedIntoId,
      })
      .from(subintent)
      .orderBy(asc(subintent.name));
    return {
      intents: intents.map((i) => ({
        id: i.id,
        name: i.name,
        isSystem: i.isSystem,
        archivedAt: i.archivedAt ? i.archivedAt.toISOString() : null,
        subintents: subintents
          .filter((s) => s.intentId === i.id)
          .map((s) => ({
            id: s.id,
            name: s.name,
            formId: s.formId,
            archivedAt: s.archivedAt ? s.archivedAt.toISOString() : null,
            defaultPriority: s.defaultPriority,
            mergedIntoId: s.mergedIntoId,
          })),
      })),
    };
  });
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm --filter backend test -- agent.taxonomy`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add backend/src/agent/services/taxonomyService.ts backend/tests/agent.taxonomy.test.ts
git commit -m "feat(taxonomy): project isSystem/archivedAt/defaultPriority/mergedIntoId in GET /agent/intents"
```

---

### Task 2: `PATCH /agent/intents/:id` (rename) + `POST /agent/intents/:id/archive`

**Files:**

- Modify: `backend/src/agent/services/taxonomyService.ts`
- Modify: `backend/src/agent/controllers/taxonomyController.ts`
- Modify: `backend/src/agent/routers/taxonomyRouter.ts`
- Modify: `backend/src/errors.ts` (add two `ErrorCode` values)
- Modify: `backend/src/docs/openapi.ts`
- Modify: `backend/tests/helpers/db.ts` (`seedIntent` gets an optional `isSystem` param)
- Test: `backend/tests/agent.taxonomy.test.ts`

**Interfaces:**

- Consumes: `RenameIntentBody`, `RenameIntentResponse`, `ArchiveIntentResponse` from `@support/types` (Task 1). `AgentContext` from `backend/src/shared/middleware/requireAgentSession.ts`. `appendChangeLog` from `backend/src/shared/changeLog/appendChangeLog.ts`.
- Produces: `renameIntent(ctx, id, name)` and `archiveIntent(ctx, id)` in `taxonomyService.ts`, used by no later task but establishing the pattern Tasks 3–5 follow.

- [ ] **Step 1: Extend `seedIntent` to allow seeding the system intent**

In `backend/tests/helpers/db.ts`, replace:

```ts
export async function seedIntent(
  workspaceId: string,
  name = `Intent ${randomUUID().slice(0, 8)}`,
): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(`insert into intent (id, workspace_id, name) values ($1, $2, $3)`, [
    id,
    workspaceId,
    name,
  ]);
  return id;
}
```

with:

```ts
export async function seedIntent(
  workspaceId: string,
  name = `Intent ${randomUUID().slice(0, 8)}`,
  isSystem = false,
): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into intent (id, workspace_id, name, is_system) values ($1, $2, $3, $4)`,
    [id, workspaceId, name, isSystem],
  );
  return id;
}
```

This is backward compatible — every existing call site passes 0–2 args.

- [ ] **Step 2: Write the failing tests**

In `backend/tests/agent.taxonomy.test.ts`, add `randomUUID` to the imports (`import { randomUUID } from 'node:crypto'`) and `seedIntent, seedSubintent, seedArticle` to the `import { ... } from './helpers/db.ts'` line. Then append:

```ts
describe('PATCH /intents/:id', () => {
  it('renames an intent for an admin', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .patch(`/intents/${intentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Payments' })
      .expect(200);

    expect(res.body).toEqual({ id: intentId, name: 'Payments' });
  });

  it('409s on a name collision with another intent in the workspace', async () => {
    const workspaceId = await seedWorkspace();
    await seedIntent(workspaceId, 'Payments');
    const intentId = await seedIntent(workspaceId, 'Billing');
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .patch(`/intents/${intentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Payments' })
      .expect(409);
  });

  it('refuses a non-admin agent with 403', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .patch(`/intents/${intentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Payments' })
      .expect(403);
  });

  it('404s for an unknown intent id', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .patch(`/intents/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Payments' })
      .expect(404);
  });
});

describe('POST /intents/:id/archive', () => {
  it('archives an intent with no active subintents or published articles', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post(`/intents/${intentId}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toEqual({ id: intentId, name: 'Billing', archivedAt: expect.any(String) });
  });

  it('409s for the isSystem intent', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Other', true);
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/intents/${intentId}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });

  it('409s while a non-archived subintent still points at it', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    await seedSubintent({ workspaceId, intentId, name: 'Refunds' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/intents/${intentId}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });

  it('409s while a published article still points at it', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const { agentId, token } = await seedAgentWithRole(workspaceId, 'admin');
    const articleId = await seedArticle({
      workspaceId,
      createdBy: agentId,
      title: 'Refund policy',
    });
    await ownerPool.query(`update article set intent_id = $1, state = 'published' where id = $2`, [
      intentId,
      articleId,
    ]);

    await request(app)
      .post(`/intents/${intentId}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter backend test -- agent.taxonomy`
Expected: FAIL — `PATCH /intents/:id` and `POST /intents/:id/archive` are 404 (route doesn't exist).

- [ ] **Step 4: Add the two `ErrorCode` values**

In `backend/src/errors.ts`, add `'name_taken'` and `'not_archivable'` to the `ErrorCode` union:

```ts
export type ErrorCode =
  | 'unauthorized'
  | 'workspace_mismatch'
  | 'forbidden'
  | 'not_found'
  | 'unparseable_body'
  | 'invalid_request'
  | 'internal'
  | 'wrong_status'
  | 'not_owner'
  | 'already_pending'
  | 'no_check_pending'
  | 'conversation_still_open'
  | 'no_form_pending'
  | 'unknown_field'
  | 'invalid_value'
  | 'unsupported_field_type'
  | 'name_taken'
  | 'not_archivable';
```

- [ ] **Step 5: Implement `renameIntent` and `archiveIntent` in `taxonomyService.ts`**

Add these imports to the top of `taxonomyService.ts` (merge with the existing ones):

```ts
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type {
  ArchiveIntentResponse,
  CreateIntentResponse,
  CreateSubintentResponse,
  IntentsResponse,
  RenameIntentResponse,
} from '@support/types';
import { article, intent, subintent } from '../../shared/db/schema/index.ts';
import { appendChangeLog } from '../../shared/changeLog/appendChangeLog.ts';
```

Append:

```ts
export type RenameIntentResult =
  { ok: true; intent: RenameIntentResponse } | { ok: false; reason: 'not_found' | 'name_taken' };

export async function renameIntent(
  ctx: AgentContext,
  id: string,
  name: string,
): Promise<RenameIntentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({ id: intent.id, name: intent.name })
      .from(intent)
      .where(eq(intent.id, id))
      .limit(1);
    if (!current) return { ok: false, reason: 'not_found' };

    const [collision] = await tx
      .select({ id: intent.id })
      .from(intent)
      .where(and(eq(intent.workspaceId, ctx.workspaceId), eq(intent.name, name), ne(intent.id, id)))
      .limit(1);
    if (collision) return { ok: false, reason: 'name_taken' };

    const [row] = await tx
      .update(intent)
      .set({ name })
      .where(eq(intent.id, id))
      .returning({ id: intent.id, name: intent.name });
    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'intent',
      entityId: id,
      actorId: ctx.agentId,
      changes: [{ field: 'name', before: current.name, after: name }],
    });
    return { ok: true, intent: row! };
  });
}

export type ArchiveIntentResult =
  | { ok: true; intent: ArchiveIntentResponse }
  | {
      ok: false;
      reason: 'not_found' | 'is_system' | 'has_active_subintents' | 'has_published_articles';
    };

export async function archiveIntent(ctx: AgentContext, id: string): Promise<ArchiveIntentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({
        id: intent.id,
        name: intent.name,
        isSystem: intent.isSystem,
        archivedAt: intent.archivedAt,
      })
      .from(intent)
      .where(eq(intent.id, id))
      .limit(1);
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.isSystem) return { ok: false, reason: 'is_system' };

    const [activeSubintent] = await tx
      .select({ id: subintent.id })
      .from(subintent)
      .where(and(eq(subintent.intentId, id), isNull(subintent.archivedAt)))
      .limit(1);
    if (activeSubintent) return { ok: false, reason: 'has_active_subintents' };

    const [publishedArticle] = await tx
      .select({ id: article.id })
      .from(article)
      .where(and(eq(article.intentId, id), eq(article.state, 'published')))
      .limit(1);
    if (publishedArticle) return { ok: false, reason: 'has_published_articles' };

    const [row] = await tx
      .update(intent)
      .set({ archivedAt: new Date() })
      .where(eq(intent.id, id))
      .returning({ id: intent.id, name: intent.name, archivedAt: intent.archivedAt });
    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'intent',
      entityId: id,
      actorId: ctx.agentId,
      changes: [{ field: 'archived_at', before: current.archivedAt, after: row!.archivedAt }],
    });
    return {
      ok: true,
      intent: { id: row!.id, name: row!.name, archivedAt: row!.archivedAt!.toISOString() },
    };
  });
}
```

- [ ] **Step 6: Implement the two controller handlers**

In `taxonomyController.ts`, add to the imports:

```ts
import { CreateIntentBody, CreateSubintentBody, RenameIntentBody } from '@support/types';
import {
  archiveIntent,
  createIntent,
  createSubintent,
  listIntents,
  renameIntent,
} from '../services/taxonomyService.ts';
```

Append:

```ts
export const renameIntentHandler: RequestHandler = async (req, res) => {
  const params = IntentIdParams.safeParse(req.params);
  const body = RenameIntentBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'A valid intent id and name are required.');
    return;
  }
  const result = await renameIntent(req.agent!, params.data.id, body.data.name);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Intent not found.');
      return;
    }
    sendError(res, 409, 'name_taken', 'Another intent already has this name.');
    return;
  }
  res.status(200).json(result.intent);
};

export const archiveIntentHandler: RequestHandler = async (req, res) => {
  const params = IntentIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid intent id is required.');
    return;
  }
  const result = await archiveIntent(req.agent!, params.data.id);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Intent not found.');
      return;
    }
    if (result.reason === 'is_system') {
      sendError(res, 409, 'not_archivable', 'The "Other" intent can never be archived.');
      return;
    }
    if (result.reason === 'has_active_subintents') {
      sendError(
        res,
        409,
        'not_archivable',
        'Archive or move every subintent under this intent first.',
      );
      return;
    }
    sendError(res, 409, 'not_archivable', 'A published article still points at this intent.');
    return;
  }
  res.status(200).json(result.intent);
};
```

- [ ] **Step 7: Wire the router**

In `taxonomyRouter.ts`:

```ts
import { Router } from 'express';
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts';
import {
  archiveIntentHandler,
  createIntentHandler,
  createSubintentHandler,
  listIntentsHandler,
  renameIntentHandler,
} from '../controllers/taxonomyController.ts';

export const taxonomyRouter = Router();
taxonomyRouter.get('/intents', listIntentsHandler);
taxonomyRouter.post('/intents', requireAdminRole, createIntentHandler);
taxonomyRouter.patch('/intents/:id', requireAdminRole, renameIntentHandler);
taxonomyRouter.post('/intents/:id/archive', requireAdminRole, archiveIntentHandler);
taxonomyRouter.post('/intents/:id/subintents', requireAdminRole, createSubintentHandler);
```

- [ ] **Step 8: Register both routes in `openapi.ts`**

Add after the existing `POST /agent/intents/{id}/subintents` registration:

```ts
registry.registerPath({
  method: 'patch',
  path: '/agent/intents/{id}',
  summary: 'Agent Rename Intent',
  description: 'Renames an intent. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(120) }) } },
    },
  },
  responses: {
    200: { description: 'Intent renamed' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Intent not found' },
    409: { description: 'Another intent already has this name' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/intents/{id}/archive',
  summary: 'Agent Archive Intent',
  description:
    'Archives an intent. Admin-only. Blocked while active subintents or published articles reference it.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Intent archived' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Intent not found' },
    409: { description: 'Not archivable — is the system intent, or still referenced' },
  },
});
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm --filter backend test -- agent.taxonomy`
Expected: PASS (all `PATCH /intents/:id` and `POST /intents/:id/archive` tests, plus all pre-existing tests in the file)

- [ ] **Step 10: Typecheck**

Run: `pnpm typecheck`
Expected: no errors

- [ ] **Step 11: Commit**

```bash
git add backend/src/agent/services/taxonomyService.ts backend/src/agent/controllers/taxonomyController.ts \
  backend/src/agent/routers/taxonomyRouter.ts backend/src/errors.ts backend/src/docs/openapi.ts \
  backend/tests/agent.taxonomy.test.ts backend/tests/helpers/db.ts
git commit -m "feat(taxonomy): add rename and archive endpoints for intents"
```

---

### Task 3: `PATCH /agent/subintents/:id` (rename/priority) + `POST /agent/subintents/:id/archive`

**Files:**

- Modify: `backend/src/agent/services/taxonomyService.ts`
- Modify: `backend/src/agent/controllers/taxonomyController.ts`
- Modify: `backend/src/agent/routers/taxonomyRouter.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.taxonomy.test.ts`

**Interfaces:**

- Consumes: `RenameSubintentBody`, `RenameSubintentResponse`, `ArchiveSubintentResponse` from `@support/types`. `resolveFallbackSubintent(tx, workspaceId): Promise<string>` from `backend/src/domain/bot/fallbackSubintent.ts` — the existing, only mechanism in this codebase for identifying the workspace's "Other" subintent. Reuse it; do not add an `isSystem` column to `subintent`.
- Produces: `renameSubintent(ctx, id, patch)` and `archiveSubintent(ctx, id)`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/agent.taxonomy.test.ts`:

```ts
describe('PATCH /subintents/:id', () => {
  it('renames a subintent and sets its default priority', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Refunds' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .patch(`/subintents/${subintentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Refund Requests', defaultPriority: 'p2' })
      .expect(200);

    expect(res.body).toEqual({ id: subintentId, name: 'Refund Requests', defaultPriority: 'p2' });
  });

  it('409s on a name collision within the same intent', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    await seedSubintent({ workspaceId, intentId, name: 'Refunds' });
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Invoices' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .patch(`/subintents/${subintentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Refunds' })
      .expect(409);
  });

  it('404s for an unknown subintent id', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .patch(`/subintents/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Refunds' })
      .expect(404);
  });
});

describe('POST /subintents/:id/archive', () => {
  it('archives a subintent', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Refunds' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post(`/subintents/${subintentId}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toEqual({ id: subintentId, name: 'Refunds', archivedAt: expect.any(String) });
  });

  it("409s for the workspace's Other subintent", async () => {
    const workspaceId = await seedWorkspace();
    const otherIntentId = await seedIntent(workspaceId, 'Other', true);
    const otherSubintentId = await seedSubintent({
      workspaceId,
      intentId: otherIntentId,
      name: 'Other',
    });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/subintents/${otherSubintentId}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter backend test -- agent.taxonomy`
Expected: FAIL — routes don't exist yet.

- [ ] **Step 3: Implement `renameSubintent` and `archiveSubintent` in `taxonomyService.ts`**

Add to imports: `ArchiveSubintentResponse`, `ConversationPriority`, `RenameSubintentResponse` from `@support/types`, and `import { resolveFallbackSubintent } from '../../domain/bot/fallbackSubintent.ts'`.

Append:

```ts
export type RenameSubintentResult =
  | { ok: true; subintent: RenameSubintentResponse }
  | { ok: false; reason: 'not_found' | 'name_taken' };

export async function renameSubintent(
  ctx: AgentContext,
  id: string,
  patch: { name?: string; defaultPriority?: ConversationPriority },
): Promise<RenameSubintentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({
        id: subintent.id,
        name: subintent.name,
        intentId: subintent.intentId,
        defaultPriority: subintent.defaultPriority,
      })
      .from(subintent)
      .where(eq(subintent.id, id))
      .limit(1);
    if (!current) return { ok: false, reason: 'not_found' };

    if (patch.name === undefined && patch.defaultPriority === undefined) {
      return {
        ok: true,
        subintent: { id: current.id, name: current.name, defaultPriority: current.defaultPriority },
      };
    }

    if (patch.name !== undefined && patch.name !== current.name) {
      const [collision] = await tx
        .select({ id: subintent.id })
        .from(subintent)
        .where(
          and(
            eq(subintent.workspaceId, ctx.workspaceId),
            eq(subintent.intentId, current.intentId),
            eq(subintent.name, patch.name),
            ne(subintent.id, id),
          ),
        )
        .limit(1);
      if (collision) return { ok: false, reason: 'name_taken' };
    }

    const changes: { field: string; before: unknown; after: unknown }[] = [];
    if (patch.name !== undefined)
      changes.push({ field: 'name', before: current.name, after: patch.name });
    if (patch.defaultPriority !== undefined) {
      changes.push({
        field: 'default_priority',
        before: current.defaultPriority,
        after: patch.defaultPriority,
      });
    }

    const [row] = await tx
      .update(subintent)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.defaultPriority !== undefined ? { defaultPriority: patch.defaultPriority } : {}),
      })
      .where(eq(subintent.id, id))
      .returning({
        id: subintent.id,
        name: subintent.name,
        defaultPriority: subintent.defaultPriority,
      });

    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'subintent',
      entityId: id,
      actorId: ctx.agentId,
      changes,
    });
    return { ok: true, subintent: row! };
  });
}

export type ArchiveSubintentResult =
  | { ok: true; subintent: ArchiveSubintentResponse }
  | { ok: false; reason: 'not_found' | 'is_other' };

export async function archiveSubintent(
  ctx: AgentContext,
  id: string,
): Promise<ArchiveSubintentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({ id: subintent.id, name: subintent.name, archivedAt: subintent.archivedAt })
      .from(subintent)
      .where(eq(subintent.id, id))
      .limit(1);
    if (!current) return { ok: false, reason: 'not_found' };

    const otherId = await resolveFallbackSubintent(tx, ctx.workspaceId);
    if (current.id === otherId) return { ok: false, reason: 'is_other' };

    const [row] = await tx
      .update(subintent)
      .set({ archivedAt: new Date() })
      .where(eq(subintent.id, id))
      .returning({ id: subintent.id, name: subintent.name, archivedAt: subintent.archivedAt });
    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'subintent',
      entityId: id,
      actorId: ctx.agentId,
      changes: [{ field: 'archived_at', before: current.archivedAt, after: row!.archivedAt }],
    });
    return {
      ok: true,
      subintent: { id: row!.id, name: row!.name, archivedAt: row!.archivedAt!.toISOString() },
    };
  });
}
```

Note: `resolveFallbackSubintent` throws if the workspace has no seeded "Other" subintent. This is existing, intentional behaviour (see its own doc comment) — every real workspace has one seeded; a workspace missing it is a provisioning bug, not something `archiveSubintent` should paper over.

- [ ] **Step 4: Implement the two controller handlers**

In `taxonomyController.ts`, add near `IntentIdParams`:

```ts
const SubintentIdParams = z.object({ id: z.uuid() });
```

Add to imports: `RenameSubintentBody` from `@support/types`, and `archiveSubintent, renameSubintent` from the service.

Append:

```ts
export const renameSubintentHandler: RequestHandler = async (req, res) => {
  const params = SubintentIdParams.safeParse(req.params);
  const body = RenameSubintentBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'A valid subintent id is required.');
    return;
  }
  const result = await renameSubintent(req.agent!, params.data.id, body.data);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Subintent not found.');
      return;
    }
    sendError(res, 409, 'name_taken', 'Another subintent under this intent already has this name.');
    return;
  }
  res.status(200).json(result.subintent);
};

export const archiveSubintentHandler: RequestHandler = async (req, res) => {
  const params = SubintentIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid subintent id is required.');
    return;
  }
  const result = await archiveSubintent(req.agent!, params.data.id);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Subintent not found.');
      return;
    }
    sendError(res, 409, 'not_archivable', 'The "Other" subintent can never be archived.');
    return;
  }
  res.status(200).json(result.subintent);
};
```

- [ ] **Step 5: Wire the router**

In `taxonomyRouter.ts`, add to the import and to the router body:

```ts
taxonomyRouter.patch('/subintents/:id', requireAdminRole, renameSubintentHandler);
taxonomyRouter.post('/subintents/:id/archive', requireAdminRole, archiveSubintentHandler);
```

- [ ] **Step 6: Register both routes in `openapi.ts`**

```ts
registry.registerPath({
  method: 'patch',
  path: '/agent/subintents/{id}',
  summary: 'Agent Rename/Reprioritize Subintent',
  description: 'Renames a subintent and/or sets its default priority. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(120).optional(),
            defaultPriority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Subintent updated' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Subintent not found' },
    409: { description: 'Another subintent under this intent already has this name' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/subintents/{id}/archive',
  summary: 'Agent Archive Subintent',
  description:
    'Archives a subintent. Admin-only. The workspace’s "Other" subintent can never be archived.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Subintent archived' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Subintent not found' },
    409: { description: 'Not archivable — this is the "Other" subintent' },
  },
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter backend test -- agent.taxonomy`
Expected: PASS

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`

- [ ] **Step 9: Commit**

```bash
git add backend/src/agent/services/taxonomyService.ts backend/src/agent/controllers/taxonomyController.ts \
  backend/src/agent/routers/taxonomyRouter.ts backend/src/docs/openapi.ts backend/tests/agent.taxonomy.test.ts
git commit -m "feat(taxonomy): add rename/reprioritize and archive endpoints for subintents"
```

---

### Task 4: `POST /agent/subintents/:id/move`

**Files:**

- Modify: `backend/src/agent/services/taxonomyService.ts`
- Modify: `backend/src/agent/controllers/taxonomyController.ts`
- Modify: `backend/src/agent/routers/taxonomyRouter.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.taxonomy.test.ts`

**Interfaces:**

- Consumes: `MoveSubintentBody`, `MoveSubintentResponse` from `@support/types`.
- Produces: `moveSubintent(ctx, id, targetIntentId)`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('POST /subintents/:id/move', () => {
  it('moves a subintent to a new intent', async () => {
    const workspaceId = await seedWorkspace();
    const billingId = await seedIntent(workspaceId, 'Billing');
    const accountId = await seedIntent(workspaceId, 'Account Access');
    const subintentId = await seedSubintent({ workspaceId, intentId: billingId, name: 'Refunds' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post(`/subintents/${subintentId}/move`)
      .set('Authorization', `Bearer ${token}`)
      .send({ intentId: accountId })
      .expect(200);

    expect(res.body).toEqual({ id: subintentId, name: 'Refunds', intentId: accountId });
  });

  it('404s when the target intent is archived', async () => {
    const workspaceId = await seedWorkspace();
    const billingId = await seedIntent(workspaceId, 'Billing');
    const archivedIntentId = await seedIntent(workspaceId, 'Old Category');
    await ownerPool.query(`update intent set archived_at = now() where id = $1`, [
      archivedIntentId,
    ]);
    const subintentId = await seedSubintent({ workspaceId, intentId: billingId, name: 'Refunds' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/subintents/${subintentId}/move`)
      .set('Authorization', `Bearer ${token}`)
      .send({ intentId: archivedIntentId })
      .expect(404);
  });

  it('404s when the target intent does not exist', async () => {
    const workspaceId = await seedWorkspace();
    const billingId = await seedIntent(workspaceId, 'Billing');
    const subintentId = await seedSubintent({ workspaceId, intentId: billingId, name: 'Refunds' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/subintents/${subintentId}/move`)
      .set('Authorization', `Bearer ${token}`)
      .send({ intentId: randomUUID() })
      .expect(404);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter backend test -- agent.taxonomy`
Expected: FAIL

- [ ] **Step 3: Implement `moveSubintent` in `taxonomyService.ts`**

Add `MoveSubintentResponse` to the `@support/types` import. Append:

```ts
export type MoveSubintentResult =
  | { ok: true; subintent: MoveSubintentResponse }
  | { ok: false; reason: 'not_found' | 'target_not_found' };

export async function moveSubintent(
  ctx: AgentContext,
  id: string,
  targetIntentId: string,
): Promise<MoveSubintentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({ id: subintent.id, name: subintent.name, intentId: subintent.intentId })
      .from(subintent)
      .where(eq(subintent.id, id))
      .limit(1);
    if (!current) return { ok: false, reason: 'not_found' };

    const [target] = await tx
      .select({ id: intent.id })
      .from(intent)
      .where(and(eq(intent.id, targetIntentId), isNull(intent.archivedAt)))
      .limit(1);
    if (!target) return { ok: false, reason: 'target_not_found' };

    const [row] = await tx
      .update(subintent)
      .set({ intentId: targetIntentId })
      .where(eq(subintent.id, id))
      .returning({ id: subintent.id, name: subintent.name, intentId: subintent.intentId });
    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'subintent',
      entityId: id,
      actorId: ctx.agentId,
      changes: [{ field: 'intent_id', before: current.intentId, after: row!.intentId }],
    });
    return { ok: true, subintent: row! };
  });
}
```

- [ ] **Step 4: Implement the controller handler**

Add `MoveSubintentBody` to the `@support/types` import and `moveSubintent` to the service import. Append:

```ts
export const moveSubintentHandler: RequestHandler = async (req, res) => {
  const params = SubintentIdParams.safeParse(req.params);
  const body = MoveSubintentBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'A valid subintent id and target intent id are required.',
    );
    return;
  }
  const result = await moveSubintent(req.agent!, params.data.id, body.data.intentId);
  if (!result.ok) {
    sendError(
      res,
      404,
      result.reason === 'not_found' ? 'not_found' : 'not_found',
      'Subintent or target intent not found.',
    );
    return;
  }
  res.status(200).json(result.subintent);
};
```

- [ ] **Step 5: Wire the router**

```ts
taxonomyRouter.post('/subintents/:id/move', requireAdminRole, moveSubintentHandler);
```

- [ ] **Step 6: Register the route in `openapi.ts`**

```ts
registry.registerPath({
  method: 'post',
  path: '/agent/subintents/{id}/move',
  summary: 'Agent Move Subintent',
  description: 'Moves a subintent to a different intent. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: z.object({ intentId: z.uuid() }) } } },
  },
  responses: {
    200: { description: 'Subintent moved' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Subintent or target intent not found (or target is archived)' },
  },
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter backend test -- agent.taxonomy`
Expected: PASS

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`

- [ ] **Step 9: Commit**

```bash
git add backend/src/agent/services/taxonomyService.ts backend/src/agent/controllers/taxonomyController.ts \
  backend/src/agent/routers/taxonomyRouter.ts backend/src/docs/openapi.ts backend/tests/agent.taxonomy.test.ts
git commit -m "feat(taxonomy): add move endpoint for subintents"
```

---

### Task 5: `POST /agent/subintents/:id/merge`

**Files:**

- Modify: `backend/src/agent/services/taxonomyService.ts`
- Modify: `backend/src/agent/controllers/taxonomyController.ts`
- Modify: `backend/src/agent/routers/taxonomyRouter.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.taxonomy.test.ts`

**Interfaces:**

- Consumes: `MergeSubintentBody`, `MergeSubintentResponse` from `@support/types`. `conversation` table from `backend/src/shared/db/schema/index.ts`.
- Produces: `mergeSubintent(ctx, loserId, survivorId)`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('POST /subintents/:id/merge', () => {
  it('reassigns conversations to the survivor and archives the loser with mergedIntoId set', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const loserId = await seedSubintent({ workspaceId, intentId, name: 'Refunds' });
    const survivorId = await seedSubintent({ workspaceId, intentId, name: 'Refund Requests' });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set subintent_id = $1 where id = $2`, [
      loserId,
      conversationId,
    ]);
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post(`/subintents/${loserId}/merge`)
      .set('Authorization', `Bearer ${token}`)
      .send({ intoId: survivorId })
      .expect(200);

    expect(res.body).toEqual({
      id: loserId,
      name: 'Refunds',
      archivedAt: expect.any(String),
      mergedIntoId: survivorId,
    });

    const { rows } = await ownerPool.query<{ subintent_id: string }>(
      `select subintent_id from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.subintent_id).toBe(survivorId);
  });

  it('409s when the target is archived', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const loserId = await seedSubintent({ workspaceId, intentId, name: 'Refunds' });
    const survivorId = await seedSubintent({ workspaceId, intentId, name: 'Refund Requests' });
    await ownerPool.query(`update subintent set archived_at = now() where id = $1`, [survivorId]);
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/subintents/${loserId}/merge`)
      .set('Authorization', `Bearer ${token}`)
      .send({ intoId: survivorId })
      .expect(409);
  });

  it('409s when the target is the loser itself', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Refunds' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/subintents/${subintentId}/merge`)
      .set('Authorization', `Bearer ${token}`)
      .send({ intoId: subintentId })
      .expect(409);
  });

  it('409s when the target belongs to a different workspace', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const intentA = await seedIntent(workspaceA, 'Billing');
    const intentB = await seedIntent(workspaceB, 'Billing');
    const loserId = await seedSubintent({
      workspaceId: workspaceA,
      intentId: intentA,
      name: 'Refunds',
    });
    const otherWorkspaceSubintentId = await seedSubintent({
      workspaceId: workspaceB,
      intentId: intentB,
      name: 'Refunds',
    });
    const { token } = await seedAgentWithRole(workspaceA, 'admin');

    await request(app)
      .post(`/subintents/${loserId}/merge`)
      .set('Authorization', `Bearer ${token}`)
      .send({ intoId: otherWorkspaceSubintentId })
      .expect(409);
  });

  it("409s when the loser is the workspace's Other subintent", async () => {
    const workspaceId = await seedWorkspace();
    const otherIntentId = await seedIntent(workspaceId, 'Other', true);
    const otherSubintentId = await seedSubintent({
      workspaceId,
      intentId: otherIntentId,
      name: 'Other',
    });
    const billingIntentId = await seedIntent(workspaceId, 'Billing');
    const survivorId = await seedSubintent({
      workspaceId,
      intentId: billingIntentId,
      name: 'Refunds',
    });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/subintents/${otherSubintentId}/merge`)
      .set('Authorization', `Bearer ${token}`)
      .send({ intoId: survivorId })
      .expect(409);
  });
});
```

Add `seedPlayer, seedConversation` to the `./helpers/db.ts` import line.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter backend test -- agent.taxonomy`
Expected: FAIL

- [ ] **Step 3: Implement `mergeSubintent` in `taxonomyService.ts`**

Add `MergeSubintentResponse` to the `@support/types` import, and `conversation` to the schema import (`import { article, conversation, intent, subintent } from '../../shared/db/schema/index.ts'`). Append:

```ts
export type MergeSubintentResult =
  | { ok: true; subintent: MergeSubintentResponse }
  | { ok: false; reason: 'not_found' | 'target_invalid' | 'is_other' };

export async function mergeSubintent(
  ctx: AgentContext,
  loserId: string,
  survivorId: string,
): Promise<MergeSubintentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [loser] = await tx
      .select({
        id: subintent.id,
        name: subintent.name,
        archivedAt: subintent.archivedAt,
        mergedIntoId: subintent.mergedIntoId,
      })
      .from(subintent)
      .where(eq(subintent.id, loserId))
      .limit(1);
    if (!loser) return { ok: false, reason: 'not_found' };

    if (survivorId === loserId) return { ok: false, reason: 'target_invalid' };

    const [survivor] = await tx
      .select({ id: subintent.id })
      .from(subintent)
      .where(
        and(
          eq(subintent.id, survivorId),
          eq(subintent.workspaceId, ctx.workspaceId),
          isNull(subintent.archivedAt),
        ),
      )
      .limit(1);
    if (!survivor) return { ok: false, reason: 'target_invalid' };

    const otherId = await resolveFallbackSubintent(tx, ctx.workspaceId);
    if (loser.id === otherId) return { ok: false, reason: 'is_other' };

    await tx
      .update(conversation)
      .set({ subintentId: survivorId })
      .where(eq(conversation.subintentId, loserId));

    const archivedAt = new Date();
    const [row] = await tx
      .update(subintent)
      .set({ archivedAt, mergedIntoId: survivorId })
      .where(eq(subintent.id, loserId))
      .returning({
        id: subintent.id,
        name: subintent.name,
        archivedAt: subintent.archivedAt,
        mergedIntoId: subintent.mergedIntoId,
      });

    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'subintent',
      entityId: loserId,
      actorId: ctx.agentId,
      changes: [
        { field: 'merged_into_id', before: loser.mergedIntoId, after: row!.mergedIntoId },
        { field: 'archived_at', before: loser.archivedAt, after: row!.archivedAt },
      ],
    });
    return {
      ok: true,
      subintent: {
        id: row!.id,
        name: row!.name,
        archivedAt: row!.archivedAt!.toISOString(),
        mergedIntoId: row!.mergedIntoId!,
      },
    };
  });
}
```

- [ ] **Step 4: Implement the controller handler**

Add `MergeSubintentBody` to the `@support/types` import and `mergeSubintent` to the service import. Append:

```ts
export const mergeSubintentHandler: RequestHandler = async (req, res) => {
  const params = SubintentIdParams.safeParse(req.params);
  const body = MergeSubintentBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'A valid subintent id and merge target id are required.',
    );
    return;
  }
  const result = await mergeSubintent(req.agent!, params.data.id, body.data.intoId);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Subintent not found.');
      return;
    }
    if (result.reason === 'target_invalid') {
      sendError(
        res,
        409,
        'invalid_value',
        'Merge target must be a different, non-archived subintent in this workspace.',
      );
      return;
    }
    sendError(res, 409, 'not_archivable', 'The "Other" subintent can never be merged.');
    return;
  }
  res.status(200).json(result.subintent);
};
```

- [ ] **Step 5: Wire the router**

```ts
taxonomyRouter.post('/subintents/:id/merge', requireAdminRole, mergeSubintentHandler);
```

- [ ] **Step 6: Register the route in `openapi.ts`**

```ts
registry.registerPath({
  method: 'post',
  path: '/agent/subintents/{id}/merge',
  summary: 'Agent Merge Subintent',
  description:
    'Reassigns every conversation on the loser subintent to the survivor, then archives the loser with mergedIntoId set. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: z.object({ intoId: z.uuid() }) } } },
  },
  responses: {
    200: { description: 'Subintent merged and archived' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Subintent not found' },
    409: { description: 'Invalid merge target, or loser is the "Other" subintent' },
  },
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter backend test -- agent.taxonomy`
Expected: PASS — full file, all `describe` blocks.

- [ ] **Step 8: Run the full backend suite and typecheck**

Run: `pnpm --filter backend test && pnpm typecheck`
Expected: all pass — confirms nothing else (e.g. `fallbackSubintent`'s consumers) regressed.

- [ ] **Step 9: Commit**

```bash
git add backend/src/agent/services/taxonomyService.ts backend/src/agent/controllers/taxonomyController.ts \
  backend/src/agent/routers/taxonomyRouter.ts backend/src/docs/openapi.ts backend/tests/agent.taxonomy.test.ts
git commit -m "feat(taxonomy): add merge endpoint for subintents"
```

---

### Task 6: Frontend API client — `agentApi.ts`

**Files:**

- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`

**Interfaces:**

- Consumes: response/body types from `@support/types` (Task 1) and the six live endpoints (Tasks 2–5).
- Produces: `renameIntent`, `archiveIntent`, `renameSubintent`, `archiveSubintent`, `moveSubintent`, `mergeSubintent` — consumed by Tasks 7 and 8.

- [ ] **Step 1: Add the type imports**

Extend the existing `@support/types` import in `agentApi.ts` with: `ArchiveIntentResponse`, `ArchiveSubintentResponse`, `ConversationPriority`, `MergeSubintentResponse`, `MoveSubintentResponse`, `RenameIntentResponse`, `RenameSubintentResponse`.

- [ ] **Step 2: Add the six functions**

Add directly below the existing `createSubintent` function:

```ts
export function renameIntent(
  token: string,
  id: string,
  name: string,
): Promise<RenameIntentResponse> {
  return apiCall(`/agent/intents/${id}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export function archiveIntent(token: string, id: string): Promise<ArchiveIntentResponse> {
  return apiCall(`/agent/intents/${id}/archive`, token, { method: 'POST' });
}

export function renameSubintent(
  token: string,
  id: string,
  patch: { name?: string; defaultPriority?: ConversationPriority },
): Promise<RenameSubintentResponse> {
  return apiCall(`/agent/subintents/${id}`, token, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function archiveSubintent(token: string, id: string): Promise<ArchiveSubintentResponse> {
  return apiCall(`/agent/subintents/${id}/archive`, token, { method: 'POST' });
}

export function moveSubintent(
  token: string,
  id: string,
  intentId: string,
): Promise<MoveSubintentResponse> {
  return apiCall(`/agent/subintents/${id}/move`, token, {
    method: 'POST',
    body: JSON.stringify({ intentId }),
  });
}

export function mergeSubintent(
  token: string,
  id: string,
  intoId: string,
): Promise<MergeSubintentResponse> {
  return apiCall(`/agent/subintents/${id}/merge`, token, {
    method: 'POST',
    body: JSON.stringify({ intoId }),
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter frontend typecheck`
Expected: no errors.

There is no dedicated test file for `agentApi.ts` — none of the existing wrapper functions (`fetchIntents`, `createIntent`, `archiveForm`, …) have one either; they're exercised indirectly through the components that call them via `vi.spyOn(agentApi, '...')`, which is exactly how Tasks 7 and 8 verify these six.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts
git commit -m "feat(taxonomy): add frontend API client functions for taxonomy admin endpoints"
```

---

### Task 7: `IntentRow.tsx` component

_(Can run in parallel with Task 8 — independent new file, no shared imports between the two.)_

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/Taxonomy/components/IntentRow.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Taxonomy/components/IntentRow.test.tsx`

**Interfaces:**

- Consumes: `renameIntent`, `archiveIntent`, `createSubintent` from `agentApi.ts` (Task 6). `isAdmin`, `StoredAgentSession` from `lib/agentSession.ts`. `IntentView`, `IntentSubintentView` from `@support/types`. `SubintentRow` from Task 8 (`./SubintentRow.tsx`) — **do not implement Task 9 until Task 8 lands**, since this file imports it.
- Produces: `IntentRow` component with props `{ token, session, intent, allIntents, allSubintents }`, consumed by Task 9's `Taxonomy.tsx`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/surfaces/agent-console/pages/Taxonomy/components/IntentRow.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntentRow } from './IntentRow.tsx';
import * as agentApi from '../../../api/agentApi.ts';
import type { StoredAgentSession } from '../../../lib/agentSession.ts';
import type { IntentSubintentView, IntentView } from '@support/types';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const ADMIN_SESSION: StoredAgentSession = {
  token: 't',
  agentId: 'a1',
  displayName: 'A',
  workspaceSlug: 'ws',
  role: 'admin',
};
const AGENT_SESSION: StoredAgentSession = {
  token: 't',
  agentId: 'a1',
  displayName: 'A',
  workspaceSlug: 'ws',
  role: 'agent',
};

const billing: IntentView = {
  id: 'i1',
  name: 'Billing',
  isSystem: false,
  archivedAt: null,
  subintents: [],
};
const other: IntentView = {
  id: 'i2',
  name: 'Other',
  isSystem: true,
  archivedAt: null,
  subintents: [],
};
const allSubintents: (IntentSubintentView & { intentId: string; intentName: string })[] = [];

describe('IntentRow', () => {
  it('shows admin-only controls for an admin and hides them for an agent', async () => {
    const { rerender } = renderWithClient(
      <IntentRow
        token="t"
        session={ADMIN_SESSION}
        intent={billing}
        allIntents={[billing]}
        allSubintents={allSubintents}
      />,
    );
    expect(await screen.findByText('Billing')).toBeInTheDocument();
    expect(screen.getByText('Rename')).toBeInTheDocument();
    expect(screen.getByText('Archive')).toBeInTheDocument();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <IntentRow
          token="t"
          session={AGENT_SESSION}
          intent={billing}
          allIntents={[billing]}
          allSubintents={allSubintents}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByText('Rename')).not.toBeInTheDocument();
    expect(screen.queryByText('Archive')).not.toBeInTheDocument();
  });

  it('disables Archive for the system intent with an explanatory title', () => {
    renderWithClient(
      <IntentRow
        token="t"
        session={ADMIN_SESSION}
        intent={other}
        allIntents={[other]}
        allSubintents={allSubintents}
      />,
    );
    const archiveButton = screen.getByText('Archive');
    expect(archiveButton).toBeDisabled();
    expect(archiveButton.closest('span')).toHaveAttribute(
      'title',
      'The "Other" intent can never be archived.',
    );
  });

  it('calls archiveIntent and invalidates admin-intents on click', async () => {
    const spy = vi
      .spyOn(agentApi, 'archiveIntent')
      .mockResolvedValue({ id: 'i1', name: 'Billing', archivedAt: '2026-01-01T00:00:00Z' });
    renderWithClient(
      <IntentRow
        token="t"
        session={ADMIN_SESSION}
        intent={billing}
        allIntents={[billing]}
        allSubintents={allSubintents}
      />,
    );

    screen.getByText('Archive').click();

    await waitFor(() => expect(spy).toHaveBeenCalledWith('t', 'i1'));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter frontend test -- IntentRow`
Expected: FAIL — `./IntentRow.tsx` does not exist.

- [ ] **Step 3: Implement `IntentRow.tsx`**

```tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { IntentSubintentView, IntentView } from '@support/types';
import { archiveIntent, createSubintent, renameIntent } from '../../../api/agentApi.ts';
import { isAdmin, type StoredAgentSession } from '../../../lib/agentSession.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { Input } from '../../../components/ui/input.tsx';
import { SubintentRow } from './SubintentRow.tsx';

export function IntentRow({
  token,
  session,
  intent,
  allIntents,
  allSubintents,
}: {
  token: string;
  session: StoredAgentSession;
  intent: IntentView;
  allIntents: IntentView[];
  allSubintents: (IntentSubintentView & { intentId: string; intentName: string })[];
}) {
  const queryClient = useQueryClient();
  const admin = isAdmin(session);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(intent.name);
  const [addingSubintent, setAddingSubintent] = useState(false);
  const [newSubintentName, setNewSubintentName] = useState('');

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin-intents'] });

  const rename = useMutation({
    mutationFn: () => renameIntent(token, intent.id, name),
    onSuccess: () => {
      setEditing(false);
      void invalidate();
    },
  });

  const archive = useMutation({
    mutationFn: () => archiveIntent(token, intent.id),
    onSuccess: () => void invalidate(),
  });

  const addSubintent = useMutation({
    mutationFn: () => createSubintent(token, intent.id, newSubintentName),
    onSuccess: () => {
      setNewSubintentName('');
      setAddingSubintent(false);
      void invalidate();
    },
  });

  const hasActiveSubintents = intent.subintents.some((s) => s.archivedAt === null);
  const archiveDisabled = intent.isSystem || hasActiveSubintents;
  // A published-article block is the third condition in the design spec, but
  // detecting it here would mean fetching articles this tree never loads —
  // that case surfaces through archive.error's server message instead.
  const archiveDisabledReason = intent.isSystem
    ? 'The "Other" intent can never be archived.'
    : hasActiveSubintents
      ? 'Archive or move every subintent under this intent first.'
      : undefined;

  return (
    <li className={intent.archivedAt !== null ? 'opacity-60' : undefined}>
      <div className="flex items-center gap-2">
        {editing ? (
          <>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 w-48" />
            <Button
              type="button"
              size="sm"
              onClick={() => rename.mutate()}
              disabled={rename.isPending || !name}
            >
              Save
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <span className="text-sm font-medium">{intent.name}</span>
            {intent.archivedAt !== null && <Badge variant="secondary">Archived</Badge>}
          </>
        )}
        {admin && !editing && intent.archivedAt === null && (
          <div className="ml-auto flex items-center gap-1">
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Rename
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setAddingSubintent(true)}
            >
              + Add subintent
            </Button>
            <span title={archiveDisabledReason}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => archive.mutate()}
                disabled={archiveDisabled || archive.isPending}
              >
                Archive
              </Button>
            </span>
          </div>
        )}
      </div>
      {archive.isError && <p className="pl-0 text-xs text-red-600">{archive.error?.message}</p>}
      {addingSubintent && (
        <div className="mt-1 flex items-center gap-2 pl-3">
          <Input
            placeholder="New subintent name"
            value={newSubintentName}
            onChange={(e) => setNewSubintentName(e.target.value)}
            className="h-8 w-48"
          />
          <Button
            type="button"
            size="sm"
            onClick={() => addSubintent.mutate()}
            disabled={addSubintent.isPending || !newSubintentName}
          >
            Add
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAddingSubintent(false)}
          >
            Cancel
          </Button>
        </div>
      )}
      {intent.subintents.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1 pl-3">
          {intent.subintents.map((subintent) => (
            <SubintentRow
              key={subintent.id}
              token={token}
              session={session}
              subintent={subintent}
              parentIntent={intent}
              allIntents={allIntents}
              allSubintents={allSubintents}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter frontend test -- IntentRow`
Expected: PASS

(This step temporarily requires `SubintentRow.tsx` to exist — if Task 8 hasn't landed yet, create a one-line placeholder `export function SubintentRow() { return null }` in `./SubintentRow.tsx` just to unblock this test, then let Task 8 overwrite it for real. If Task 8 is running in parallel, coordinate so whichever lands second does not clobber the other's file.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Taxonomy/components/IntentRow.tsx \
  frontend/src/surfaces/agent-console/pages/Taxonomy/components/IntentRow.test.tsx
git commit -m "feat(taxonomy): add IntentRow admin component"
```

---

### Task 8: `SubintentRow.tsx` component

_(Can run in parallel with Task 7 — independent new file.)_

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/Taxonomy/components/SubintentRow.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Taxonomy/components/SubintentRow.test.tsx`

**Interfaces:**

- Consumes: `renameSubintent`, `archiveSubintent`, `moveSubintent`, `mergeSubintent` from `agentApi.ts` (Task 6). `isAdmin`, `StoredAgentSession` from `lib/agentSession.ts`. `ConversationPriority`, `IntentSubintentView`, `IntentView` from `@support/types`. `Select`/`SelectTrigger`/`SelectContent`/`SelectItem`/`SelectValue` from `components/ui/select.tsx`.
- Produces: `SubintentRow` component with props `{ token, session, subintent, parentIntent, allIntents, allSubintents }`, consumed by Task 7's `IntentRow.tsx` and Task 9's `Taxonomy.tsx`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/surfaces/agent-console/pages/Taxonomy/components/SubintentRow.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SubintentRow } from './SubintentRow.tsx';
import * as agentApi from '../../../api/agentApi.ts';
import type { StoredAgentSession } from '../../../lib/agentSession.ts';
import type { IntentSubintentView, IntentView } from '@support/types';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const ADMIN_SESSION: StoredAgentSession = {
  token: 't',
  agentId: 'a1',
  displayName: 'A',
  workspaceSlug: 'ws',
  role: 'admin',
};

const billing: IntentView = {
  id: 'i1',
  name: 'Billing',
  isSystem: false,
  archivedAt: null,
  subintents: [],
};
const otherIntent: IntentView = {
  id: 'i2',
  name: 'Other',
  isSystem: true,
  archivedAt: null,
  subintents: [],
};

const refunds: IntentSubintentView = {
  id: 's1',
  name: 'Refunds',
  formId: null,
  archivedAt: null,
  defaultPriority: null,
  mergedIntoId: null,
};
const otherSub: IntentSubintentView = {
  id: 's2',
  name: 'Other',
  formId: null,
  archivedAt: null,
  defaultPriority: null,
  mergedIntoId: null,
};

const allSubintents = [{ ...refunds, intentId: 'i1', intentName: 'Billing' }];

describe('SubintentRow', () => {
  it('renders the name and admin controls', async () => {
    renderWithClient(
      <SubintentRow
        token="t"
        session={ADMIN_SESSION}
        subintent={refunds}
        parentIntent={billing}
        allIntents={[billing]}
        allSubintents={allSubintents}
      />,
    );
    expect(await screen.findByText('Refunds')).toBeInTheDocument();
    expect(screen.getByText('Rename')).toBeInTheDocument();
    expect(screen.getByText('Archive')).toBeInTheDocument();
  });

  it('disables Rename/Archive for the Other subintent with an explanatory title', () => {
    renderWithClient(
      <SubintentRow
        token="t"
        session={ADMIN_SESSION}
        subintent={otherSub}
        parentIntent={otherIntent}
        allIntents={[otherIntent]}
        allSubintents={[]}
      />,
    );
    const renameButton = screen.getByText('Rename');
    const archiveButton = screen.getByText('Archive');
    expect(renameButton).toBeDisabled();
    expect(archiveButton).toBeDisabled();
    expect(archiveButton.closest('span')).toHaveAttribute(
      'title',
      'The "Other" subintent can never be archived, merged, or moved.',
    );
  });

  it('calls archiveSubintent and invalidates admin-intents on click', async () => {
    const spy = vi
      .spyOn(agentApi, 'archiveSubintent')
      .mockResolvedValue({ id: 's1', name: 'Refunds', archivedAt: '2026-01-01T00:00:00Z' });
    renderWithClient(
      <SubintentRow
        token="t"
        session={ADMIN_SESSION}
        subintent={refunds}
        parentIntent={billing}
        allIntents={[billing]}
        allSubintents={allSubintents}
      />,
    );

    screen.getByText('Archive').click();

    await waitFor(() => expect(spy).toHaveBeenCalledWith('t', 's1'));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter frontend test -- SubintentRow`
Expected: FAIL — `./SubintentRow.tsx` does not exist.

- [ ] **Step 3: Implement `SubintentRow.tsx`**

```tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConversationPriority, IntentSubintentView, IntentView } from '@support/types';
import {
  archiveSubintent,
  mergeSubintent,
  moveSubintent,
  renameSubintent,
} from '../../../api/agentApi.ts';
import { isAdmin, type StoredAgentSession } from '../../../lib/agentSession.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { Input } from '../../../components/ui/input.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.tsx';

const PRIORITIES: ConversationPriority[] = ['p1', 'p2', 'p3', 'p4'];
const OTHER_NAME = 'Other';

export function SubintentRow({
  token,
  session,
  subintent,
  parentIntent,
  allIntents,
  allSubintents,
}: {
  token: string;
  session: StoredAgentSession;
  subintent: IntentSubintentView;
  parentIntent: IntentView;
  allIntents: IntentView[];
  allSubintents: (IntentSubintentView & { intentId: string; intentName: string })[];
}) {
  const queryClient = useQueryClient();
  const admin = isAdmin(session);
  // Mirrors backend/src/domain/bot/fallbackSubintent.ts's resolution: the
  // isSystem intent's subintent literally named "Other" — UI-only, the real
  // guard is server-side per the archive/merge/move 409s.
  const isOther = parentIntent.isSystem && subintent.name === OTHER_NAME;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(subintent.name);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin-intents'] });

  const rename = useMutation({
    mutationFn: () => renameSubintent(token, subintent.id, { name }),
    onSuccess: () => {
      setEditing(false);
      void invalidate();
    },
  });

  const setPriority = useMutation({
    mutationFn: (defaultPriority: ConversationPriority) =>
      renameSubintent(token, subintent.id, { defaultPriority }),
    onSuccess: () => void invalidate(),
  });

  const archive = useMutation({
    mutationFn: () => archiveSubintent(token, subintent.id),
    onSuccess: () => void invalidate(),
  });

  const move = useMutation({
    mutationFn: (intentId: string) => moveSubintent(token, subintent.id, intentId),
    onSuccess: () => void invalidate(),
  });

  const merge = useMutation({
    mutationFn: (intoId: string) => mergeSubintent(token, subintent.id, intoId),
    onSuccess: () => void invalidate(),
  });

  const moveTargets = allIntents.filter((i) => i.archivedAt === null && i.id !== parentIntent.id);
  const mergeTargets = allSubintents.filter((s) => s.archivedAt === null && s.id !== subintent.id);
  const disabledTitle = isOther
    ? 'The "Other" subintent can never be archived, merged, or moved.'
    : undefined;

  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {editing ? (
          <>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-7 w-40 text-xs"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => rename.mutate()}
              disabled={rename.isPending || !name}
            >
              Save
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <span className="text-xs">{subintent.name}</span>
            {subintent.archivedAt !== null && <Badge variant="secondary">Archived</Badge>}
          </>
        )}

        {admin && !editing && subintent.archivedAt === null && (
          <div className="ml-auto flex items-center gap-1">
            <Select
              value={subintent.defaultPriority ?? undefined}
              onValueChange={(value) => setPriority.mutate(value as ConversationPriority)}
            >
              <SelectTrigger className="h-7 w-20 text-xs">
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <span title={disabledTitle}>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEditing(true)}
                disabled={isOther}
              >
                Rename
              </Button>
            </span>

            <span title={disabledTitle}>
              <Select disabled={isOther} onValueChange={(intentId) => move.mutate(intentId)}>
                <SelectTrigger className="h-7 w-28 text-xs">
                  <SelectValue placeholder="Move to…" />
                </SelectTrigger>
                <SelectContent>
                  {moveTargets.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>

            <span title={disabledTitle}>
              <Select disabled={isOther} onValueChange={(intoId) => merge.mutate(intoId)}>
                <SelectTrigger className="h-7 w-32 text-xs">
                  <SelectValue placeholder="Merge into…" />
                </SelectTrigger>
                <SelectContent>
                  {mergeTargets.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.intentName} / {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>

            <span title={disabledTitle}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => archive.mutate()}
                disabled={isOther || archive.isPending}
              >
                Archive
              </Button>
            </span>
          </div>
        )}
      </div>
      {(archive.isError || move.isError || merge.isError || rename.isError) && (
        <p className="pl-0 text-xs text-red-600">
          {archive.error?.message ??
            move.error?.message ??
            merge.error?.message ??
            rename.error?.message}
        </p>
      )}
    </li>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter frontend test -- SubintentRow`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Taxonomy/components/SubintentRow.tsx \
  frontend/src/surfaces/agent-console/pages/Taxonomy/components/SubintentRow.test.tsx
git commit -m "feat(taxonomy): add SubintentRow admin component"
```

---

### Task 9: `Taxonomy.tsx` page

_(Depends on Tasks 7 and 8 both being complete — imports both.)_

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/Taxonomy/Taxonomy.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Taxonomy/Taxonomy.test.tsx`

**Interfaces:**

- Consumes: `fetchIntents`, `createIntent` from `agentApi.ts`. `loadAgentSession`, `isAdmin` from `lib/agentSession.ts`. `IntentRow` (Task 7), `SubintentRow` is used transitively by `IntentRow`, not directly here.
- Produces: `Taxonomy` component, the default export consumed by Task 10's route registration.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/surfaces/agent-console/pages/Taxonomy/Taxonomy.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Taxonomy } from './Taxonomy.tsx';
import * as agentApi from '../../api/agentApi.ts';
import * as agentSession from '../../lib/agentSession.ts';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('Taxonomy', () => {
  it('renders the intent tree from GET /agent/intents', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a1',
      displayName: 'A',
      workspaceSlug: 'ws',
      role: 'admin',
    });
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({
      intents: [
        {
          id: 'i1',
          name: 'Billing',
          isSystem: false,
          archivedAt: null,
          subintents: [
            {
              id: 's1',
              name: 'Refunds',
              formId: null,
              archivedAt: null,
              defaultPriority: null,
              mergedIntoId: null,
            },
          ],
        },
      ],
    });

    renderWithClient(<Taxonomy />);

    expect(await screen.findByText('Billing')).toBeInTheDocument();
    expect(await screen.findByText('Refunds')).toBeInTheDocument();
    expect(screen.getByText('+ Add intent')).toBeInTheDocument();
  });

  it('hides "+ Add intent" for a non-admin', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a1',
      displayName: 'A',
      workspaceSlug: 'ws',
      role: 'agent',
    });
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });

    renderWithClient(<Taxonomy />);

    await screen.findByText('Taxonomy');
    expect(screen.queryByText('+ Add intent')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter frontend test -- Taxonomy.test`
Expected: FAIL — `./Taxonomy.tsx` does not exist.

- [ ] **Step 3: Implement `Taxonomy.tsx`**

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createIntent, fetchIntents } from '../../api/agentApi.ts';
import { isAdmin, loadAgentSession } from '../../lib/agentSession.ts';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { ScrollArea } from '../../components/ui/scroll-area.tsx';
import { IntentRow } from './components/IntentRow.tsx';

export function Taxonomy() {
  const session = loadAgentSession();
  const queryClient = useQueryClient();
  const [newIntentName, setNewIntentName] = useState('');

  const intentsQuery = useQuery({
    queryKey: ['admin-intents'],
    queryFn: () => fetchIntents(session!.token),
    enabled: session !== null,
  });

  const addIntent = useMutation({
    mutationFn: () => createIntent(session!.token, newIntentName),
    onSuccess: () => {
      setNewIntentName('');
      void queryClient.invalidateQueries({ queryKey: ['admin-intents'] });
    },
  });

  if (!session) return null;

  const intents = intentsQuery.data?.intents ?? [];
  const allSubintents = intents.flatMap((i) =>
    i.subintents.map((s) => ({ ...s, intentId: i.id, intentName: i.name })),
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Taxonomy</span>
        {isAdmin(session) && (
          <div className="flex items-center gap-2">
            <Input
              placeholder="New intent name"
              value={newIntentName}
              onChange={(e) => setNewIntentName(e.target.value)}
              className="h-8 w-48"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => addIntent.mutate()}
              disabled={addIntent.isPending || !newIntentName}
            >
              + Add intent
            </Button>
          </div>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1 p-3">
        <ul className="flex flex-col gap-4">
          {intents.map((intent) => (
            <IntentRow
              key={intent.id}
              token={session.token}
              session={session}
              intent={intent}
              allIntents={intents}
              allSubintents={allSubintents}
            />
          ))}
        </ul>
      </ScrollArea>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter frontend test -- Taxonomy.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Taxonomy/Taxonomy.tsx \
  frontend/src/surfaces/agent-console/pages/Taxonomy/Taxonomy.test.tsx
git commit -m "feat(taxonomy): add Taxonomy admin page"
```

---

### Task 10: Nav item + route registration

_(Depends on Task 9.)_

**Files:**

- Modify: `frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx`
- Modify: `frontend/src/routes/AppRoutes.tsx`

**Interfaces:**

- Consumes: `Taxonomy` from Task 9.

- [ ] **Step 1: Add the nav item**

In `AgentConsoleShell.tsx`, the taxonomy tab is visible to every role (Agent/Team Lead/Admin — same visibility as Knowledge Base), so it goes in the unconditional `NAV_ITEMS`, not the Forms-style role-gated list. Add `Tags` to the `lucide-react` import and a new entry:

```ts
import { Inbox as InboxIcon, BookOpen, ClipboardList, LogOut, Tags } from 'lucide-react';
```

```ts
const NAV_ITEMS = [
  { to: '/inbox', label: 'Inbox', icon: InboxIcon },
  { to: '/articles', label: 'Knowledge Base', icon: BookOpen },
  { to: '/taxonomy', label: 'Taxonomy', icon: Tags },
];
```

- [ ] **Step 2: Register the route**

In `AppRoutes.tsx`, add a lazy import alongside the existing ones:

```ts
const Taxonomy = lazy(() =>
  import('../surfaces/agent-console/pages/Taxonomy/Taxonomy.tsx').then((m) => ({
    default: m.Taxonomy,
  })),
);
```

(Match the exact lazy-import syntax already used for `Forms`/`KnowledgeBase`/`Inbox` in this file — copy their pattern verbatim rather than guessing the wrapper shape.)

Add the route inside the `AgentConsoleShell` route's children, after `forms/:id`:

```tsx
<Route path="taxonomy" element={<Taxonomy />} />
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Manual verification**

There is no existing test file for `AgentConsoleShell.tsx` or `AppRoutes.tsx` (neither has one today), so verify by hand:

Run: `pnpm dev`, log in as a seeded admin, and confirm:

1. A "Taxonomy" nav item appears between "Knowledge Base" and (if present) "Forms".
2. Clicking it navigates to `/taxonomy` and renders the intent tree from the dev-seeded workspace.
3. As admin: rename an intent, add a subintent, set a subintent's priority, move a subintent, merge two subintents, and archive an intent/subintent — each should refetch and reflect immediately.
4. Confirm the seeded "Other" intent/subintent show all four subintent actions and the intent's Archive disabled, with the tooltip text visible on hover.
5. Log in as a non-admin agent role and confirm the tree is visible but every mutating control is absent.

- [ ] **Step 5: Run the full test suite**

Run: `pnpm test`
Expected: all green, backend + frontend + types.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx frontend/src/routes/AppRoutes.tsx
git commit -m "feat(taxonomy): wire Taxonomy page into admin nav and routes"
```

---

## Self-Review Notes

- **Spec coverage:** all six endpoints (Task 2–5), types (Task 1), tree view/rename/archive/move/merge/add controls with tooltips (Tasks 7–9), nav placement matching "visible to Agent/Team Lead/Admin, mutations Admin-only" (Task 10) are each covered. `CategorySidebar` is untouched by every task above — confirmed no task modifies `KnowledgeBase/components/CategorySidebar.tsx`. Out-of-scope items (form-to-subintent linking, workspace provisioning, bulk import/export) have no task — correctly excluded.
- **"Other" identification:** deliberately reuses `resolveFallbackSubintent` rather than adding a schema column, matching the one existing mechanism in this codebase and avoiding an unnecessary migration.
- **Type consistency:** `IntentView`/`IntentSubintentView` (Task 1) are consumed identically by `taxonomyService.ts` (Tasks 1–5), `agentApi.ts` (Task 6), and both row components (Tasks 7–9) — checked field names (`defaultPriority`, `mergedIntoId`, `isSystem`, `archivedAt`) match across every file.
