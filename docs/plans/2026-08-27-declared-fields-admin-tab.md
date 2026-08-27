# Declared Fields Admin Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only "Declared Fields" tab to the agent console that lets an admin view, promote, edit, and archive `declared_field` rows — the admin-promoted key set that splits SDK player-state snapshots into `declared` vs `raw`.

**Architecture:** A new CRUD slice following the exact router → controller → service → Drizzle pattern already used by `taxonomy` (intents/subintents): a workspace-scoped Postgres table gets one new `active` column for soft-remove, four Express routes all gated by the existing global-admin `requireAdminRole` middleware, and a React Query-backed page in `agent-console` gated by the existing `isAdmin(session)` client-side check. No new architectural concepts — this plan is almost entirely "copy the taxonomy pattern, rename the entity."

**Tech Stack:** Express 5 + TypeScript + Zod, Drizzle ORM + `drizzle-kit`, PostgreSQL 17, Vite + React + TanStack Query + Tailwind v4 + shadcn/ui, Vitest + Testing Library + supertest.

## Global Constraints

- No hard deletes, anywhere, ever. "Removing" a declared field is `active = false` (soft-remove), never a `DELETE`. (CLAUDE.md: "No hard deletes anywhere. Don't even write the route.")
- Every write and read on this resource is **admin-only** (global `agent.isAdmin`, via `requireAdminRole` on the backend and `isAdmin(session)` on the frontend) — not the team-lead-can-read split that `workspace-settings`/`forms`/`bot-config` use.
- `key` is immutable after creation. Only `label` and `type` may be edited.
- The `declared_field` split is never retroactive — this plan changes how rows are managed, never `splitSnapshot`'s write-time-only semantics (`backend/src/shared/playerState/split.ts`, `backend/src/shared/playerState/declaredKeys.ts`).
- Permission checks are enforced at the API. Hiding a nav item or route client-side is UX only.
- Tailwind v4 utilities only — no hand-written CSS classes.
- `pnpm typecheck` and the relevant `pnpm test` suites must pass before each commit that touches their package.
- Every new API endpoint gets registered in `backend/src/docs/openapi.ts` (repo-wide CLAUDE.md rule).

---

## File Structure

```
backend/src/shared/db/schema/playerState.ts       MODIFY — add `active` column
backend/drizzle/00XX_*.sql                         CREATE — generated migration
packages/types/src/player-state.ts                 MODIFY — add CRUD types + Zod bodies
backend/src/agent/services/declaredFieldService.ts CREATE — list/create/update/archive
backend/src/agent/controllers/declaredFieldController.ts CREATE
backend/src/agent/routers/declaredFieldRouter.ts    CREATE
backend/src/agent/router.ts                         MODIFY — mount declaredFieldRouter
backend/src/docs/openapi.ts                         MODIFY — register 4 routes
backend/tests/agent.declaredFields.test.ts          CREATE — integration tests
frontend/src/surfaces/agent-console/api/agentApi.ts MODIFY — 4 client functions
frontend/src/surfaces/agent-console/pages/DeclaredFields/DeclaredFields.tsx CREATE
frontend/src/surfaces/agent-console/pages/DeclaredFields/DeclaredFields.test.tsx CREATE
frontend/src/surfaces/agent-console/pages/DeclaredFields/components/DeclaredFieldRow.tsx CREATE
frontend/src/surfaces/agent-console/pages/DeclaredFields/components/DeclaredFieldRow.test.tsx CREATE
frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx MODIFY — nav item
frontend/src/surfaces/agent-console/lib/routePreload.ts MODIFY — lazy importer
frontend/src/routes/AppRoutes.tsx                   MODIFY — route + RequireRole
```

---

### Task 1: Schema — add `active` column and generate migration

**Files:**
- Modify: `backend/src/shared/db/schema/playerState.ts:27-42`
- Create: `backend/drizzle/00XX_*.sql` (generated, exact name TBD by drizzle-kit)

**Interfaces:**
- Produces: `declaredField.active` (Drizzle column, `boolean`, `not null`, `default(true)`) — every later task's queries read/write this.

- [ ] **Step 1: Add the column to the schema**

In `backend/src/shared/db/schema/playerState.ts`, inside the `declaredField` table definition (currently ends at line 42 with the `uniqueIndex`), add the `active` column after `declaredBy`:

```ts
export const declaredField = pgTable(
  'declared_field',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: declaredFieldType('type').notNull(),
    declaredAt: timestamp('declared_at', tz).notNull().defaultNow(),
    /** Nullable: the eleven seeded rows have no human actor. */
    declaredBy: uuid('declared_by').references(() => agent.id, { onDelete: 'restrict' }),
    /**
     * Soft-remove, never a hard delete. `false` means `loadDeclaredKeys` excludes
     * this key, so future snapshots route it back into `raw` — but every snapshot
     * already written keeps whatever split it got at write time. The row itself
     * stays forever, both for audit and so re-promoting the same key later
     * (createDeclaredField) can revive it instead of hitting the unique index.
     */
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('declared_field_workspace_key_uk').on(t.workspaceId, t.key)],
);
```

`boolean` is already imported at the top of the file (used by `playerStateSnapshot.isMissing`), so no import changes are needed.

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`

This produces a new file under `backend/drizzle/` (e.g. `0021_<generated-name>.sql`) containing:

```sql
ALTER TABLE "declared_field" ADD COLUMN "active" boolean DEFAULT true NOT NULL;
```

and appends an entry to `backend/drizzle/meta/_journal.json`. If drizzle-kit prompts for anything interactively (it shouldn't for a simple additive column), accept the default.

- [ ] **Step 3: Apply it and verify**

Run: `pnpm db:setup`

Then verify the column exists:

```bash
psql "$DATABASE_URL" -c "\d declared_field"
```

Expected: `active` listed as `boolean not null default true`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/shared/db/schema/playerState.ts backend/drizzle/
git commit -m "Add active column to declared_field for soft-remove"
```

---

### Task 2: Shared types — `@support/types` CRUD contract

**Files:**
- Modify: `packages/types/src/player-state.ts`

**Interfaces:**
- Consumes: existing `DeclaredFieldType` (already defined in this file, line ~33: `'string' | 'number' | 'boolean' | 'timestamp'`)
- Produces: `CreateDeclaredFieldBody`, `UpdateDeclaredFieldBody` (Zod schemas), `DeclaredFieldView`, `DeclaredFieldsResponse`, `CreateDeclaredFieldResponse`, `UpdateDeclaredFieldResponse`, `ArchiveDeclaredFieldResponse` (types) — every backend controller and frontend `agentApi.ts` function in later tasks imports these from `@support/types`.

- [ ] **Step 1: Add the import and new exports**

At the top of `packages/types/src/player-state.ts`, add:

```ts
import { z } from 'zod';
```

At the bottom of the file (after the existing `DECLARED_FIELD_SEED` export), add:

```ts
export const CreateDeclaredFieldBody = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9_]+$/, 'lowercase letters, numbers and underscores only')
    .min(1)
    .max(64),
  label: z.string().min(1).max(120),
  type: z.enum(['string', 'number', 'boolean', 'timestamp']),
});

export const UpdateDeclaredFieldBody = z
  .object({
    label: z.string().min(1).max(120).optional(),
    type: z.enum(['string', 'number', 'boolean', 'timestamp']).optional(),
  })
  .refine((v) => v.label !== undefined || v.type !== undefined, {
    message: 'At least one of label or type is required.',
  });

export type DeclaredFieldView = {
  id: string;
  key: string;
  label: string;
  type: DeclaredFieldType;
  declaredAt: string;
  declaredBy: string | null;
  declaredByName: string | null;
};

export type DeclaredFieldsResponse = { fields: DeclaredFieldView[] };
export type CreateDeclaredFieldResponse = DeclaredFieldView;
export type UpdateDeclaredFieldResponse = DeclaredFieldView;
export type ArchiveDeclaredFieldResponse = { id: string; key: string };
```

- [ ] **Step 2: Typecheck the package**

Run: `pnpm --filter @support/types typecheck`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/player-state.ts
git commit -m "Add declared-field CRUD types to @support/types"
```

---

### Task 3: Backend service — `declaredFieldService.ts`

**Files:**
- Create: `backend/src/agent/services/declaredFieldService.ts`
- Test: `backend/tests/agent.declaredFields.test.ts` (integration tests land in Task 6, against the router; this task has no standalone unit test file — the taxonomy service precedent is tested only through its router's integration tests, and this plan follows that)

**Interfaces:**
- Consumes: `AgentContext` (`backend/src/shared/middleware/requireAgentSession.ts`, shape `{ agentId: string; workspaceId: string; isAdmin: boolean }`), `withWorkspace` (`backend/src/shared/db/withWorkspace.ts`), `appendChangeLog` (`backend/src/shared/changeLog/appendChangeLog.ts`, signature `(tx, { workspaceId, entityType, entityId, actorId, changes }) => Promise<void>`), `declaredField`/`agent` Drizzle tables (`backend/src/shared/db/schema/index.ts`), `DeclaredFieldView` / `DeclaredFieldsResponse` (from `@support/types`, Task 2)
- Produces: `listDeclaredFields(ctx): Promise<DeclaredFieldsResponse>`, `createDeclaredField(ctx, { key, label, type }): Promise<CreateDeclaredFieldResult>`, `updateDeclaredField(ctx, id, { label?, type? }): Promise<UpdateDeclaredFieldResult>`, `archiveDeclaredField(ctx, id): Promise<ArchiveDeclaredFieldResult>` — Task 4's controller calls these directly by name.

- [ ] **Step 1: Write the service**

```ts
import { and, asc, eq } from 'drizzle-orm';
import type {
  ArchiveDeclaredFieldResponse,
  CreateDeclaredFieldResponse,
  DeclaredFieldsResponse,
  DeclaredFieldType,
  DeclaredFieldView,
  UpdateDeclaredFieldResponse,
} from '@support/types';
import { agent, declaredField } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import { appendChangeLog } from '../../shared/changeLog/appendChangeLog.ts';

export async function listDeclaredFields(ctx: AgentContext): Promise<DeclaredFieldsResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const rows = await tx
      .select({
        id: declaredField.id,
        key: declaredField.key,
        label: declaredField.label,
        type: declaredField.type,
        declaredAt: declaredField.declaredAt,
        declaredBy: declaredField.declaredBy,
        declaredByName: agent.displayName,
      })
      .from(declaredField)
      .leftJoin(agent, eq(agent.id, declaredField.declaredBy))
      .where(eq(declaredField.active, true))
      .orderBy(asc(declaredField.key));

    return {
      fields: rows.map((row) => ({
        id: row.id,
        key: row.key,
        label: row.label,
        type: row.type,
        declaredAt: row.declaredAt.toISOString(),
        declaredBy: row.declaredBy,
        declaredByName: row.declaredByName,
      })),
    };
  });
}

export type CreateDeclaredFieldResult =
  | { ok: true; field: CreateDeclaredFieldResponse }
  | { ok: false; reason: 'key_taken' };

/**
 * Re-promoting a key that was previously archived revives the existing row
 * (new label/type/declaredBy/declaredAt) instead of inserting a duplicate,
 * which would otherwise hit `declared_field_workspace_key_uk`. There is no
 * separate "unarchive" endpoint — this is the only way back for an archived key.
 */
export async function createDeclaredField(
  ctx: AgentContext,
  input: { key: string; label: string; type: DeclaredFieldType },
): Promise<CreateDeclaredFieldResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx
      .select({ id: declaredField.id, active: declaredField.active })
      .from(declaredField)
      .where(and(eq(declaredField.workspaceId, ctx.workspaceId), eq(declaredField.key, input.key)))
      .limit(1);

    if (existing?.active) return { ok: false, reason: 'key_taken' };

    const values = {
      workspaceId: ctx.workspaceId,
      key: input.key,
      label: input.label,
      type: input.type,
      active: true,
      declaredAt: new Date(),
      declaredBy: ctx.agentId,
    };

    const returning = {
      id: declaredField.id,
      key: declaredField.key,
      label: declaredField.label,
      type: declaredField.type,
      declaredAt: declaredField.declaredAt,
      declaredBy: declaredField.declaredBy,
    };

    const [row] = existing
      ? await tx
          .update(declaredField)
          .set(values)
          .where(eq(declaredField.id, existing.id))
          .returning(returning)
      : await tx.insert(declaredField).values(values).returning(returning);

    return {
      ok: true,
      field: {
        id: row!.id,
        key: row!.key,
        label: row!.label,
        type: row!.type,
        declaredAt: row!.declaredAt.toISOString(),
        declaredBy: row!.declaredBy,
        declaredByName: null,
      },
    };
  });
}

export type UpdateDeclaredFieldResult =
  | { ok: true; field: UpdateDeclaredFieldResponse }
  | { ok: false; reason: 'not_found' };

export async function updateDeclaredField(
  ctx: AgentContext,
  id: string,
  patch: { label?: string; type?: DeclaredFieldType },
): Promise<UpdateDeclaredFieldResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({ id: declaredField.id, label: declaredField.label, type: declaredField.type })
      .from(declaredField)
      .where(and(eq(declaredField.id, id), eq(declaredField.active, true)))
      .limit(1);
    if (!current) return { ok: false, reason: 'not_found' };

    const changes: { field: string; before: unknown; after: unknown }[] = [];
    if (patch.label !== undefined)
      changes.push({ field: 'label', before: current.label, after: patch.label });
    if (patch.type !== undefined)
      changes.push({ field: 'type', before: current.type, after: patch.type });

    const [row] = await tx
      .update(declaredField)
      .set({
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
      })
      .where(eq(declaredField.id, id))
      .returning({
        id: declaredField.id,
        key: declaredField.key,
        label: declaredField.label,
        type: declaredField.type,
        declaredAt: declaredField.declaredAt,
        declaredBy: declaredField.declaredBy,
      });

    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'declared_field',
      entityId: id,
      actorId: ctx.agentId,
      changes,
    });

    return {
      ok: true,
      field: {
        id: row!.id,
        key: row!.key,
        label: row!.label,
        type: row!.type,
        declaredAt: row!.declaredAt.toISOString(),
        declaredBy: row!.declaredBy,
        declaredByName: null,
      },
    };
  });
}

export type ArchiveDeclaredFieldResult =
  | { ok: true; field: ArchiveDeclaredFieldResponse }
  | { ok: false; reason: 'not_found' };

export async function archiveDeclaredField(
  ctx: AgentContext,
  id: string,
): Promise<ArchiveDeclaredFieldResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({ id: declaredField.id, key: declaredField.key })
      .from(declaredField)
      .where(and(eq(declaredField.id, id), eq(declaredField.active, true)))
      .limit(1);
    if (!current) return { ok: false, reason: 'not_found' };

    await tx.update(declaredField).set({ active: false }).where(eq(declaredField.id, id));

    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'declared_field',
      entityId: id,
      actorId: ctx.agentId,
      changes: [{ field: 'active', before: true, after: false }],
    });

    return { ok: true, field: { id: current.id, key: current.key } };
  });
}
```

`DeclaredFieldView` is imported but not directly referenced by name in the file above except through the response type aliases — remove it from the import list if `tsc` flags it as unused (it isn't: `CreateDeclaredFieldResponse` etc. are aliases of it in Task 2, so only those alias names are needed here). Use exactly the import list shown; do not import `DeclaredFieldView` itself in this file.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @support/api typecheck`

Expected: no errors. (Full behavioral verification happens in Task 6's integration tests, since this service has no DB connection to unit-test in isolation without one.)

- [ ] **Step 3: Commit**

```bash
git add backend/src/agent/services/declaredFieldService.ts
git commit -m "Add declaredFieldService: list, create, update, archive"
```

---

### Task 4: Backend controller — `declaredFieldController.ts`

**Files:**
- Create: `backend/src/agent/controllers/declaredFieldController.ts`

**Interfaces:**
- Consumes: `CreateDeclaredFieldBody`, `UpdateDeclaredFieldBody` (Zod, from `@support/types`, Task 2), `sendError` (`backend/src/errors.ts`, signature `(res, status, code, message) => void`), `listDeclaredFields`/`createDeclaredField`/`updateDeclaredField`/`archiveDeclaredField` (Task 3)
- Produces: `listDeclaredFieldsHandler`, `createDeclaredFieldHandler`, `updateDeclaredFieldHandler`, `archiveDeclaredFieldHandler` (Express `RequestHandler`s) — Task 5's router wires these to routes by name.

- [ ] **Step 1: Write the controller**

```ts
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { CreateDeclaredFieldBody, UpdateDeclaredFieldBody } from '@support/types';
import { sendError } from '../../errors.ts';
import {
  archiveDeclaredField,
  createDeclaredField,
  listDeclaredFields,
  updateDeclaredField,
} from '../services/declaredFieldService.ts';

const DeclaredFieldIdParams = z.object({ id: z.uuid() });

export const listDeclaredFieldsHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await listDeclaredFields(req.agent!));
};

export const createDeclaredFieldHandler: RequestHandler = async (req, res) => {
  const body = CreateDeclaredFieldBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'key, label and a valid type are required.');
    return;
  }
  const result = await createDeclaredField(req.agent!, body.data);
  if (!result.ok) {
    sendError(res, 409, 'key_taken', 'A declared field with this key already exists.');
    return;
  }
  res.status(201).json(result.field);
};

export const updateDeclaredFieldHandler: RequestHandler = async (req, res) => {
  const params = DeclaredFieldIdParams.safeParse(req.params);
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
  const result = await updateDeclaredField(req.agent!, params.data.id, body.data);
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Declared field not found.');
    return;
  }
  res.status(200).json(result.field);
};

export const archiveDeclaredFieldHandler: RequestHandler = async (req, res) => {
  const params = DeclaredFieldIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid id is required.');
    return;
  }
  const result = await archiveDeclaredField(req.agent!, params.data.id);
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Declared field not found.');
    return;
  }
  res.status(200).json(result.field);
};
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @support/api typecheck`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/agent/controllers/declaredFieldController.ts
git commit -m "Add declaredFieldController"
```

---

### Task 5: Backend router — mount + OpenAPI registration

**Files:**
- Create: `backend/src/agent/routers/declaredFieldRouter.ts`
- Modify: `backend/src/agent/router.ts`
- Modify: `backend/src/docs/openapi.ts`

**Interfaces:**
- Consumes: `requireAdminRole` (`backend/src/shared/middleware/requireAdminRole.ts`), the four handlers from Task 4
- Produces: `declaredFieldRouter` (Express `Router`) mounted on `agentRouter`, exposing `GET/POST /agent/declared-fields`, `PATCH /agent/declared-fields/:id`, `POST /agent/declared-fields/:id/archive` — Task 6's tests hit these paths directly.

- [ ] **Step 1: Write the router**

```ts
import { Router } from 'express';
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts';
import {
  archiveDeclaredFieldHandler,
  createDeclaredFieldHandler,
  listDeclaredFieldsHandler,
  updateDeclaredFieldHandler,
} from '../controllers/declaredFieldController.ts';

/**
 * Every operation is admin-only (global agent.isAdmin) — unlike
 * workspaceSettingsRouter's team-lead-can-read split, this tab has no
 * lesser-role read access at all.
 */
export const declaredFieldRouter = Router();
declaredFieldRouter.get('/declared-fields', requireAdminRole, listDeclaredFieldsHandler);
declaredFieldRouter.post('/declared-fields', requireAdminRole, createDeclaredFieldHandler);
declaredFieldRouter.patch('/declared-fields/:id', requireAdminRole, updateDeclaredFieldHandler);
declaredFieldRouter.post(
  '/declared-fields/:id/archive',
  requireAdminRole,
  archiveDeclaredFieldHandler,
);
```

- [ ] **Step 2: Mount it in `backend/src/agent/router.ts`**

Add the import alongside the other router imports (after `import { workspaceSettingsRouter } ...`):

```ts
import { declaredFieldRouter } from './routers/declaredFieldRouter.ts';
```

Add the mount call after `agentRouter.use(workspaceSettingsRouter);`:

```ts
agentRouter.use(declaredFieldRouter);
```

- [ ] **Step 3: Register in OpenAPI**

In `backend/src/docs/openapi.ts`, find the `registry.registerPath(...)` block for `POST /agent/intents` (search for `path: '/agent/intents'`) and add four new blocks near it, following its exact shape:

```ts
registry.registerPath({
  method: 'get',
  path: '/agent/declared-fields',
  summary: 'Agent List Declared Fields',
  description: 'Lists active declared fields for the workspace. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: { 200: { description: 'Declared fields' }, 403: { description: 'Forbidden — admin role required' } },
});

registry.registerPath({
  method: 'post',
  path: '/agent/declared-fields',
  summary: 'Agent Promote Declared Field',
  description: 'Promotes a key to declared, or revives a previously archived one with the same key. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
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
    201: { description: 'Declared field created' },
    409: { description: 'Key already declared' },
    403: { description: 'Forbidden — admin role required' },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/declared-fields/{id}',
  summary: 'Agent Update Declared Field',
  description: 'Edits the label and/or type of an existing declared field. The key is immutable. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
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
    404: { description: 'Not found' },
    403: { description: 'Forbidden — admin role required' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/declared-fields/{id}/archive',
  summary: 'Agent Archive Declared Field',
  description: 'Soft-removes a declared field. Future snapshots for this key fall back into raw. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Declared field archived' },
    404: { description: 'Not found' },
    403: { description: 'Forbidden — admin role required' },
  },
});
```

Match whatever `bearerAgentJwt` reference and `z` import the surrounding `/agent/intents` blocks already use in this file — use the same names, don't reimport.

- [ ] **Step 4: Typecheck and smoke-check the docs**

Run: `pnpm --filter @support/api typecheck`

Then start the dev server (`pnpm dev`, or just the backend if there's a filtered script) and open `http://localhost:4000/docs` — confirm the four new `/agent/declared-fields*` operations appear.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/routers/declaredFieldRouter.ts backend/src/agent/router.ts backend/src/docs/openapi.ts
git commit -m "Add declaredFieldRouter, mount it, register OpenAPI routes"
```

---

### Task 6: Backend integration tests

**Files:**
- Create: `backend/tests/agent.declaredFields.test.ts`

**Interfaces:**
- Consumes: `declaredFieldRouter` (Task 5), test helpers `req as request` (`backend/tests/helpers/http.ts`), `closeDb`/`closeAdminDb`, `errorMiddleware`, `requireAgentSession`, `resolveConsoleWorkspace`, `signAgentSession`, `closeWsAuthRedis`, `closeSocketServer`/`createSocketServer`, `closeOwnerPool, ownerPool, seedWorkspace, truncateAll` (`backend/tests/helpers/db.ts`) — all identical to the pattern in `backend/tests/agent.workspaceSettings.test.ts`.

- [ ] **Step 1: Write the test file**

```ts
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { declaredFieldRouter } from '../src/agent/routers/declaredFieldRouter.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, declaredFieldRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createServer.length; // no-op to keep import; createSocketServer needs a real server
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function seedAgentWithRole(
  workspaceId: string,
  role: 'agent' | 'team_lead' | 'admin',
): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name, is_admin) values ($1, 'Test Agent', $2) returning id`,
    [`${role}-${Math.random().toString(36).slice(2)}@example.test`, role === 'admin'],
  );
  const agentId = rows[0]!.id;
  if (role !== 'admin') {
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, $3)`,
      [workspaceId, agentId, role],
    );
  }
  const token = await signAgentSession({ agent_id: agentId, is_admin: role === 'admin' });
  return { agentId, token };
}

describe('GET /declared-fields', () => {
  it('returns only active fields, ordered by key', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'VIP status', type: 'string' })
      .expect(201);
    const created = await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'ab_bucket', label: 'AB bucket', type: 'string' })
      .expect(201);

    await request(app)
      .post(`/declared-fields/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const res = await request(app)
      .get('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.fields.map((f: { key: string }) => f.key)).toEqual(['vip_status']);
  });

  it('forbids a team lead', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');

    await request(app)
      .get('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(403);
  });

  it('forbids a plain agent', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .get('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(403);
  });
});

describe('POST /declared-fields', () => {
  it('promotes a new key', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'VIP status', type: 'string' })
      .expect(201);

    expect(res.body).toMatchObject({
      key: 'vip_status',
      label: 'VIP status',
      type: 'string',
      declaredBy: agentId,
    });
  });

  it('rejects an invalid key', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'VIP Status!', label: 'VIP status', type: 'string' })
      .expect(422);
  });

  it('409s on a duplicate active key', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'VIP status', type: 'string' })
      .expect(201);

    await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'Different label', type: 'string' })
      .expect(409);
  });

  it('revives an archived key instead of erroring', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const first = await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'VIP status', type: 'string' })
      .expect(201);

    await request(app)
      .post(`/declared-fields/${first.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const revived = await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'VIP status v2', type: 'number' })
      .expect(201);

    expect(revived.body.id).toBe(first.body.id);
    expect(revived.body.label).toBe('VIP status v2');
    expect(revived.body.type).toBe('number');

    const list = await request(app)
      .get('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(list.body.fields.map((f: { key: string }) => f.key)).toEqual(['vip_status']);
  });

  it('forbids a team lead from promoting', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');

    await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'VIP status', type: 'string' })
      .expect(403);
  });
});

describe('PATCH /declared-fields/:id', () => {
  it('updates label and type, ignoring any key in the body', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const created = await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'VIP status', type: 'string' })
      .expect(201);

    const res = await request(app)
      .patch(`/declared-fields/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ label: 'VIP tier', type: 'number', key: 'ignored_key' })
      .expect(200);

    expect(res.body).toMatchObject({ key: 'vip_status', label: 'VIP tier', type: 'number' });
  });

  it('writes a change_log row per changed field', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgentWithRole(workspaceId, 'admin');

    const created = await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'VIP status', type: 'string' })
      .expect(201);

    await request(app)
      .patch(`/declared-fields/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ label: 'VIP tier' })
      .expect(200);

    const { rows } = await ownerPool.query<{ field: string; actor_id: string }>(
      `select field, actor_id from change_log
        where entity_type = 'declared_field' and entity_id = $1 order by field`,
      [created.body.id],
    );
    expect(rows).toEqual([{ field: 'label', actor_id: agentId }]);
  });

  it('404s on an unknown id', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .patch('/declared-fields/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ label: 'VIP tier' })
      .expect(404);
  });

  it('forbids a team lead from editing', async () => {
    const workspaceId = await seedWorkspace();
    const { token: adminToken } = await seedAgentWithRole(workspaceId, 'admin');
    const { token: leadToken } = await seedAgentWithRole(workspaceId, 'team_lead');

    const created = await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'VIP status', type: 'string' })
      .expect(201);

    await request(app)
      .patch(`/declared-fields/${created.body.id}`)
      .set('Authorization', `Bearer ${leadToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ label: 'VIP tier' })
      .expect(403);
  });
});

describe('POST /declared-fields/:id/archive', () => {
  it('archives the field and excludes it from later listings', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const created = await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'VIP status', type: 'string' })
      .expect(201);

    await request(app)
      .post(`/declared-fields/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const list = await request(app)
      .get('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(list.body.fields).toEqual([]);
  });

  it('forbids a plain agent from archiving', async () => {
    const workspaceId = await seedWorkspace();
    const { token: adminToken } = await seedAgentWithRole(workspaceId, 'admin');
    const { token: agentToken } = await seedAgentWithRole(workspaceId, 'agent');

    const created = await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'VIP status', type: 'string' })
      .expect(201);

    await request(app)
      .post(`/declared-fields/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(403);
  });
});
```

Delete the stray `createServer.length;` no-op line if it was included by mistake when transcribing — it isn't needed; `beforeAll` should read exactly:

```ts
beforeAll(() => {
  createSocketServer(createServer());
});
```

(matching `agent.workspaceSettings.test.ts` verbatim).

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @support/api exec vitest run agent.declaredFields.test.ts` (Postgres/Redis must already be up — `docker-compose up -d` per `README.md`).

Expected: all tests pass. If Postgres/Redis aren't running, start them first (`docker-compose up -d`, per `README.md`).

- [ ] **Step 3: Commit**

```bash
git add backend/tests/agent.declaredFields.test.ts
git commit -m "Add integration tests for declared-field CRUD and role gating"
```

---

### Task 7: Frontend API client

**Files:**
- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`

**Interfaces:**
- Consumes: `call<T>(path, token, init?)` (private helper already in this file, wraps `apiCall` from `../../../lib/httpClient.ts` with the session's `workspaceId`), types from `@support/types` (Task 2)
- Produces: `fetchDeclaredFields(token)`, `createDeclaredField(token, input)`, `updateDeclaredField(token, id, patch)`, `archiveDeclaredField(token, id)` — Task 8/9 components import these.

- [ ] **Step 1: Add the type imports**

In the existing `import type { ... } from '@support/types';` block at the top of `agentApi.ts`, add these names in their alphabetically-sensible spot alongside the existing ones (the file's list isn't strictly alphabetized — just add near the other `Declared`/`D`-prefixed or `Create`-prefixed entries, doesn't need to match exactly):

```ts
  ArchiveDeclaredFieldResponse,
  CreateDeclaredFieldResponse,
  DeclaredFieldsResponse,
  DeclaredFieldType,
  UpdateDeclaredFieldResponse,
```

- [ ] **Step 2: Add the four functions**

Add near the existing `fetchIntents`/`createIntent`/`renameIntent`/`archiveIntent` functions (same file, e.g. right after `archiveIntent`):

```ts
export function fetchDeclaredFields(token: string): Promise<DeclaredFieldsResponse> {
  return call('/agent/declared-fields', token);
}

export function createDeclaredField(
  token: string,
  input: { key: string; label: string; type: DeclaredFieldType },
): Promise<CreateDeclaredFieldResponse> {
  return call('/agent/declared-fields', token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateDeclaredField(
  token: string,
  id: string,
  patch: { label?: string; type?: DeclaredFieldType },
): Promise<UpdateDeclaredFieldResponse> {
  return call(`/agent/declared-fields/${id}`, token, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function archiveDeclaredField(
  token: string,
  id: string,
): Promise<ArchiveDeclaredFieldResponse> {
  return call(`/agent/declared-fields/${id}/archive`, token, { method: 'POST' });
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @support/web typecheck`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts
git commit -m "Add declared-field client functions to agentApi"
```

---

### Task 8: Frontend — `DeclaredFieldRow` component

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/DeclaredFields/components/DeclaredFieldRow.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/DeclaredFields/components/DeclaredFieldRow.test.tsx`

**Interfaces:**
- Consumes: `updateDeclaredField`, `archiveDeclaredField` (Task 7), `DeclaredFieldView`/`DeclaredFieldType` (from `@support/types`, Task 2), `ConfirmDialog` (`frontend/src/surfaces/agent-console/components/ConfirmDialog.tsx` — **note: it lives under `agent-console/components/`, not `admin-console/components/`; verify this path exists before importing — if it doesn't yet, copy `admin-console/components/ConfirmDialog.tsx` verbatim into `agent-console/components/ConfirmDialog.tsx` first, since `IntentRow.tsx` already imports `'../../../components/ConfirmDialog.tsx'` successfully, meaning an agent-console copy already exists**), shadcn `Select`/`SelectTrigger`/`SelectContent`/`SelectItem`/`SelectValue` (`../../../components/ui/select.tsx`), `Badge`, `Button`, `Input` (same `ui/` folder)
- Produces: `DeclaredFieldRow({ token, field }: { token: string; field: DeclaredFieldView })` — a `<tr>` — Task 9's page renders one per row inside a `<tbody>`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DeclaredFieldView } from '@support/types';
import { DeclaredFieldRow } from './DeclaredFieldRow.tsx';
import * as agentApi from '../../../api/agentApi.ts';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <table>
        <tbody>{ui}</tbody>
      </table>
    </QueryClientProvider>,
  );
}

const field: DeclaredFieldView = {
  id: 'f1',
  key: 'vip_status',
  label: 'VIP status',
  type: 'string',
  declaredAt: '2026-01-01T00:00:00Z',
  declaredBy: 'a1',
  declaredByName: 'Ada Admin',
};

describe('DeclaredFieldRow', () => {
  it('shows the key, label, type and declared-by', () => {
    renderWithClient(<DeclaredFieldRow token="t" field={field} />);

    expect(screen.getByText('vip_status')).toBeInTheDocument();
    expect(screen.getByText('VIP status')).toBeInTheDocument();
    expect(screen.getByText('string')).toBeInTheDocument();
    expect(screen.getByText(/Ada Admin/)).toBeInTheDocument();
  });

  it('archives after confirming, and calls the API with the field id', async () => {
    const spy = vi.spyOn(agentApi, 'archiveDeclaredField').mockResolvedValue({
      id: 'f1',
      key: 'vip_status',
    });
    renderWithClient(<DeclaredFieldRow token="t" field={field} />);

    const user = userEvent.setup();
    await user.click(screen.getByText('×'));
    await user.click((await screen.findAllByText('Archive')).at(-1)!);

    await waitFor(() => expect(spy).toHaveBeenCalledWith('t', 'f1'));
  });

  it('does not call archive until the confirm dialog is accepted', async () => {
    const spy = vi.spyOn(agentApi, 'archiveDeclaredField').mockResolvedValue({
      id: 'f1',
      key: 'vip_status',
    });
    renderWithClient(<DeclaredFieldRow token="t" field={field} />);

    const user = userEvent.setup();
    await user.click(screen.getByText('×'));

    expect(spy).not.toHaveBeenCalled();
  });

  it('edits label and saves after confirming', async () => {
    const spy = vi.spyOn(agentApi, 'updateDeclaredField').mockResolvedValue({
      ...field,
      label: 'VIP tier',
    });
    renderWithClient(<DeclaredFieldRow token="t" field={field} />);

    const user = userEvent.setup();
    await user.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('VIP status');
    await user.clear(input);
    await user.type(input, 'VIP tier');
    await user.click(screen.getByText('Save'));
    await user.click((await screen.findAllByText('Save')).at(-1)!);

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('t', 'f1', { label: 'VIP tier', type: 'string' }),
    );
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @support/web exec vitest run DeclaredFieldRow`

Expected: FAIL — `Cannot find module './DeclaredFieldRow.tsx'` (or similar), since the component doesn't exist yet.

- [ ] **Step 3: Write the component**

```tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DeclaredFieldType, DeclaredFieldView } from '@support/types';
import { archiveDeclaredField, updateDeclaredField } from '../../../api/agentApi.ts';
import { Badge } from '../../../components/ui/badge.tsx';
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

const TYPES: DeclaredFieldType[] = ['string', 'number', 'boolean', 'timestamp'];

export function DeclaredFieldRow({ token, field }: { token: string; field: DeclaredFieldView }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(field.label);
  const [type, setType] = useState<DeclaredFieldType>(field.type);
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['declared-fields'] });

  const save = useMutation({
    mutationFn: () => updateDeclaredField(token, field.id, { label, type }),
    onSuccess: () => {
      setConfirmSave(false);
      setEditing(false);
      void invalidate();
    },
  });

  const archive = useMutation({
    mutationFn: () => archiveDeclaredField(token, field.id),
    onSuccess: () => {
      setConfirmArchive(false);
      void invalidate();
    },
  });

  const dirty = label !== field.label || type !== field.type;

  return (
    <tr>
      <td className="px-3 py-2 font-mono text-xs text-muted">{field.key}</td>
      <td className="px-3 py-2">
        {editing ? (
          <Input value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 w-48" />
        ) : (
          field.label
        )}
      </td>
      <td className="px-3 py-2">
        {editing ? (
          <Select value={type} onValueChange={(v) => setType(v as DeclaredFieldType)}>
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
        ) : (
          <Badge variant="secondary">{field.type}</Badge>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-muted">
        {new Date(field.declaredAt).toLocaleDateString()}
        {field.declaredByName ? ` · ${field.declaredByName}` : ''}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1">
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
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmArchive(true)}
                >
                  ×
                </Button>
              </>
            )}
          </div>
          {save.isError && <p className="text-xs text-red-600">{save.error?.message}</p>}
          {archive.isError && <p className="text-xs text-red-600">{archive.error?.message}</p>}
        </div>
      </td>
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
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title="Archive this declared field?"
        description={`Future player-state writes for "${field.key}" will go back into raw, unfiltered data. Snapshots already captured keep their existing split. Promoting the same key again later revives this field.`}
        confirmLabel="Archive"
        variant="destructive"
        confirming={archive.isPending}
        onConfirm={() => archive.mutate()}
      />
    </tr>
  );
}
```

If `frontend/src/surfaces/agent-console/components/ConfirmDialog.tsx` does not already exist (verify with a file check before this step — `ls frontend/src/surfaces/agent-console/components/ConfirmDialog.tsx`), copy `frontend/src/surfaces/admin-console/components/ConfirmDialog.tsx` to that path unchanged (it has no admin-console-specific imports — it only imports from its own local `./ui/dialog.tsx` and `./ui/button.tsx`, both of which also exist under `agent-console/components/ui/`).

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm --filter @support/web exec vitest run DeclaredFieldRow`

Expected: PASS, all four cases.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/DeclaredFields/components/DeclaredFieldRow.tsx frontend/src/surfaces/agent-console/pages/DeclaredFields/components/DeclaredFieldRow.test.tsx
git commit -m "Add DeclaredFieldRow: inline edit and archive, both confirm-gated"
```

---

### Task 9: Frontend — `DeclaredFields` page

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/DeclaredFields/DeclaredFields.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/DeclaredFields/DeclaredFields.test.tsx`

**Interfaces:**
- Consumes: `fetchDeclaredFields`, `createDeclaredField` (Task 7), `loadAgentSession` (`../../lib/agentSession.ts`), `DeclaredFieldRow` (Task 8), `ConfirmDialog`, `EmptyState`, `ScrollArea`, `Select*`, `Button`, `Input` (existing `ui/`)
- Produces: `DeclaredFields()` component — Task 10 wires this into the router as the `/declared-fields` route's element.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DeclaredFields } from './DeclaredFields.tsx';
import * as agentApi from '../../api/agentApi.ts';
import * as agentSession from '../../lib/agentSession.ts';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('DeclaredFields', () => {
  it('renders the field list from GET /agent/declared-fields', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a1',
      displayName: 'A',
      workspaceSlug: 'ws',
      role: 'admin',
    });
    vi.spyOn(agentApi, 'fetchDeclaredFields').mockResolvedValue({
      fields: [
        {
          id: 'f1',
          key: 'vip_status',
          label: 'VIP status',
          type: 'string',
          declaredAt: '2026-01-01T00:00:00Z',
          declaredBy: 'a1',
          declaredByName: 'Ada Admin',
        },
      ],
    });

    renderWithClient(<DeclaredFields />);

    expect(await screen.findByText('vip_status')).toBeInTheDocument();
    expect(screen.getByText('+ Promote field')).toBeInTheDocument();
  });

  it('shows empty state when there are no declared fields', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a1',
      displayName: 'A',
      workspaceSlug: 'ws',
      role: 'admin',
    });
    vi.spyOn(agentApi, 'fetchDeclaredFields').mockResolvedValue({ fields: [] });

    renderWithClient(<DeclaredFields />);

    expect(await screen.findByText('No declared fields yet')).toBeInTheDocument();
  });

  it('promotes a field only after the confirm dialog is accepted', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a1',
      displayName: 'A',
      workspaceSlug: 'ws',
      role: 'admin',
    });
    vi.spyOn(agentApi, 'fetchDeclaredFields').mockResolvedValue({ fields: [] });
    const spy = vi.spyOn(agentApi, 'createDeclaredField').mockResolvedValue({
      id: 'f1',
      key: 'vip_status',
      label: 'VIP status',
      type: 'string',
      declaredAt: '2026-01-01T00:00:00Z',
      declaredBy: 'a1',
      declaredByName: null,
    });

    renderWithClient(<DeclaredFields />);
    await screen.findByText('No declared fields yet');

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/key/i), 'vip_status');
    await user.type(screen.getByPlaceholderText('Label'), 'VIP status');
    await user.click(screen.getByText('+ Promote field'));

    expect(spy).not.toHaveBeenCalled();

    await user.click((await screen.findAllByText('Promote')).at(-1)!);

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('t', {
        key: 'vip_status',
        label: 'VIP status',
        type: 'string',
      }),
    );
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @support/web exec vitest run DeclaredFields.test.tsx`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the page**

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeclaredFieldType } from '@support/types';
import { createDeclaredField, fetchDeclaredFields } from '../../api/agentApi.ts';
import { loadAgentSession } from '../../lib/agentSession.ts';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { ScrollArea } from '../../components/ui/scroll-area.tsx';
import { EmptyState } from '../../components/ui/empty-state.tsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.tsx';
import { DeclaredFieldRow } from './components/DeclaredFieldRow.tsx';

const TYPES: DeclaredFieldType[] = ['string', 'number', 'boolean', 'timestamp'];
const KEY_PATTERN = /^[a-z0-9_]+$/;

export function DeclaredFields() {
  const session = loadAgentSession();
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<DeclaredFieldType>('string');
  const [confirmPromote, setConfirmPromote] = useState(false);

  const fieldsQuery = useQuery({
    queryKey: ['declared-fields'],
    queryFn: () => fetchDeclaredFields(session!.token),
    enabled: session !== null,
  });

  const promote = useMutation({
    mutationFn: () => createDeclaredField(session!.token, { key, label, type }),
    onSuccess: () => {
      setKey('');
      setLabel('');
      setType('string');
      setConfirmPromote(false);
      void queryClient.invalidateQueries({ queryKey: ['declared-fields'] });
    },
  });

  if (!session) return null;

  const fields = fieldsQuery.data?.fields ?? [];
  const keyValid = KEY_PATTERN.test(key);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border p-3">
        <span className="text-sm font-semibold">Declared Fields</span>
        <div className="flex items-center gap-2">
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
      </div>
      {promote.isError && (
        <p className="px-3 pt-2 text-xs text-red-600">{promote.error?.message}</p>
      )}
      <ScrollArea className="min-h-0 flex-1 p-3">
        {fieldsQuery.data && fields.length === 0 ? (
          <EmptyState message="No declared fields yet" />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="px-3 py-2">Key</th>
                <th className="px-3 py-2">Label</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Declared</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => (
                <DeclaredFieldRow key={field.id} token={session.token} field={field} />
              ))}
            </tbody>
          </table>
        )}
      </ScrollArea>
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

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm --filter @support/web exec vitest run DeclaredFields.test.tsx`

Expected: PASS, all three cases.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/DeclaredFields/DeclaredFields.tsx frontend/src/surfaces/agent-console/pages/DeclaredFields/DeclaredFields.test.tsx
git commit -m "Add DeclaredFields page: list, promote form, confirm-gated"
```

---

### Task 10: Nav item, route, and preload wiring

**Files:**
- Modify: `frontend/src/surfaces/agent-console/lib/routePreload.ts`
- Modify: `frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx`
- Modify: `frontend/src/routes/AppRoutes.tsx`

**Interfaces:**
- Consumes: `DeclaredFields` (Task 9), `isAdmin`/`canBuildForms` (`../lib/agentSession.ts`, already defined — `isAdmin` returns true only for `session.role === 'admin'` or an undefined role), `RequireRole` (`../components/RequireRole.tsx`)
- Produces: nav link + route at `/declared-fields`, reachable only when `isAdmin(session)` is true, both client-side (nav hidden, route redirects to `/inbox`) — the real enforcement is the Task 5 `requireAdminRole` middleware.

- [ ] **Step 1: Add the lazy importer**

In `frontend/src/surfaces/agent-console/lib/routePreload.ts`, add after `importWorkspaceSettings`:

```ts
export const importDeclaredFields = () =>
  import('../pages/DeclaredFields/DeclaredFields.tsx');
```

Add to the `agentRoutePreload` map, after `'/workspace-settings': importWorkspaceSettings,`:

```ts
  '/declared-fields': importDeclaredFields,
```

- [ ] **Step 2: Add the nav item in `AgentConsoleShell.tsx`**

Add `Layers` to the `lucide-react` import list at the top (alongside `Gauge`, `SlidersHorizontal`, etc.):

```ts
  Layers,
```

Change the `agentSession.ts` import line from:

```ts
import {
  canBuildForms,
  clearAgentSession,
  loadAgentSession,
  saveAgentSession,
  saveLastActiveWorkspaceId,
} from '../lib/agentSession.ts';
```

to:

```ts
import {
  canBuildForms,
  clearAgentSession,
  isAdmin,
  loadAgentSession,
  saveAgentSession,
  saveLastActiveWorkspaceId,
} from '../lib/agentSession.ts';
```

After the `WORKSPACE_SETTINGS_NAV_ITEM` constant, add:

```ts
// Admin-only — unlike every other item in the Manage group, which is Team
// Lead + Admin. The API enforces this with requireAdminRole regardless of
// what this nav shows; see declaredFieldRouter.ts.
const DECLARED_FIELDS_NAV_ITEM = {
  to: '/declared-fields',
  label: 'Declared Fields',
  icon: Layers,
  group: 'Manage',
};
```

Change the `navItems` construction from:

```ts
  const navItems = canBuildForms(session)
    ? [
        ...NAV_ITEMS,
        FORMS_NAV_ITEM,
        WORKLOAD_NAV_ITEM,
        BOT_CONFIG_NAV_ITEM,
        WORKSPACE_SETTINGS_NAV_ITEM,
      ]
    : NAV_ITEMS;
```

to:

```ts
  const navItems = canBuildForms(session)
    ? [
        ...NAV_ITEMS,
        FORMS_NAV_ITEM,
        WORKLOAD_NAV_ITEM,
        BOT_CONFIG_NAV_ITEM,
        WORKSPACE_SETTINGS_NAV_ITEM,
        ...(isAdmin(session) ? [DECLARED_FIELDS_NAV_ITEM] : []),
      ]
    : NAV_ITEMS;
```

(`isAdmin(session) === true` always implies `canBuildForms(session) === true`, since `canBuildForms` already accepts `'admin'` — so nesting the admin check inside the `canBuildForms` branch is correct and never silently hides the tab from a real admin.)

- [ ] **Step 3: Add the route in `AppRoutes.tsx`**

Change the `agentSession.ts` import:

```ts
import { canBuildForms } from '../surfaces/agent-console/lib/agentSession.ts';
```

to:

```ts
import { canBuildForms, isAdmin } from '../surfaces/agent-console/lib/agentSession.ts';
```

Add `importDeclaredFields` to the `routePreload.ts` import block:

```ts
import {
  importBotConfig,
  importDeclaredFields,
  importForms,
  importGlobalInbox,
  importInbox,
  importKnowledgeBase,
  importTaxonomy,
  importTickets,
  importWorkload,
  importWorkspaceSettings,
} from '../surfaces/agent-console/lib/routePreload.ts';
```

Add the lazy component definition after `WorkspaceSettingsPage`:

```ts
const DeclaredFieldsPage = lazy(async () => ({
  default: (await importDeclaredFields()).DeclaredFields,
}));
```

Add the route after the `workspace-settings` route, before `<Route path="*" element={<AgentNotFound />} />`:

```tsx
        <Route
          path="declared-fields"
          element={
            <RequireRole allow={isAdmin}>
              <DeclaredFieldsPage />
            </RequireRole>
          }
        />
```

- [ ] **Step 4: Typecheck and manually verify**

Run: `pnpm --filter @support/web typecheck`

Then run the dev server and log in as an admin session vs. a non-admin session (or check `docs/project-overview.md` / existing dev-login flow for how to switch roles), confirming:
- Admin: "Declared Fields" appears in the Manage nav group, `/declared-fields` renders the page.
- Team lead / agent: no "Declared Fields" nav item, and navigating to `/declared-fields` directly redirects to `/inbox`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/lib/routePreload.ts frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx frontend/src/routes/AppRoutes.tsx
git commit -m "Wire Declared Fields tab into nav, routing, and preload"
```

---

### Task 11: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend suite**

Run: `pnpm --filter @support/api test`

Expected: all pass, including the new `agent.declaredFields.test.ts` and every pre-existing suite (confirms nothing in `router.ts`/`openapi.ts`/schema changes broke another route).

- [ ] **Step 2: Run the full frontend suite**

Run: `pnpm --filter @support/web test`

Expected: all pass, including `DeclaredFieldRow.test.tsx`, `DeclaredFields.test.tsx`, and the pre-existing `RequireRole.test.tsx` (unaffected, but confirms the shared component still behaves).

- [ ] **Step 3: Run full-repo typecheck**

Run: `pnpm typecheck`

Expected: no errors across `backend`, `frontend`, and `packages/types`.

- [ ] **Step 4: Manual smoke test**

Start `pnpm dev`, log in as an admin, and walk the golden path end to end:
1. Open the "Declared Fields" tab — confirm the 11 seeded fields (`player_id`, `client_version`, etc. — see `DECLARED_FIELD_SEED` in `packages/types/src/player-state.ts`) are listed.
2. Promote a new field (e.g. `key: test_flag`, `label: Test flag`, `type: boolean`) — confirm the dialog appears, confirm it, and the row appears in the table.
3. Edit that row's label — confirm the dialog appears, confirm it, and the label updates.
4. Archive that row — confirm the dialog appears, confirm it, and the row disappears from the list.
5. Re-promote the same key (`test_flag`) — confirm it reappears (revive path) rather than erroring.
6. Log in as a team lead or plain agent — confirm the tab is absent and `/declared-fields` redirects to `/inbox`.

No commit for this task — it's verification of everything already committed in Tasks 1–10.
