# Declared Fields Admin Tab — Design

## Problem

`declared_field` (`backend/src/shared/db/schema/playerState.ts`) is the admin-promoted key
set that `splitSnapshot` (`backend/src/shared/playerState/split.ts`) uses to route each SDK
player-state snapshot into `declared` vs `raw`. Promotion is currently only possible by
editing `backend/src/shared/db/seed.ts` and re-seeding — there is no API and no UI. This adds
both, behind a new admin-only tab.

Per `docs/specs/2026-08-04-database-and-schema-design.md`: the split happens **at write
time** against whatever `declared_field` rows exist at that moment, and is never
retroactive. This design does not change that contract — it only adds a way to manage the
rows through the console instead of a seed edit.

## Scope

- View existing declared fields (key, label, type, declared at/by, status)
- Promote a new key to declared (free-text key/label/type entry — no picker over observed
  `raw` keys)
- Edit an existing field's `label` and `type`. **`key` is immutable after creation** — it's
  the identity `splitSnapshot` matches against; changing it would silently orphan the
  history tied to the old key.
- **Three statuses, not a boolean**: `active`, `inactive`, `archived`.
  - `active` — live. `loadDeclaredKeys` includes it; the split routes this key into
    `declared`.
  - `inactive` — paused. Excluded from `loadDeclaredKeys` (routes back to `raw`), but
    **still shown in the list**, greyed out, with a one-click **Reactivate** button. This
    is the toggle for "stop using this key without losing it from view" — e.g. a field
    the game stopped sending, kept visible so an admin remembers it exists.
  - `archived` — soft-removed. Excluded from `loadDeclaredKeys`, and **hidden from the
    list entirely**. No unarchive button — matches the existing `articlesRouter` /
    `taxonomyRouter` / `formsRouter` archive endpoints, none of which offer one either.
    The only way back is re-promoting the same key (see Backend below), same as before.
- No hard delete, ever, for any status — same rule every other entity in this repo follows
  (`CLAUDE.md`: "No hard deletes anywhere. Don't even write the route.").
- Confirmation modal before every mutation: promote, edit, deactivate, reactivate, archive.

Out of scope: deleting a row outright, any change to how `splitSnapshot`/`loadDeclaredKeys`
themselves work beyond filtering on the new `status` column.

## Schema change

Add one enum column to `declared_field`, replacing the plain boolean this spec originally
called for:

```ts
export const declaredFieldStatus = pgEnum('declared_field_status', [
  'active',
  'inactive',
  'archived',
]);
```

```ts
status: declaredFieldStatus('status').notNull().default('active'),
```

`loadDeclaredKeys` (`backend/src/shared/playerState/declaredKeys.ts`) filters to
`status = 'active'` — an inactive or archived key's future snapshots fall back into `raw`.
Snapshots already written keep whatever split they got at write time; nothing is backfilled,
consistent with the rest of this feature.

Migration via `pnpm db:generate`, committed as usual.

## Backend

New files, mirroring `taxonomyRouter.ts` / `taxonomyController.ts` / `taxonomyService.ts`:

- `backend/src/shared/db/schema/playerState.ts` — add `declaredFieldStatus` enum + `status`
  column to `declaredField`
- `backend/src/agent/services/declaredFieldService.ts`
  - `listDeclaredFields(ctx)` — `active` + `inactive` rows only (never `archived`), key
    ascending
  - `createDeclaredField(ctx, { key, label, type })` — `declaredBy = ctx.agentId`,
    `status: 'active'`. If a row for this `(workspaceId, key)` already exists: `active` →
    `409 key_taken`; `inactive` or `archived` → revive it in place (update label/type/
    declaredBy/declaredAt, flip `status` to `'active'`) instead of inserting a duplicate,
    which would otherwise hit `declared_field_workspace_key_uk`
  - `updateDeclaredField(ctx, id, { label, type })` — label/type only, `key` never accepted;
    operates on `active` or `inactive` rows, 404s on `archived`
  - `deactivateDeclaredField(ctx, id)` — `active` → `inactive`; 404 if not currently `active`
  - `reactivateDeclaredField(ctx, id)` — `inactive` → `active`; 404 if not currently
    `inactive` (an `archived` row is not reactivatable this way — re-promote instead)
  - `archiveDeclaredField(ctx, id)` — `active` or `inactive` → `archived`
- `backend/src/agent/controllers/declaredFieldController.ts` — Zod validation:
  - `key`: `^[a-z0-9_]+$`, required on create, rejected on update
  - `label`: non-empty string
  - `type`: one of the existing `declared_field_type` enum values (`string`, `number`,
    `boolean`, `timestamp`)
- `backend/src/agent/routers/declaredFieldRouter.ts`:
  ```
  GET   /agent/declared-fields               requireAdminRole
  POST  /agent/declared-fields               requireAdminRole
  PATCH /agent/declared-fields/:id           requireAdminRole
  POST  /agent/declared-fields/:id/deactivate requireAdminRole
  POST  /agent/declared-fields/:id/reactivate requireAdminRole
  POST  /agent/declared-fields/:id/archive   requireAdminRole
  ```
  All six admin-only (global `agent.isAdmin`, via `requireAdminRole`) — unlike
  `workspaceSettingsRouter`'s team-lead-can-read split, every operation here is gated the
  same way, matching the "(admin only)" tab requirement.
- Register the router in the agent app composition (alongside `taxonomyRouter` etc.) and add
  all six routes + Zod schemas to `backend/src/docs/openapi.ts` per the CLAUDE.md rule.

## Frontend

- `frontend/src/surfaces/agent-console/pages/DeclaredFields/DeclaredFields.tsx`
  - Table: key, label, type, status badge, declared at, declared by
  - Row actions depend on status:
    - `active`: Edit, Deactivate, Archive ("×")
    - `inactive` (greyed out): Edit, Reactivate, Archive ("×")
  - Small inline "Promote field" form above the table (key / label / type inputs + button),
    same visual pattern as `Taxonomy.tsx`'s "+ Add intent" row
  - Confirmation modal (reuse `components/ConfirmDialog.tsx`, already used in
    `admin-console`) before promote, edit, deactivate, reactivate, and archive submit
  - Archived fields drop out of the list entirely (`GET` only returns `active` +
    `inactive` rows) — no "show archived" toggle in v1
- `frontend/src/surfaces/agent-console/api/agentApi.ts` — add `fetchDeclaredFields`,
  `createDeclaredField`, `updateDeclaredField`, `deactivateDeclaredField`,
  `reactivateDeclaredField`, `archiveDeclaredField`
- `frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx` — new
  `DECLARED_FIELDS_NAV_ITEM` in the `Manage` group, gated by `isAdmin(session)` (not
  `canBuildForms` — this tab is admin-only, the others in that group are team-lead+admin)
- `frontend/src/routes/AppRoutes.tsx` — `/declared-fields` route wrapped in
  `<RequireRole allow={isAdmin}>`, lazy-loaded like the other tabs
- `frontend/src/surfaces/agent-console/lib/routePreload.ts` — add
  `importDeclaredFields`, wired to the nav item's hover/focus preload like the rest

## Testing

- Backend: service-level tests for create (dup-key 409 when `active`, revive when
  `inactive`/`archived`), update (key rejected/ignored on the request body, 404 on
  `archived`), deactivate/reactivate (status transitions, 404 on the wrong starting state,
  `loadDeclaredKeys` excludes anything not `active`), archive (row survives, `status`
  becomes `archived`, drops out of `GET`), and an integration test that a non-admin (team
  lead) gets `403` on all six routes.
- Frontend: component test that the nav item and route are hidden/redirect for a
  non-admin session, that row actions match the row's status (Deactivate vs Reactivate),
  and that the confirm modal gates each mutation (mutation fn not called until confirmed).
