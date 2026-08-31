# Move Declared Fields to admin-console

## Problem

"Declared Fields" (promoting raw player-state keys to typed, labeled fields)
currently lives in agent-console, gated by the *workspace-level* admin role
(`requireAdminRole` / `isAdmin(agentSession)`). It's schema-configuration for
the whole workspace, set up once and rarely touched — closer in nature to
admin-console's existing Members/Secret tabs (workspace setup, cross-workspace
platform-admin territory) than to day-to-day agent work. Workspace Settings
(ticket handling tuning) is explicitly **staying** in agent-console — this
move is scoped to Declared Fields only.

## Why this isn't a file move

agent-console and admin-console are two separate auth systems:

- agent-console: a per-workspace agent token. Handlers use
  `withWorkspace(ctx.workspaceId, tx => ...)`, which sets `app.workspace_id`
  and relies on RLS to scope every query to that one workspace.
- admin-console: a platform-admin token (`agent.isAdmin = true`, same
  `agent` table, Google OAuth). Handlers use `adminDb` — a connection that
  **bypasses RLS** (`BYPASSRLS`) — and take an explicit `workspaceId` from the
  route (`/workspaces/:id/...`), filtering every query by it manually, per
  the existing `membersService.ts`/`secretService.ts` pattern.

So this is a genuine port: new backend routes under `/admin`, explicit
workspace-id filtering instead of RLS, and a new frontend surface for the UI
— not a directory rename.

## Backend

**New, added to `admin/services/workspacesService.ts`-adjacent file
`admin/services/declaredFieldsService.ts`:** the same six operations as
today's `agent/services/declaredFieldService.ts` (list, create/promote,
update, deactivate, reactivate, archive), with two changes:
- `ctx: AgentContext` → explicit `workspaceId: string` and `actorId: string`
  params. `actorId` is the calling admin's own `agent.id` — same table,
  same `declaredBy`/change-log actor semantics as before, no schema change.
- `withWorkspace(ctx.workspaceId, tx => ...)` → `adminDb` for reads, and
  `adminDb.transaction(tx => ...)` for writes that pair a mutation with
  `appendChangeLog` (its `Tx` type is structurally identical between `db`
  and `adminDb` — same schema, same driver — so it typechecks unchanged).
  Every query gains an explicit `eq(declaredField.workspaceId, workspaceId)`
  filter, since nothing scopes it automatically anymore.

**New, added to `admin/controllers/`:** `declaredFieldsController.ts` —
same six handlers as today's, reading `workspaceId` from `req.params.id` and
`actorId` from `req.agent!.agentId`.

**Routes:** added directly to `admin/routers/workspacesRouter.ts` (no new
router file — same convention as the existing members/secret sub-resources):
```
GET    /workspaces/:id/declared-fields
POST   /workspaces/:id/declared-fields
PATCH  /workspaces/:id/declared-fields/:fieldId
POST   /workspaces/:id/declared-fields/:fieldId/deactivate
POST   /workspaces/:id/declared-fields/:fieldId/reactivate
POST   /workspaces/:id/declared-fields/:fieldId/archive
```

**Removed:** `agent/routers/declaredFieldRouter.ts`,
`agent/controllers/declaredFieldController.ts`,
`agent/services/declaredFieldService.ts`, and their mount lines in
`agent/router.ts`.

**Tests:** `backend/tests/agent.declaredFields.test.ts` becomes
`backend/tests/admin.declaredFields.test.ts`, rewritten against an admin
session token and the new `/admin/workspaces/:id/declared-fields` paths
(workspace id explicit in the URL, not implied by the token).

**`backend/src/docs/openapi.ts`:** remove the six `/agent/declared-fields...`
entries, add six `/admin/workspaces/{id}/declared-fields...` entries.

## Frontend

**New**, under `surfaces/admin-console/pages/WorkspaceDetail/components/`:
- `DeclaredFieldsPanel.tsx` — port of today's `DeclaredFields.tsx`, rewritten
  against admin-console's own component set (`Table`/`TableRow`/`TableCell`
  instead of a raw `<table>`, matching `MembersTable.tsx`'s existing
  pattern) and `toast.error` for mutation failures (admin-console has no
  inline red-text error convention the way agent-console does — following
  `MembersTable`'s `reportError` helper instead).
- `DeclaredFieldRow.tsx` — port of today's row component, same table-cell
  swap, using admin-console's own `ConfirmDialog`.

**`WorkspaceDetail.tsx`:** add a third tab, `Declared Fields`, alongside
Members and Secret — `<DeclaredFieldsPanel token={session.token}
workspaceId={workspace.id} />`.

**`surfaces/admin-console/api/adminApi.ts`:** add the six functions
(`fetchDeclaredFields`, `createDeclaredField`, `updateDeclaredField`,
`deactivateDeclaredField`, `reactivateDeclaredField`, `archiveDeclaredField`),
each taking `(token, workspaceId, ...)` and calling the new `/admin/...`
paths. Reuses the existing `@support/types` wire types unchanged
(`DeclaredFieldsResponse` etc. are generic, not agent-specific).

**Removed from agent-console:**
- `pages/DeclaredFields/` entirely (`DeclaredFields.tsx` + test,
  `components/DeclaredFieldRow.tsx` + test).
- The six `*DeclaredField*` functions from `agentApi.ts`.
- The nav entry in `AgentConsoleShell.tsx`.
- `importDeclaredFields` and the `/declared-fields` entry in
  `lib/routePreload.ts`.
- The `declared-fields` route (and its now-unused `DeclaredFieldsPage` lazy
  import + `RequireRole allow={isAdmin}` wrapper) in `routes/AppRoutes.tsx`.

## Out of scope

- Workspace Settings stays in agent-console, untouched.
- No schema change — `declared_field.declared_by` still points at an
  `agent.id`; an admin promoting a field is simply a different agent row
  (`isAdmin = true`) in the same column.
- `MembersTable.tsx`'s role-change dialog copy ("They will gain/lose access
  to Forms, Team workload, and Workspace Settings") is unrelated and stays
  as-is.
- No change to who can read/write Workspace Settings, or to its
  `requireAdminRole` gate.

## Testing

- Backend: `backend/tests/admin.declaredFields.test.ts` (moved/rewritten)
  covers the six operations end-to-end against `/admin/workspaces/:id/...`.
  `pnpm test` (needs Postgres up).
- Frontend: moved/rewritten `DeclaredFieldsPanel.test.tsx` and
  `DeclaredFieldRow.test.tsx` under admin-console, mocking `adminApi.ts` and
  an admin session instead of an agent one.
- `pnpm typecheck` across the workspace.
- Manual: log in as a platform admin, open a workspace's detail page, use
  the new Declared Fields tab to promote/edit/deactivate/reactivate/archive
  a field; confirm `/declared-fields` is gone from agent-console's nav and
  routes for every role.
