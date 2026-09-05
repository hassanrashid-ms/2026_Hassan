# Move Declared Fields to admin-console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the "Declared Fields" feature (promoting raw player-state keys to typed fields) from agent-console (workspace-scoped, `requireAdminRole`) to admin-console (platform-scoped, `requireAdminAccess`), as a third tab on `WorkspaceDetail.tsx` alongside Members and Secret.

**Architecture:** Port the six existing operations (list/create/update/deactivate/reactivate/archive) from `agent/services/declaredFieldService.ts` (RLS-scoped via `withWorkspace`) to a new `admin/services/declaredFieldsService.ts` (bypass-RLS via `adminDb`, explicit `workspaceId` filtering) — exactly the pattern `admin/services/membersService.ts` and `secretService.ts` already use. Frontend gets a new `DeclaredFieldsPanel`/`DeclaredFieldRow` pair under admin-console's `WorkspaceDetail/components/`, built on admin-console's own `Table`/`ConfirmDialog`/toast conventions (matching `MembersTable.tsx`). The old agent-console feature (page, API functions, nav entry, route, backend router/controller/service, integration test) is deleted outright — this is a move, not a duplication.

**Tech Stack:** Express 5, Drizzle ORM, Zod, Vitest + supertest-style `req` helper (backend); React, TanStack Query, Vitest + Testing Library (frontend).

## Global Constraints

- Tailwind v4 utilities only — no hand-written CSS classes (CLAUDE.md § Styling).
- Every scoped table has RLS; `adminDb` bypasses it — every admin-service query must filter by `workspaceId` explicitly, since nothing else will.
- No hard deletes — `declared_field.status` moves through active/inactive/archived, never a row deletion.
- When adding any new API endpoint, register its route and Zod schema in `backend/src/docs/openapi.ts`.
- Surfaces never cross-import (`agent-console` and `admin-console` each own their full stack — components, api, lib).
- Never commit with `Co-Authored-By: Claude` in the message (session convention).

---

## Task 1: Backend — new admin declared-fields service, controller, and routes

**Files:**

- Create: `backend/src/admin/services/declaredFieldsService.ts`
- Create: `backend/src/admin/controllers/declaredFieldsController.ts`
- Modify: `backend/src/admin/routers/workspacesRouter.ts`
- Test: `backend/tests/admin.declaredFields.test.ts`

**Interfaces:**

- Consumes: `adminDb` (`shared/db/adminClient.ts`), `declaredField`/`agent` tables (`shared/db/schema/index.ts`), `appendChangeLog` (`shared/changeLog/appendChangeLog.ts`), `AgentContext` type (`shared/middleware/requireAgentSession.ts`, for `req.agent!.agentId`).
- Produces: `listDeclaredFields(workspaceId)`, `createDeclaredField(workspaceId, actorId, input)`, `updateDeclaredField(workspaceId, id, patch)`, `deactivateDeclaredField(workspaceId, id, actorId)`, `reactivateDeclaredField(workspaceId, id, actorId)`, `archiveDeclaredField(workspaceId, id, actorId)` — all exported from `declaredFieldsService.ts`, consumed by `declaredFieldsController.ts`, and by nothing else (no other task calls these directly). Routes: `GET/POST /workspaces/:id/declared-fields`, `PATCH/POST /workspaces/:id/declared-fields/:fieldId[/deactivate|/reactivate|/archive]`, mounted under `/admin` (full path e.g. `/admin/workspaces/:id/declared-fields`).

- [ ] **Step 1: Write the failing integration test**

Create `backend/tests/admin.declaredFields.test.ts`:

```typescript
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { adminRouter } from '../src/admin/router.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeOwnerPool, ownerPool, seedAgent, seedWorkspace, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function adminToken(): Promise<{ agentId: string; token: string }> {
  const agentId = await seedAgent(undefined, { isAdmin: true });
  const token = await signAgentSession({ agent_id: agentId, is_admin: true });
  return { agentId, token };
}

async function promote(
  workspaceId: string,
  token: string,
  overrides: Partial<{ key: string; label: string; type: string }> = {},
) {
  const res = await request(app)
    .post(`/admin/workspaces/${workspaceId}/declared-fields`)
    .set('Authorization', `Bearer ${token}`)
    .send({ key: 'vip_status', label: 'VIP status', type: 'string', ...overrides })
    .expect(201);
  return res.body as { id: string; key: string; status: string };
}

describe('GET /admin/workspaces/:id/declared-fields', () => {
  it('returns active and inactive fields, but never archived, ordered by key', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();

    const active = await promote(workspaceId, token, { key: 'ab_bucket', label: 'AB bucket' });
    const inactive = await promote(workspaceId, token, { key: 'vip_status' });
    const archived = await promote(workspaceId, token, { key: 'zz_key', label: 'ZZ' });

    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${inactive.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${archived.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const res = await request(app)
      .get(`/admin/workspaces/${workspaceId}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.fields.map((f: { key: string; status: string }) => [f.key, f.status])).toEqual([
      ['ab_bucket', 'active'],
      ['vip_status', 'inactive'],
    ]);
    expect(active.key).toBe('ab_bucket');
  });

  it('only returns fields for the requested workspace', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const { token } = await adminToken();

    await promote(workspaceA, token, { key: 'a_only' });

    const res = await request(app)
      .get(`/admin/workspaces/${workspaceB}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.fields).toEqual([]);
  });

  it('forbids a non-admin agent', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent(undefined, { isAdmin: false });
    const token = await signAgentSession({ agent_id: agentId, is_admin: false });

    await request(app)
      .get(`/admin/workspaces/${workspaceId}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});

describe('POST /admin/workspaces/:id/declared-fields', () => {
  it('promotes a new key as active, stamping the admin as declaredBy', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await adminToken();

    const res = await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'vip_status', label: 'VIP status', type: 'string' })
      .expect(201);

    expect(res.body).toMatchObject({
      key: 'vip_status',
      label: 'VIP status',
      type: 'string',
      status: 'active',
      declaredBy: agentId,
    });
  });

  it('rejects an invalid key', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();

    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'VIP Status!', label: 'VIP status', type: 'string' })
      .expect(422);
  });

  it('409s on a duplicate active key', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();

    await promote(workspaceId, token);

    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'vip_status', label: 'Different label', type: 'string' })
      .expect(409);
  });

  it('revives an archived key instead of erroring', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();

    const first = await promote(workspaceId, token);
    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${first.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const revived = await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'vip_status', label: 'VIP status v2', type: 'number' })
      .expect(201);

    expect(revived.body).toMatchObject({ id: first.id, status: 'active' });
  });
});

describe('PATCH /admin/workspaces/:id/declared-fields/:fieldId', () => {
  it('updates label and type, ignoring any key in the body', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();
    const created = await promote(workspaceId, token);

    const res = await request(app)
      .patch(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'VIP tier', type: 'number', key: 'ignored_key' })
      .expect(200);

    expect(res.body).toMatchObject({ key: 'vip_status', label: 'VIP tier', type: 'number' });
  });

  it('404s on an archived field', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();
    const created = await promote(workspaceId, token);
    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app)
      .patch(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'VIP tier' })
      .expect(404);
  });

  it('rejects a type change on a seeded field (no declaredBy), but allows the label', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();

    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into declared_field (workspace_id, key, label, type, status)
       values ($1, 'player_level', 'Player level', 'number', 'active')
       returning id`,
      [workspaceId],
    );
    const seededId = rows[0]!.id;

    await request(app)
      .patch(`/admin/workspaces/${workspaceId}/declared-fields/${seededId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'string' })
      .expect(409);

    const res = await request(app)
      .patch(`/admin/workspaces/${workspaceId}/declared-fields/${seededId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'Player Level (v2)' })
      .expect(200);

    expect(res.body).toMatchObject({
      key: 'player_level',
      label: 'Player Level (v2)',
      type: 'number',
    });
  });

  it('writes a change_log row per changed field, attributed to the admin', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await adminToken();
    const created = await promote(workspaceId, token);

    await request(app)
      .patch(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'VIP tier' })
      .expect(200);

    const { rows } = await ownerPool.query<{ field: string; actor_id: string }>(
      `select field, actor_id from change_log
        where entity_type = 'declared_field' and entity_id = $1 order by field`,
      [created.id],
    );
    expect(rows).toEqual([{ field: 'label', actor_id: agentId }]);
  });

  it('404s on an unknown id', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();

    await request(app)
      .patch(
        `/admin/workspaces/${workspaceId}/declared-fields/00000000-0000-0000-0000-000000000000`,
      )
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'VIP tier' })
      .expect(404);
  });
});

describe('POST /admin/workspaces/:id/declared-fields/:fieldId/deactivate', () => {
  it('moves an active field to inactive and keeps it in the list', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();
    const created = await promote(workspaceId, token);

    const res = await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({ id: created.id, key: 'vip_status', status: 'inactive' });
  });

  it('404s deactivating an already-inactive field', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();
    const created = await promote(workspaceId, token);
    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});

describe('POST /admin/workspaces/:id/declared-fields/:fieldId/reactivate', () => {
  it('moves an inactive field back to active', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();
    const created = await promote(workspaceId, token);
    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const res = await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({ id: created.id, key: 'vip_status', status: 'active' });
  });

  it('404s reactivating an archived field — re-promoting is the only way back', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();
    const created = await promote(workspaceId, token);
    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});

describe('POST /admin/workspaces/:id/declared-fields/:fieldId/archive', () => {
  it('archives the field and excludes it from later listings', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();
    const created = await promote(workspaceId, token);

    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const list = await request(app)
      .get(`/admin/workspaces/${workspaceId}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.fields).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx vitest run tests/admin.declaredFields.test.ts`
Expected: FAIL — `/admin/workspaces/:id/declared-fields` doesn't exist yet (404s from every request, or a `Cannot find module` if adminRouter doesn't yet reference the new controller).

- [ ] **Step 3: Implement the service**

Create `backend/src/admin/services/declaredFieldsService.ts`:

```typescript
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type {
  ArchiveDeclaredFieldResponse,
  CreateDeclaredFieldResponse,
  DeactivateDeclaredFieldResponse,
  DeclaredFieldsResponse,
  DeclaredFieldType,
  ReactivateDeclaredFieldResponse,
  UpdateDeclaredFieldResponse,
} from '@support/types';
import { adminDb } from '../../shared/db/adminClient.ts';
import { agent, declaredField } from '../../shared/db/schema/index.ts';
import { appendChangeLog } from '../../shared/changeLog/appendChangeLog.ts';

const RETURNING = {
  id: declaredField.id,
  key: declaredField.key,
  label: declaredField.label,
  type: declaredField.type,
  status: declaredField.status,
  declaredAt: declaredField.declaredAt,
  declaredBy: declaredField.declaredBy,
};

/** Shapes a RETURNING row (declaredAt still a Date) into the wire view. */
function toDeclaredFieldView(row: {
  id: string;
  key: string;
  label: string;
  type: DeclaredFieldType;
  status: 'active' | 'inactive' | 'archived';
  declaredAt: Date;
  declaredBy: string | null;
}) {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type,
    status: row.status,
    declaredAt: row.declaredAt.toISOString(),
    declaredBy: row.declaredBy,
    declaredByName: null,
  };
}

export async function listDeclaredFields(workspaceId: string): Promise<DeclaredFieldsResponse> {
  const rows = await adminDb
    .select({
      id: declaredField.id,
      key: declaredField.key,
      label: declaredField.label,
      type: declaredField.type,
      status: declaredField.status,
      declaredAt: declaredField.declaredAt,
      declaredBy: declaredField.declaredBy,
      declaredByName: agent.displayName,
    })
    .from(declaredField)
    .leftJoin(agent, eq(agent.id, declaredField.declaredBy))
    .where(and(eq(declaredField.workspaceId, workspaceId), ne(declaredField.status, 'archived')))
    // Inactive fields sort to the end instead of interleaving with active
    // ones by key — they're paused, not something an admin is scanning for.
    .orderBy(
      sql`case when ${declaredField.status} = 'inactive' then 1 else 0 end`,
      asc(declaredField.key),
    );

  return {
    fields: rows.map((row) => ({
      id: row.id,
      key: row.key,
      label: row.label,
      type: row.type,
      status: row.status,
      declaredAt: row.declaredAt.toISOString(),
      declaredBy: row.declaredBy,
      declaredByName: row.declaredByName,
    })),
  };
}

export type CreateDeclaredFieldResult =
  { ok: true; field: CreateDeclaredFieldResponse } | { ok: false; reason: 'key_taken' };

/**
 * Re-promoting a key that is currently `inactive` or `archived` revives the
 * existing row instead of inserting a duplicate (would hit
 * `declared_field_workspace_key_uk`). Only a currently-`active` row blocks
 * with a conflict. Same semantics as the agent-console version this replaces.
 */
export async function createDeclaredField(
  workspaceId: string,
  actorId: string,
  input: { key: string; label: string; type: DeclaredFieldType },
): Promise<CreateDeclaredFieldResult> {
  const [existing] = await adminDb
    .select({ id: declaredField.id, status: declaredField.status })
    .from(declaredField)
    .where(and(eq(declaredField.workspaceId, workspaceId), eq(declaredField.key, input.key)))
    .limit(1);

  if (existing?.status === 'active') return { ok: false, reason: 'key_taken' };

  const values = {
    workspaceId,
    key: input.key,
    label: input.label,
    type: input.type,
    status: 'active' as const,
    declaredAt: new Date(),
    declaredBy: actorId,
  };

  const [row] = existing
    ? await adminDb
        .update(declaredField)
        .set(values)
        .where(eq(declaredField.id, existing.id))
        .returning(RETURNING)
    : await adminDb.insert(declaredField).values(values).returning(RETURNING);

  return { ok: true, field: toDeclaredFieldView(row!) };
}

export type UpdateDeclaredFieldResult =
  | { ok: true; field: UpdateDeclaredFieldResponse }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'seeded_type_locked' };

/**
 * A row with no `declaredBy` is one of the seeded fields — its `type` is
 * locked (see agent-console's original service for why: historical snapshots
 * look the type up live from this table on every render). `label` stays
 * editable on every row, seeded or not.
 */
export async function updateDeclaredField(
  workspaceId: string,
  id: string,
  actorId: string,
  patch: { label?: string; type?: DeclaredFieldType },
): Promise<UpdateDeclaredFieldResult> {
  const [current] = await adminDb
    .select({
      id: declaredField.id,
      label: declaredField.label,
      type: declaredField.type,
      declaredBy: declaredField.declaredBy,
    })
    .from(declaredField)
    .where(
      and(
        eq(declaredField.id, id),
        eq(declaredField.workspaceId, workspaceId),
        ne(declaredField.status, 'archived'),
      ),
    )
    .limit(1);
  if (!current) return { ok: false, reason: 'not_found' };

  if (patch.type !== undefined && current.declaredBy === null) {
    return { ok: false, reason: 'seeded_type_locked' };
  }

  const changes: { field: string; before: unknown; after: unknown }[] = [];
  if (patch.label !== undefined)
    changes.push({ field: 'label', before: current.label, after: patch.label });
  if (patch.type !== undefined)
    changes.push({ field: 'type', before: current.type, after: patch.type });

  const field = await adminDb.transaction(async (tx) => {
    const [row] = await tx
      .update(declaredField)
      .set({
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
      })
      .where(eq(declaredField.id, id))
      .returning(RETURNING);

    await appendChangeLog(tx, {
      workspaceId,
      entityType: 'declared_field',
      entityId: id,
      actorId,
      changes,
    });

    return row!;
  });

  return { ok: true, field: toDeclaredFieldView(field) };
}

export type DeactivateDeclaredFieldResult =
  { ok: true; field: DeactivateDeclaredFieldResponse } | { ok: false; reason: 'not_found' };

export async function deactivateDeclaredField(
  workspaceId: string,
  id: string,
  actorId: string,
): Promise<DeactivateDeclaredFieldResult> {
  const [current] = await adminDb
    .select({ id: declaredField.id, key: declaredField.key })
    .from(declaredField)
    .where(
      and(
        eq(declaredField.id, id),
        eq(declaredField.workspaceId, workspaceId),
        eq(declaredField.status, 'active'),
      ),
    )
    .limit(1);
  if (!current) return { ok: false, reason: 'not_found' };

  await adminDb.transaction(async (tx) => {
    await tx.update(declaredField).set({ status: 'inactive' }).where(eq(declaredField.id, id));
    await appendChangeLog(tx, {
      workspaceId,
      entityType: 'declared_field',
      entityId: id,
      actorId,
      changes: [{ field: 'status', before: 'active', after: 'inactive' }],
    });
  });

  return { ok: true, field: { id: current.id, key: current.key, status: 'inactive' } };
}

export type ReactivateDeclaredFieldResult =
  { ok: true; field: ReactivateDeclaredFieldResponse } | { ok: false; reason: 'not_found' };

export async function reactivateDeclaredField(
  workspaceId: string,
  id: string,
  actorId: string,
): Promise<ReactivateDeclaredFieldResult> {
  const [current] = await adminDb
    .select({ id: declaredField.id, key: declaredField.key })
    .from(declaredField)
    .where(
      and(
        eq(declaredField.id, id),
        eq(declaredField.workspaceId, workspaceId),
        eq(declaredField.status, 'inactive'),
      ),
    )
    .limit(1);
  if (!current) return { ok: false, reason: 'not_found' };

  await adminDb.transaction(async (tx) => {
    await tx.update(declaredField).set({ status: 'active' }).where(eq(declaredField.id, id));
    await appendChangeLog(tx, {
      workspaceId,
      entityType: 'declared_field',
      entityId: id,
      actorId,
      changes: [{ field: 'status', before: 'inactive', after: 'active' }],
    });
  });

  return { ok: true, field: { id: current.id, key: current.key, status: 'active' } };
}

export type ArchiveDeclaredFieldResult =
  { ok: true; field: ArchiveDeclaredFieldResponse } | { ok: false; reason: 'not_found' };

export async function archiveDeclaredField(
  workspaceId: string,
  id: string,
  actorId: string,
): Promise<ArchiveDeclaredFieldResult> {
  const [current] = await adminDb
    .select({ id: declaredField.id, key: declaredField.key, status: declaredField.status })
    .from(declaredField)
    .where(
      and(
        eq(declaredField.id, id),
        eq(declaredField.workspaceId, workspaceId),
        ne(declaredField.status, 'archived'),
      ),
    )
    .limit(1);
  if (!current) return { ok: false, reason: 'not_found' };

  await adminDb.transaction(async (tx) => {
    await tx.update(declaredField).set({ status: 'archived' }).where(eq(declaredField.id, id));
    await appendChangeLog(tx, {
      workspaceId,
      entityType: 'declared_field',
      entityId: id,
      actorId,
      changes: [{ field: 'status', before: current.status, after: 'archived' }],
    });
  });

  return { ok: true, field: { id: current.id, key: current.key, status: 'archived' } };
}
```

- [ ] **Step 4: Implement the controller**

Create `backend/src/admin/controllers/declaredFieldsController.ts`:

```typescript
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { CreateDeclaredFieldBody, UpdateDeclaredFieldBody } from '@support/types';
import { sendError } from '../../errors.ts';
import {
  archiveDeclaredField,
  createDeclaredField,
  deactivateDeclaredField,
  listDeclaredFields,
  reactivateDeclaredField,
  updateDeclaredField,
} from '../services/declaredFieldsService.ts';

const DeclaredFieldParams = z.object({ id: z.uuid(), fieldId: z.uuid() });

export const listDeclaredFieldsHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await listDeclaredFields(req.params.id as string));
};

export const createDeclaredFieldHandler: RequestHandler = async (req, res) => {
  const body = CreateDeclaredFieldBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'key, label and a valid type are required.');
    return;
  }
  const result = await createDeclaredField(req.params.id as string, req.agent!.agentId, body.data);
  if (!result.ok) {
    sendError(res, 409, 'key_taken', 'A declared field with this key already exists.');
    return;
  }
  res.status(201).json(result.field);
};

export const updateDeclaredFieldHandler: RequestHandler = async (req, res) => {
  const params = DeclaredFieldParams.safeParse(req.params);
  const body = UpdateDeclaredFieldBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'A valid id and at least one of label/type are required.',
    );
    return;
  }
  const result = await updateDeclaredField(
    params.data.id,
    params.data.fieldId,
    req.agent!.agentId,
    body.data,
  );
  if (!result.ok) {
    if (result.reason === 'seeded_type_locked') {
      sendError(
        res,
        409,
        'seeded_field_locked',
        'This field is built in — only its label can be changed.',
      );
      return;
    }
    sendError(res, 404, 'not_found', 'Declared field not found.');
    return;
  }
  res.status(200).json(result.field);
};

export const deactivateDeclaredFieldHandler: RequestHandler = async (req, res) => {
  const params = DeclaredFieldParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid id is required.');
    return;
  }
  const result = await deactivateDeclaredField(
    params.data.id,
    params.data.fieldId,
    req.agent!.agentId,
  );
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Declared field not found or not currently active.');
    return;
  }
  res.status(200).json(result.field);
};

export const reactivateDeclaredFieldHandler: RequestHandler = async (req, res) => {
  const params = DeclaredFieldParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid id is required.');
    return;
  }
  const result = await reactivateDeclaredField(
    params.data.id,
    params.data.fieldId,
    req.agent!.agentId,
  );
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Declared field not found or not currently inactive.');
    return;
  }
  res.status(200).json(result.field);
};

export const archiveDeclaredFieldHandler: RequestHandler = async (req, res) => {
  const params = DeclaredFieldParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid id is required.');
    return;
  }
  const result = await archiveDeclaredField(
    params.data.id,
    params.data.fieldId,
    req.agent!.agentId,
  );
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Declared field not found.');
    return;
  }
  res.status(200).json(result.field);
};
```

Note: `DeclaredFieldParams` validates both `id` (workspace id) and `fieldId`; `listDeclaredFieldsHandler`/`createDeclaredFieldHandler` only need `id` off `req.params` directly since their routes carry no `fieldId`.

- [ ] **Step 5: Wire the routes into `workspacesRouter.ts`**

Modify `backend/src/admin/routers/workspacesRouter.ts` — add the import and the six routes, following the existing members/secret pattern:

```typescript
import { Router } from 'express';
import {
  createWorkspaceHandler,
  listWorkspacesHandler,
  renameWorkspaceHandler,
} from '../controllers/workspacesController.ts';
import {
  addMemberHandler,
  listMembersHandler,
  updateMemberHandler,
} from '../controllers/membersController.ts';
import { getSecretHandler, rotateSecretHandler } from '../controllers/secretController.ts';
import {
  archiveDeclaredFieldHandler,
  createDeclaredFieldHandler,
  deactivateDeclaredFieldHandler,
  listDeclaredFieldsHandler,
  reactivateDeclaredFieldHandler,
  updateDeclaredFieldHandler,
} from '../controllers/declaredFieldsController.ts';

export const workspacesRouter = Router();
workspacesRouter.get('/workspaces', listWorkspacesHandler);
workspacesRouter.post('/workspaces', createWorkspaceHandler);
workspacesRouter.patch('/workspaces/:id', renameWorkspaceHandler);

workspacesRouter.get('/workspaces/:id/members', listMembersHandler);
workspacesRouter.post('/workspaces/:id/members', addMemberHandler);
workspacesRouter.patch('/workspaces/:id/members/:agentId', updateMemberHandler);

workspacesRouter.get('/workspaces/:id/secret', getSecretHandler);
workspacesRouter.post('/workspaces/:id/secret/rotate', rotateSecretHandler);

workspacesRouter.get('/workspaces/:id/declared-fields', listDeclaredFieldsHandler);
workspacesRouter.post('/workspaces/:id/declared-fields', createDeclaredFieldHandler);
workspacesRouter.patch('/workspaces/:id/declared-fields/:fieldId', updateDeclaredFieldHandler);
workspacesRouter.post(
  '/workspaces/:id/declared-fields/:fieldId/deactivate',
  deactivateDeclaredFieldHandler,
);
workspacesRouter.post(
  '/workspaces/:id/declared-fields/:fieldId/reactivate',
  reactivateDeclaredFieldHandler,
);
workspacesRouter.post(
  '/workspaces/:id/declared-fields/:fieldId/archive',
  archiveDeclaredFieldHandler,
);
```

No per-route admin check needed — `admin/router.ts` already gates the entire router with `requireAgentSession` + `requireAdminAccess` before `workspacesRouter` is reached.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && npx vitest run tests/admin.declaredFields.test.ts`
Expected: PASS — all describe blocks green.

- [ ] **Step 7: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors. (Confirms `adminDb.transaction`'s tx type satisfies `appendChangeLog`'s `Tx` parameter — both `db` and `adminDb` are `drizzle(pool, { schema })` against the same `schema` module, so this is structural, not a cast.)

- [ ] **Step 8: Commit**

```bash
git add backend/src/admin/services/declaredFieldsService.ts \
  backend/src/admin/controllers/declaredFieldsController.ts \
  backend/src/admin/routers/workspacesRouter.ts \
  backend/tests/admin.declaredFields.test.ts
git commit -m "Add admin-console declared-fields service, controller, and routes"
```

---

## Task 2: Backend — remove the old agent-console declared-fields code

**Files:**

- Delete: `backend/src/agent/routers/declaredFieldRouter.ts`
- Delete: `backend/src/agent/controllers/declaredFieldController.ts`
- Delete: `backend/src/agent/services/declaredFieldService.ts`
- Delete: `backend/tests/agent.declaredFields.test.ts`
- Modify: `backend/src/agent/router.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: nothing — this is pure removal. No other backend file imports from the three deleted files (confirmed: only `agent/router.ts` mounts `declaredFieldRouter`, and only the deleted test imports the router directly).

- [ ] **Step 1: Delete the four files**

```bash
git rm backend/src/agent/routers/declaredFieldRouter.ts \
  backend/src/agent/controllers/declaredFieldController.ts \
  backend/src/agent/services/declaredFieldService.ts \
  backend/tests/agent.declaredFields.test.ts
```

- [ ] **Step 2: Remove the mount from `agent/router.ts`**

Modify `backend/src/agent/router.ts` — remove the import and the `.use()` line:

```typescript
import { Router } from 'express';
import { requireAgentSession } from '../shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../shared/middleware/resolveConsoleWorkspace.ts';
import { authRouter } from './routers/authRouter.ts';
import { conversationsRouter } from './routers/conversationsRouter.ts';
import { messagesRouter } from './routers/messagesRouter.ts';
import { taxonomyRouter } from './routers/taxonomyRouter.ts';
import { tagsRouter } from './routers/tagsRouter.ts';
import { articlesRouter } from './routers/articlesRouter.ts';
import { botConfigRouter } from './routers/botConfigRouter.ts';
import { workspaceSettingsRouter } from './routers/workspaceSettingsRouter.ts';
import { formsRouter } from './routers/formsRouter.ts';
import { agentsRouter } from './routers/agentsRouter.ts';
import { presenceRouter } from './routers/presenceRouter.ts';
import { membershipsRouter } from './routers/membershipsRouter.ts';
import { globalInboxRouter } from './routers/globalInboxRouter.ts';
import { uploadsRouter } from './routers/uploadsRouter.ts';

export const agentRouter = Router();

// Public: this IS the login flow, so it cannot require the session it mints.
agentRouter.use(authRouter);

agentRouter.use(requireAgentSession);
agentRouter.use(membershipsRouter);
agentRouter.use(globalInboxRouter);
agentRouter.use(resolveConsoleWorkspace);
agentRouter.use(taxonomyRouter);
agentRouter.use(tagsRouter);
agentRouter.use(articlesRouter);
agentRouter.use(botConfigRouter);
agentRouter.use(workspaceSettingsRouter);
agentRouter.use(formsRouter);
agentRouter.use(conversationsRouter);
agentRouter.use(messagesRouter);
agentRouter.use(uploadsRouter);
agentRouter.use(agentsRouter);
agentRouter.use(presenceRouter);
```

(Only the `declaredFieldRouter` import and its `.use()` line are removed; every other line is unchanged.)

- [ ] **Step 3: Run the full backend test suite**

Run: `cd backend && npx vitest run`
Expected: PASS — no test references the deleted files anymore (confirmed in file list above), and `admin.declaredFields.test.ts` from Task 1 covers the moved functionality.

- [ ] **Step 4: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors — no remaining import of the deleted files.

- [ ] **Step 5: Commit**

```bash
git add -A backend/src/agent/routers/declaredFieldRouter.ts \
  backend/src/agent/controllers/declaredFieldController.ts \
  backend/src/agent/services/declaredFieldService.ts \
  backend/tests/agent.declaredFields.test.ts \
  backend/src/agent/router.ts
git commit -m "Remove agent-console declared-fields backend code"
```

---

## Task 3: Backend — update OpenAPI docs

**Files:**

- Modify: `backend/src/docs/openapi.ts`

**Interfaces:**

- Consumes: `bearerAgentSession` (already imported/used elsewhere in this file for other `/admin/*` entries — same import used by the members/secret blocks).
- Produces: nothing consumed by other tasks — this is documentation only.

- [ ] **Step 1: Remove the six `/agent/declared-fields...` entries**

In `backend/src/docs/openapi.ts`, delete the six `registry.registerPath({...})` blocks whose `path` starts with `/agent/declared-fields` (summaries: "Agent List Declared Fields", "Agent Promote Declared Field", "Agent Update Declared Field", "Agent Deactivate Declared Field", "Agent Reactivate Declared Field", "Agent Archive Declared Field").

- [ ] **Step 2: Add six `/admin/workspaces/{id}/declared-fields...` entries**

Add these `registry.registerPath({...})` blocks near the existing `/admin/workspaces/{id}/members` and `/admin/workspaces/{id}/secret` entries, following their exact style (`security: [{ [bearerAgentSession.name]: [] }]`, `params` including `id`):

```typescript
registry.registerPath({
  method: 'get',
  path: '/admin/workspaces/{id}/declared-fields',
  summary: 'List Declared Fields',
  description:
    'Lists active and inactive declared fields for the workspace (archived rows are hidden).',
  security: [{ [bearerAgentSession.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Declared fields' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/admin/workspaces/{id}/declared-fields',
  summary: 'Promote Declared Field',
  description:
    'Promotes a key to declared, or revives a previously inactive/archived one with the same key.',
  security: [{ [bearerAgentSession.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            key: z.string().min(1).max(64),
            label: z.string().min(1).max(120),
            type: z.enum(['string', 'number', 'boolean', 'timestamp']),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: 'Declared field created or revived' },
    409: { description: 'Key already actively declared' },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/admin/workspaces/{id}/declared-fields/{fieldId}',
  summary: 'Update Declared Field',
  description:
    'Edits the label and/or type of an active or inactive declared field. The key is immutable.',
  security: [{ [bearerAgentSession.name]: [] }],
  request: {
    params: z.object({ id: z.uuid(), fieldId: z.uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            label: z.string().min(1).max(120).optional(),
            type: z.enum(['string', 'number', 'boolean', 'timestamp']).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Declared field updated' },
    404: { description: 'Not found, or archived' },
    409: { description: 'Type change rejected — field is seeded' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/admin/workspaces/{id}/declared-fields/{fieldId}/deactivate',
  summary: 'Deactivate Declared Field',
  description: 'Pauses an active declared field: excluded from future splits, but stays visible.',
  security: [{ [bearerAgentSession.name]: [] }],
  request: { params: z.object({ id: z.uuid(), fieldId: z.uuid() }) },
  responses: {
    200: { description: 'Declared field deactivated' },
    404: { description: 'Not found, or not currently active' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/admin/workspaces/{id}/declared-fields/{fieldId}/reactivate',
  summary: 'Reactivate Declared Field',
  description: 'Resumes an inactive declared field.',
  security: [{ [bearerAgentSession.name]: [] }],
  request: { params: z.object({ id: z.uuid(), fieldId: z.uuid() }) },
  responses: {
    200: { description: 'Declared field reactivated' },
    404: { description: 'Not found, or not currently inactive' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/admin/workspaces/{id}/declared-fields/{fieldId}/archive',
  summary: 'Archive Declared Field',
  description:
    'Soft-removes a declared field, hiding it from the list. Future snapshots for this key fall back into raw.',
  security: [{ [bearerAgentSession.name]: [] }],
  request: { params: z.object({ id: z.uuid(), fieldId: z.uuid() }) },
  responses: {
    200: { description: 'Declared field archived' },
    404: { description: 'Not found, or already archived' },
  },
});
```

- [ ] **Step 3: Verify the OpenAPI doc still generates**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

Run: `pnpm dev` (or start just the backend), then check `http://localhost:4000/docs/json` returns valid JSON containing `/admin/workspaces/{id}/declared-fields` and no longer `/agent/declared-fields`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/docs/openapi.ts
git commit -m "Move declared-fields OpenAPI entries from agent to admin routes"
```

---

## Task 4: Frontend — admin-console API functions and `DeclaredFieldRow`

**Files:**

- Modify: `frontend/src/surfaces/admin-console/api/adminApi.ts`
- Create: `frontend/src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldRow.tsx`
- Test: `frontend/src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldRow.test.tsx`

**Interfaces:**

- Consumes: `DeclaredFieldView`, `DeclaredFieldType` (`@support/types`), `TableRow`/`TableCell` (`../../../components/ui/table.tsx`), `Badge`/`Button`/`Input`/`Select*` (`../../../components/ui/*`), `ConfirmDialog` (`../../../components/ConfirmDialog.tsx`), `ApiError` (`../../../../../lib/httpClient.ts`).
- Produces: `updateDeclaredField(token, workspaceId, id, patch)`, `deactivateDeclaredField(token, workspaceId, id)`, `reactivateDeclaredField(token, workspaceId, id)`, `archiveDeclaredField(token, workspaceId, id)` from `adminApi.ts` — consumed by both this task's `DeclaredFieldRow` and Task 5's `DeclaredFieldsPanel` (which also needs `fetchDeclaredFields`/`createDeclaredField`, added here too). `DeclaredFieldRow` component: `<DeclaredFieldRow token={string} workspaceId={string} field={DeclaredFieldView} />`, consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldRow.test.tsx`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DeclaredFieldView } from '@support/types';
import { DeclaredFieldRow } from './DeclaredFieldRow.tsx';
import * as adminApi from '../../../api/adminApi.ts';
import { Table, TableBody } from '../../../components/ui/table.tsx';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Table>
        <TableBody>{ui}</TableBody>
      </Table>
    </QueryClientProvider>,
  );
}

const activeField: DeclaredFieldView = {
  id: 'f1',
  key: 'vip_status',
  label: 'VIP status',
  type: 'string',
  status: 'active',
  declaredAt: '2026-01-01T00:00:00Z',
  declaredBy: 'a1',
  declaredByName: 'Ada Admin',
};

const inactiveField: DeclaredFieldView = { ...activeField, status: 'inactive' };

const seededField: DeclaredFieldView = {
  id: 'f2',
  key: 'player_level',
  label: 'Player level',
  type: 'number',
  status: 'active',
  declaredAt: '2026-01-01T00:00:00Z',
  declaredBy: null,
  declaredByName: null,
};

describe('DeclaredFieldRow', () => {
  it('shows the key, label, type, status and declared-by', () => {
    renderWithClient(<DeclaredFieldRow token="t" workspaceId="w1" field={activeField} />);

    expect(screen.getByText('vip_status')).toBeInTheDocument();
    expect(screen.getByText('VIP status')).toBeInTheDocument();
    expect(screen.getByText('string')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText(/Ada Admin/)).toBeInTheDocument();
  });

  it('shows Deactivate for an active field and Reactivate for an inactive one', () => {
    const { rerender } = renderWithClient(
      <DeclaredFieldRow token="t" workspaceId="w1" field={activeField} />,
    );
    expect(screen.getByText('Deactivate')).toBeInTheDocument();
    expect(screen.queryByText('Reactivate')).not.toBeInTheDocument();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <Table>
          <TableBody>
            <DeclaredFieldRow token="t" workspaceId="w1" field={inactiveField} />
          </TableBody>
        </Table>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Reactivate')).toBeInTheDocument();
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
  });

  it('deactivates after confirming, and calls the API with the workspace and field id', async () => {
    const spy = vi
      .spyOn(adminApi, 'deactivateDeclaredField')
      .mockResolvedValue({ id: 'f1', key: 'vip_status', status: 'inactive' });
    renderWithClient(<DeclaredFieldRow token="t" workspaceId="w1" field={activeField} />);

    const user = userEvent.setup();
    await user.click(screen.getByText('Deactivate'));
    await user.click((await screen.findAllByText('Deactivate')).at(-1)!);

    await waitFor(() => expect(spy).toHaveBeenCalledWith('t', 'w1', 'f1'));
  });

  it('reactivates after confirming, and calls the API with the workspace and field id', async () => {
    const spy = vi
      .spyOn(adminApi, 'reactivateDeclaredField')
      .mockResolvedValue({ id: 'f1', key: 'vip_status', status: 'active' });
    renderWithClient(<DeclaredFieldRow token="t" workspaceId="w1" field={inactiveField} />);

    const user = userEvent.setup();
    await user.click(screen.getByText('Reactivate'));
    await user.click((await screen.findAllByText('Reactivate')).at(-1)!);

    await waitFor(() => expect(spy).toHaveBeenCalledWith('t', 'w1', 'f1'));
  });

  it('does not call archive until the confirm dialog is accepted', async () => {
    const spy = vi
      .spyOn(adminApi, 'archiveDeclaredField')
      .mockResolvedValue({ id: 'f1', key: 'vip_status', status: 'archived' });
    renderWithClient(<DeclaredFieldRow token="t" workspaceId="w1" field={activeField} />);

    const user = userEvent.setup();
    await user.click(screen.getByText('×'));

    expect(spy).not.toHaveBeenCalled();
  });

  it('archives after confirming, and calls the API with the workspace and field id', async () => {
    const spy = vi
      .spyOn(adminApi, 'archiveDeclaredField')
      .mockResolvedValue({ id: 'f1', key: 'vip_status', status: 'archived' });
    renderWithClient(<DeclaredFieldRow token="t" workspaceId="w1" field={activeField} />);

    const user = userEvent.setup();
    await user.click(screen.getByText('×'));
    await user.click((await screen.findAllByText('Archive')).at(-1)!);

    await waitFor(() => expect(spy).toHaveBeenCalledWith('t', 'w1', 'f1'));
  });

  it('edits label and saves after confirming', async () => {
    const spy = vi.spyOn(adminApi, 'updateDeclaredField').mockResolvedValue({
      ...activeField,
      label: 'VIP tier',
    });
    renderWithClient(<DeclaredFieldRow token="t" workspaceId="w1" field={activeField} />);

    const user = userEvent.setup();
    await user.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('VIP status');
    await user.clear(input);
    await user.type(input, 'VIP tier');
    await user.click(screen.getByText('Save'));
    await user.click((await screen.findAllByText('Save')).at(-1)!);

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('t', 'w1', 'f1', { label: 'VIP tier', type: 'string' }),
    );
  });

  it('disables the type select for a seeded field but keeps label editable', async () => {
    renderWithClient(<DeclaredFieldRow token="t" workspaceId="w1" field={seededField} />);

    const user = userEvent.setup();
    await user.click(screen.getByText('Edit'));

    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByDisplayValue('Player level')).not.toBeDisabled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldRow.test.tsx`
Expected: FAIL — `DeclaredFieldRow.tsx` and the four `adminApi.ts` functions don't exist yet.

- [ ] **Step 3: Add the four functions to `adminApi.ts`**

Modify `frontend/src/surfaces/admin-console/api/adminApi.ts` — add near the bottom, after `setSuperAdminFlag`, importing the shared wire types:

```typescript
import type {
  ArchiveDeclaredFieldResponse,
  CreateDeclaredFieldResponse,
  DeactivateDeclaredFieldResponse,
  DeclaredFieldsResponse,
  DeclaredFieldType,
  ReactivateDeclaredFieldResponse,
  UpdateDeclaredFieldResponse,
} from '@support/types';
```

(Add this import at the top of the file, alongside the existing `apiCall` import.)

```typescript
export function fetchDeclaredFields(
  token: string,
  workspaceId: string,
): Promise<DeclaredFieldsResponse> {
  return apiCall(`/admin/workspaces/${workspaceId}/declared-fields`, token);
}

export function createDeclaredField(
  token: string,
  workspaceId: string,
  input: { key: string; label: string; type: DeclaredFieldType },
): Promise<CreateDeclaredFieldResponse> {
  return apiCall(`/admin/workspaces/${workspaceId}/declared-fields`, token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateDeclaredField(
  token: string,
  workspaceId: string,
  id: string,
  patch: { label?: string; type?: DeclaredFieldType },
): Promise<UpdateDeclaredFieldResponse> {
  return apiCall(`/admin/workspaces/${workspaceId}/declared-fields/${id}`, token, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deactivateDeclaredField(
  token: string,
  workspaceId: string,
  id: string,
): Promise<DeactivateDeclaredFieldResponse> {
  return apiCall(`/admin/workspaces/${workspaceId}/declared-fields/${id}/deactivate`, token, {
    method: 'POST',
  });
}

export function reactivateDeclaredField(
  token: string,
  workspaceId: string,
  id: string,
): Promise<ReactivateDeclaredFieldResponse> {
  return apiCall(`/admin/workspaces/${workspaceId}/declared-fields/${id}/reactivate`, token, {
    method: 'POST',
  });
}

export function archiveDeclaredField(
  token: string,
  workspaceId: string,
  id: string,
): Promise<ArchiveDeclaredFieldResponse> {
  return apiCall(`/admin/workspaces/${workspaceId}/declared-fields/${id}/archive`, token, {
    method: 'POST',
  });
}
```

- [ ] **Step 4: Implement `DeclaredFieldRow.tsx`**

Create `frontend/src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldRow.tsx`:

```typescript
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DeclaredFieldType, DeclaredFieldView } from '@support/types';
import {
  archiveDeclaredField,
  deactivateDeclaredField,
  reactivateDeclaredField,
  updateDeclaredField,
} from '../../../api/adminApi.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { Input } from '../../../components/ui/input.tsx';
import { TableCell, TableRow } from '../../../components/ui/table.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.tsx';

const TYPES: DeclaredFieldType[] = ['string', 'number', 'boolean', 'timestamp'];

export function DeclaredFieldRow({
  token,
  workspaceId,
  field,
}: {
  token: string;
  workspaceId: string;
  field: DeclaredFieldView;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(field.label);
  const [type, setType] = useState<DeclaredFieldType>(field.type);
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [confirmReactivate, setConfirmReactivate] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['adminDeclaredFields', workspaceId] });

  const save = useMutation({
    mutationFn: () => updateDeclaredField(token, workspaceId, field.id, { label, type }),
    onSuccess: () => {
      setConfirmSave(false);
      setEditing(false);
      void invalidate();
    },
  });

  const deactivate = useMutation({
    mutationFn: () => deactivateDeclaredField(token, workspaceId, field.id),
    onSuccess: () => {
      setConfirmDeactivate(false);
      void invalidate();
    },
  });

  const reactivate = useMutation({
    mutationFn: () => reactivateDeclaredField(token, workspaceId, field.id),
    onSuccess: () => {
      setConfirmReactivate(false);
      void invalidate();
    },
  });

  const archive = useMutation({
    mutationFn: () => archiveDeclaredField(token, workspaceId, field.id),
    onSuccess: () => {
      setConfirmArchive(false);
      void invalidate();
    },
  });

  const dirty = label !== field.label || type !== field.type;
  const isActive = field.status === 'active';
  const isSeeded = field.declaredBy === null;

  return (
    <TableRow>
      <TableCell className="font-mono text-xs text-muted">{field.key}</TableCell>
      <TableCell>
        {editing ? (
          <Input value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 w-48" />
        ) : (
          field.label
        )}
      </TableCell>
      <TableCell>
        {editing ? (
          <div className="flex items-center gap-2">
            <Select
              value={type}
              onValueChange={(v) => setType(v as DeclaredFieldType)}
              disabled={isSeeded}
            >
              <SelectTrigger className="h-8 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isSeeded && (
              <span className="text-xs text-muted">Type is locked for built-in fields</span>
            )}
          </div>
        ) : (
          <Badge variant="secondary">{field.type}</Badge>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={isActive ? 'default' : 'secondary'}>{field.status}</Badge>
      </TableCell>
      <TableCell className="text-xs text-muted">
        {new Date(field.declaredAt).toLocaleDateString()}
        {field.declaredByName ? ` · ${field.declaredByName}` : ''}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {editing ? (
            <>
              <Button
                type="button"
                size="sm"
                onClick={() => setConfirmSave(true)}
                disabled={save.isPending || !label || !dirty}
              >
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditing(false);
                  setLabel(field.label);
                  setType(field.type);
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
              {isActive ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmDeactivate(true)}
                >
                  Deactivate
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmReactivate(true)}
                >
                  Reactivate
                </Button>
              )}
              <Button type="button" size="sm" variant="outline" onClick={() => setConfirmArchive(true)}>
                ×
              </Button>
            </>
          )}
        </div>
      </TableCell>
      <ConfirmDialog
        open={confirmSave}
        onOpenChange={setConfirmSave}
        title="Save changes to this declared field?"
        description={`"${field.key}" will be relabeled${
          type !== field.type ? ' and its type changed' : ''
        }. This does not affect data already stored.`}
        confirmLabel="Save"
        confirming={save.isPending}
        onConfirm={() => save.mutate()}
      />
      <ConfirmDialog
        open={confirmDeactivate}
        onOpenChange={setConfirmDeactivate}
        title="Deactivate this declared field?"
        description={`Future player-state writes for "${field.key}" will go back into raw, unfiltered data. Snapshots already captured keep their existing split. It stays visible here and can be reactivated any time.`}
        confirmLabel="Deactivate"
        variant="destructive"
        confirming={deactivate.isPending}
        onConfirm={() => deactivate.mutate()}
      />
      <ConfirmDialog
        open={confirmReactivate}
        onOpenChange={setConfirmReactivate}
        title="Reactivate this declared field?"
        description={`"${field.key}" will start being split into declared again on every new snapshot from now on.`}
        confirmLabel="Reactivate"
        confirming={reactivate.isPending}
        onConfirm={() => reactivate.mutate()}
      />
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title="Archive this declared field?"
        description={`"${field.key}" will be hidden from this list entirely and future writes fall back into raw. Snapshots already captured are unaffected. Promoting the same key again later revives it.`}
        confirmLabel="Archive"
        variant="destructive"
        confirming={archive.isPending}
        onConfirm={() => archive.mutate()}
      />
    </TableRow>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldRow.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/surfaces/admin-console/api/adminApi.ts \
  frontend/src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldRow.tsx \
  frontend/src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldRow.test.tsx
git commit -m "Add admin-console DeclaredFieldRow and its API functions"
```

---

## Task 5: Frontend — `DeclaredFieldsPanel` and wiring into `WorkspaceDetail`

**Files:**

- Create: `frontend/src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldsPanel.tsx`
- Test: `frontend/src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldsPanel.test.tsx`
- Modify: `frontend/src/surfaces/admin-console/pages/WorkspaceDetail/WorkspaceDetail.tsx`

**Interfaces:**

- Consumes: `fetchDeclaredFields`, `createDeclaredField` (Task 4's `adminApi.ts` additions), `DeclaredFieldRow` (Task 4), `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead` (`../../../components/ui/table.tsx`), `toast` (`sonner`, already a dependency per `MembersTable.tsx`).
- Produces: `<DeclaredFieldsPanel token={string} workspaceId={string} />`, consumed by `WorkspaceDetail.tsx`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldsPanel.test.tsx`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DeclaredFieldsPanel } from './DeclaredFieldsPanel.tsx';
import * as adminApi from '../../../api/adminApi.ts';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('DeclaredFieldsPanel', () => {
  it('renders active and inactive fields from fetchDeclaredFields', async () => {
    vi.spyOn(adminApi, 'fetchDeclaredFields').mockResolvedValue({
      fields: [
        {
          id: 'f1',
          key: 'vip_status',
          label: 'VIP status',
          type: 'string',
          status: 'active',
          declaredAt: '2026-01-01T00:00:00Z',
          declaredBy: 'a1',
          declaredByName: 'Ada Admin',
        },
        {
          id: 'f2',
          key: 'ab_bucket',
          label: 'AB bucket',
          type: 'string',
          status: 'inactive',
          declaredAt: '2026-01-01T00:00:00Z',
          declaredBy: 'a1',
          declaredByName: 'Ada Admin',
        },
      ],
    });

    renderWithClient(<DeclaredFieldsPanel token="t" workspaceId="w1" />);

    expect(await screen.findByText('vip_status')).toBeInTheDocument();
    expect(screen.getByText('ab_bucket')).toBeInTheDocument();
    expect(screen.getByText('+ Promote field')).toBeInTheDocument();
  });

  it('shows empty state when there are no declared fields', async () => {
    vi.spyOn(adminApi, 'fetchDeclaredFields').mockResolvedValue({ fields: [] });

    renderWithClient(<DeclaredFieldsPanel token="t" workspaceId="w1" />);

    expect(await screen.findByText('No declared fields yet.')).toBeInTheDocument();
  });

  it('promotes a field only after the confirm dialog is accepted', async () => {
    vi.spyOn(adminApi, 'fetchDeclaredFields').mockResolvedValue({ fields: [] });
    const spy = vi.spyOn(adminApi, 'createDeclaredField').mockResolvedValue({
      id: 'f1',
      key: 'vip_status',
      label: 'VIP status',
      type: 'string',
      status: 'active',
      declaredAt: '2026-01-01T00:00:00Z',
      declaredBy: 'a1',
      declaredByName: null,
    });

    renderWithClient(<DeclaredFieldsPanel token="t" workspaceId="w1" />);
    await screen.findByText('No declared fields yet.');

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/key/i), 'vip_status');
    await user.type(screen.getByPlaceholderText('Label'), 'VIP status');
    await user.click(screen.getByText('+ Promote field'));

    expect(spy).not.toHaveBeenCalled();

    await user.click((await screen.findAllByText('Promote')).at(-1)!);

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('t', 'w1', {
        key: 'vip_status',
        label: 'VIP status',
        type: 'string',
      }),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldsPanel.test.tsx`
Expected: FAIL — `DeclaredFieldsPanel.tsx` doesn't exist yet.

- [ ] **Step 3: Implement `DeclaredFieldsPanel.tsx`**

Create `frontend/src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldsPanel.tsx`:

```typescript
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { DeclaredFieldType } from '@support/types';
import { createDeclaredField, fetchDeclaredFields } from '../../../api/adminApi.ts';
import { ApiError } from '../../../../../lib/httpClient.ts';
import { Button } from '../../../components/ui/button.tsx';
import { Input } from '../../../components/ui/input.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table.tsx';
import { DeclaredFieldRow } from './DeclaredFieldRow.tsx';

const TYPES: DeclaredFieldType[] = ['string', 'number', 'boolean', 'timestamp'];
const KEY_PATTERN = /^[a-z0-9_]+$/;

function reportError(error: unknown) {
  toast.error(
    error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
  );
}

export function DeclaredFieldsPanel({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<DeclaredFieldType>('string');
  const [confirmPromote, setConfirmPromote] = useState(false);

  const fieldsQuery = useQuery({
    queryKey: ['adminDeclaredFields', workspaceId],
    queryFn: () => fetchDeclaredFields(token, workspaceId),
  });

  const promote = useMutation({
    mutationFn: () => createDeclaredField(token, workspaceId, { key, label, type }),
    onSuccess: () => {
      setKey('');
      setLabel('');
      setType('string');
      setConfirmPromote(false);
      void queryClient.invalidateQueries({ queryKey: ['adminDeclaredFields', workspaceId] });
    },
    onError: reportError,
  });

  const fields = fieldsQuery.data?.fields ?? [];
  const keyValid = KEY_PATTERN.test(key);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-2">
        <Input
          placeholder="key (e.g. vip_status)"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="h-8 w-40 font-mono text-xs"
        />
        <Input
          placeholder="Label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="h-8 w-40"
        />
        <Select value={type} onValueChange={(v) => setType(v as DeclaredFieldType)}>
          <SelectTrigger className="h-8 w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          onClick={() => setConfirmPromote(true)}
          disabled={promote.isPending || !keyValid || !label}
        >
          + Promote field
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead>Label</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Declared</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {fieldsQuery.isPending && (
            <TableRow>
              <TableCell colSpan={6} className="text-muted">
                Loading declared fields…
              </TableCell>
            </TableRow>
          )}
          {fieldsQuery.isSuccess && fields.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-muted">
                No declared fields yet.
              </TableCell>
            </TableRow>
          )}
          {fields.map((field) => (
            <DeclaredFieldRow key={field.id} token={token} workspaceId={workspaceId} field={field} />
          ))}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={confirmPromote}
        onOpenChange={setConfirmPromote}
        title="Promote this key to declared?"
        description={`"${key}" will start being split out of raw player state into declared on every new snapshot from now on. Snapshots already stored are unaffected.`}
        confirmLabel="Promote"
        confirming={promote.isPending}
        onConfirm={() => promote.mutate()}
      />
    </div>
  );
}
```

- [ ] **Step 4: Wire the tab into `WorkspaceDetail.tsx`**

Modify `frontend/src/surfaces/admin-console/pages/WorkspaceDetail/WorkspaceDetail.tsx`:

```typescript
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { fetchWorkspaces } from '../../api/adminApi.ts';
import { loadAdminSession } from '../../lib/adminSession.ts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.tsx';
import { MembersTable } from './components/MembersTable.tsx';
import { SecretPanel } from './components/SecretPanel.tsx';
import { DeclaredFieldsPanel } from './components/DeclaredFieldsPanel.tsx';

export function WorkspaceDetail() {
  const { id } = useParams<{ id: string }>();
  const session = loadAdminSession();

  // No single-workspace GET endpoint exists — list-and-find matches the shape
  // Overview already fetches, and shares its query cache when navigated from there.
  const workspacesQuery = useQuery({
    queryKey: ['adminWorkspaces'],
    queryFn: () => fetchWorkspaces(session!.token),
    enabled: !!session,
  });

  if (!session || !id) return null;

  const workspace = workspacesQuery.data?.workspaces.find((w) => w.id === id);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <Link
          to="/dashboard/overview"
          className="flex items-center gap-1 text-sm text-muted hover:text-text"
        >
          <ArrowLeft className="size-4" />
          All workspaces
        </Link>
        {workspacesQuery.isPending && (
          <h1 className="text-xl font-semibold text-muted">Loading…</h1>
        )}
        {workspace && (
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-semibold">{workspace.name}</h1>
            <span className="text-sm text-muted">{workspace.slug}</span>
          </div>
        )}
        {workspacesQuery.isSuccess && !workspace && (
          <h1 className="text-xl font-semibold text-muted">Workspace not found</h1>
        )}
      </div>

      {workspace && (
        <Tabs defaultValue="members">
          <TabsList>
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="secret">Secret</TabsTrigger>
            <TabsTrigger value="declared-fields">Declared Fields</TabsTrigger>
          </TabsList>
          <TabsContent value="members">
            <MembersTable token={session.token} workspaceId={workspace.id} />
          </TabsContent>
          <TabsContent value="secret">
            <SecretPanel token={session.token} workspaceId={workspace.id} />
          </TabsContent>
          <TabsContent value="declared-fields">
            <DeclaredFieldsPanel token={session.token} workspaceId={workspace.id} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
```

(Only the `DeclaredFieldsPanel` import, the third `TabsTrigger`, and the third `TabsContent` are new; everything else is unchanged from the current file.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldsPanel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/surfaces/admin-console`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldsPanel.tsx \
  frontend/src/surfaces/admin-console/pages/WorkspaceDetail/components/DeclaredFieldsPanel.test.tsx \
  frontend/src/surfaces/admin-console/pages/WorkspaceDetail/WorkspaceDetail.tsx
git commit -m "Add DeclaredFieldsPanel and wire it into WorkspaceDetail's third tab"
```

---

## Task 6: Frontend — remove the old agent-console declared-fields code

**Files:**

- Delete: `frontend/src/surfaces/agent-console/pages/DeclaredFields/DeclaredFields.tsx`
- Delete: `frontend/src/surfaces/agent-console/pages/DeclaredFields/DeclaredFields.test.tsx`
- Delete: `frontend/src/surfaces/agent-console/pages/DeclaredFields/components/DeclaredFieldRow.tsx`
- Delete: `frontend/src/surfaces/agent-console/pages/DeclaredFields/components/DeclaredFieldRow.test.tsx`
- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`
- Modify: `frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx`
- Modify: `frontend/src/surfaces/agent-console/lib/routePreload.ts`
- Modify: `frontend/src/routes/AppRoutes.tsx`

**Interfaces:**

- Consumes: nothing new.
- Produces: nothing — pure removal. `isAdmin` (from `agent-console/lib/agentSession.ts`) becomes unused in `AppRoutes.tsx` after this task and its import is removed there; it remains used elsewhere in `agentSession.ts` itself and in `AgentConsoleShell.tsx` (still gating other nav items), so the exported function itself is not touched.

- [ ] **Step 1: Delete the four page/component files**

```bash
git rm -r frontend/src/surfaces/agent-console/pages/DeclaredFields
```

- [ ] **Step 2: Remove the six functions from `agentApi.ts`**

Modify `frontend/src/surfaces/agent-console/api/agentApi.ts` — delete the six functions (`fetchDeclaredFields`, `createDeclaredField`, `updateDeclaredField`, `deactivateDeclaredField`, `reactivateDeclaredField`, `archiveDeclaredField`), currently sitting between `unarchiveIntent` and `renameSubintent`. Also remove the now-unused type imports at the top of the file: `ArchiveDeclaredFieldResponse`, `CreateDeclaredFieldResponse`, `DeactivateDeclaredFieldResponse`, `DeclaredFieldsResponse`, `DeclaredFieldType`, `ReactivateDeclaredFieldResponse`, `UpdateDeclaredFieldResponse` — but only after confirming with a search that nothing else in the file still references them (`DeclaredFieldType` may also be used elsewhere for forms; check with `grep -n "DeclaredFieldType" frontend/src/surfaces/agent-console/api/agentApi.ts` before removing that one specifically — remove only the ones with zero remaining references).

- [ ] **Step 3: Remove the nav entry from `AgentConsoleShell.tsx`**

Modify `frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx`:

- Delete the `DECLARED_FIELDS_NAV_ITEM` constant (including its preceding comment).
- Delete the `Layers` import from the `lucide-react` import list at the top of the file, if `Layers` is not used anywhere else in the file (check with `grep -n "Layers" frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx` after removing the constant — if the only remaining match is the import line itself, delete that line too).
- Remove `...(isAdmin(session) ? [DECLARED_FIELDS_NAV_ITEM] : [])` from the nav items array it's spread into (the line reads `...(isAdmin(session) ? [DECLARED_FIELDS_NAV_ITEM] : []),` inside the array — delete the whole line). Leave `isAdmin` imported/used if `AgentConsoleShell.tsx` still calls it elsewhere (check with `grep -n "isAdmin" frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx` after the removal).

- [ ] **Step 4: Remove the preload entries from `routePreload.ts`**

Modify `frontend/src/surfaces/agent-console/lib/routePreload.ts`:

```typescript
/*
 * Named dynamic importers for the agent console's lazy routes. AppRoutes.tsx
 * (the composition root) uses these to build its lazy() components, and
 * AgentConsoleShell.tsx uses the same importers to prefetch a tab's chunk on
 * nav hover/focus — one definition, so the two never drift apart.
 */
export const importInbox = () => import('../pages/Inbox/Inbox.tsx');
export const importGlobalInbox = () => import('../pages/GlobalInbox/GlobalInbox.tsx');
export const importTickets = () => import('../pages/Tickets/Tickets.tsx');
export const importKnowledgeBase = () => import('../pages/KnowledgeBase/KnowledgeBase.tsx');
export const importForms = () => import('../pages/Forms/Forms.tsx');
export const importTaxonomy = () => import('../pages/Taxonomy/Taxonomy.tsx');
export const importWorkload = () => import('../pages/Workload/Workload.tsx');
export const importBotConfig = () => import('../pages/BotConfig/BotConfig.tsx');
export const importWorkspaceSettings = () =>
  import('../pages/WorkspaceSettings/WorkspaceSettings.tsx');

// Keyed by the NavLink `to` path AgentConsoleShell renders.
export const agentRoutePreload: Record<string, () => Promise<unknown>> = {
  '/inbox': importInbox,
  '/global-inbox': importGlobalInbox,
  '/tickets': importTickets,
  '/articles': importKnowledgeBase,
  '/forms': importForms,
  '/taxonomy': importTaxonomy,
  '/workload': importWorkload,
  '/bot-config': importBotConfig,
  '/workspace-settings': importWorkspaceSettings,
};
```

(The `importDeclaredFields` export and its `/declared-fields` map entry are removed; every other line is unchanged.)

- [ ] **Step 5: Remove the route from `AppRoutes.tsx`**

Modify `frontend/src/routes/AppRoutes.tsx`:

- Remove `importDeclaredFields` from the `routePreload.ts` import list.
- Remove `isAdmin` from the `import { canBuildForms, isAdmin } from '../surfaces/agent-console/lib/agentSession.ts';` line, leaving `import { canBuildForms } from '../surfaces/agent-console/lib/agentSession.ts';` (confirm first with `grep -n "isAdmin" frontend/src/routes/AppRoutes.tsx` that the only usage was the declared-fields route being removed in this step).
- Remove the `const DeclaredFieldsPage = lazy(...)` block.
- Remove the entire `<Route path="declared-fields" element={<RequireRole allow={isAdmin}><DeclaredFieldsPage /></RequireRole>} />` block.

- [ ] **Step 6: Run the full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: PASS — no remaining test imports the deleted files (confirmed: the two deleted test files were the only references).

- [ ] **Step 7: Typecheck and lint**

Run: `cd frontend && npx tsc --noEmit && npx eslint .`
Expected: no errors — no dangling import of a deleted file or an unused import left behind.

- [ ] **Step 8: Manual verification**

Run: `pnpm dev`, log in to agent-console as an admin, confirm "Declared Fields" no longer appears in the nav and `GET /declared-fields` (client-side route) 404s via `AgentNotFound`. Log in to admin-console, open a workspace, confirm the "Declared Fields" tab works end-to-end (promote, edit, deactivate, reactivate, archive).

- [ ] **Step 9: Commit**

```bash
git add -A frontend/src/surfaces/agent-console/pages/DeclaredFields \
  frontend/src/surfaces/agent-console/api/agentApi.ts \
  frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx \
  frontend/src/surfaces/agent-console/lib/routePreload.ts \
  frontend/src/routes/AppRoutes.tsx
git commit -m "Remove agent-console declared-fields feature"
```
