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

- View existing declared fields (key, label, type, declared at/by, active state)
- Promote a new key to declared (free-text key/label/type entry — no picker over observed
  `raw` keys)
- Edit an existing field's `label` and `type`. **`key` is immutable after creation** — it's
  the identity `splitSnapshot` matches against; changing it would silently orphan the
  history tied to the old key.
- Archive a field (soft-remove: `active = false`). No hard delete, no route for one — same
  rule every other entity in this repo follows (`CLAUDE.md`: "No hard deletes anywhere.
  Don't even write the route.").
- No unarchive/reactivate in v1 — matches the existing `articlesRouter` /
  `taxonomyRouter` / `formsRouter` archive endpoints, none of which offer one either.
- Confirmation modal before every mutation: promote, edit, archive.

Out of scope: reactivating an archived field, deleting a row outright, any change to how
`splitSnapshot`/`loadDeclaredKeys` themselves work beyond filtering on the new `active`
column.

## Schema change

Add one column to `declared_field`:

```ts
active: boolean('active').notNull().default(true),
```

`loadDeclaredKeys` (`backend/src/shared/playerState/declaredKeys.ts`) filters to
`active = true` — an archived key's future snapshots fall back into `raw`. Snapshots already
written keep whatever split they got at write time; nothing is backfilled, consistent with
the rest of this feature.

Migration via `pnpm db:generate`, committed as usual.

## Backend

New files, mirroring `taxonomyRouter.ts` / `taxonomyController.ts` / `taxonomyService.ts`:

- `backend/src/shared/db/schema/playerState.ts` — add `active` column to `declaredField`
- `backend/src/agent/services/declaredFieldService.ts`
  - `listDeclaredFields(ctx)` — active rows only, newest first
  - `createDeclaredField(ctx, { key, label, type })` — `declaredBy = ctx.agentId`,
    `active: true`; `onConflict` on `(workspaceId, key)` → `409`
  - `updateDeclaredField(ctx, id, { label, type })` — label/type only, `key` never accepted
  - `archiveDeclaredField(ctx, id)` — sets `active = false`
- `backend/src/agent/controllers/declaredFieldController.ts` — Zod validation:
  - `key`: `^[a-z0-9_]+$`, required on create, rejected on update
  - `label`: non-empty string
  - `type`: one of the existing `declared_field_type` enum values (`string`, `number`,
    `boolean`, `timestamp`)
- `backend/src/agent/routers/declaredFieldRouter.ts`:
  ```
  GET   /agent/declared-fields            requireAdminRole
  POST  /agent/declared-fields            requireAdminRole
  PATCH /agent/declared-fields/:id        requireAdminRole
  POST  /agent/declared-fields/:id/archive requireAdminRole
  ```
  All four admin-only (global `agent.isAdmin`, via `requireAdminRole`) — unlike
  `workspaceSettingsRouter`'s team-lead-can-read split, every operation here is gated the
  same way, matching the "(admin only)" tab requirement.
- Register the router in the agent app composition (alongside `taxonomyRouter` etc.) and add
  all four routes + Zod schemas to `backend/src/docs/openapi.ts` per the CLAUDE.md rule.

## Frontend

- `frontend/src/surfaces/agent-console/pages/DeclaredFields/DeclaredFields.tsx`
  - Table: key, label, type, declared at, declared by, with an inline edit affordance per
    row (label text, type select) and an archive ("×") button per row
  - Small inline "Promote field" form above the table (key / label / type inputs + button),
    same visual pattern as `Taxonomy.tsx`'s "+ Add intent" row
  - Confirmation modal (reuse `components/ConfirmDialog.tsx`, already used in
    `admin-console`) before promote, edit, and archive submit
  - Archived fields simply drop out of the list (`GET` only returns `active` rows) — no
    "show archived" toggle in v1
- `frontend/src/surfaces/agent-console/api/agentApi.ts` — add `fetchDeclaredFields`,
  `createDeclaredField`, `updateDeclaredField`, `archiveDeclaredField`
- `frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx` — new
  `DECLARED_FIELDS_NAV_ITEM` in the `Manage` group, gated by `isAdmin(session)` (not
  `canBuildForms` — this tab is admin-only, the others in that group are team-lead+admin)
- `frontend/src/routes/AppRoutes.tsx` — `/declared-fields` route wrapped in
  `<RequireRole allow={isAdmin}>`, lazy-loaded like the other tabs
- `frontend/src/surfaces/agent-console/lib/routePreload.ts` — add
  `importDeclaredFields`, wired to the nav item's hover/focus preload like the rest

## Testing

- Backend: service-level tests for create (dup-key 409), update (key rejected/ignored on
  the request body), archive (row survives, `active` flips, `loadDeclaredKeys` excludes it
  afterward), and an integration test that a non-admin (team lead) gets `403` on all four
  routes.
- Frontend: component test that the nav item and route are hidden/redirect for a
  non-admin session, and that the confirm modal gates each mutation (mutation fn not called
  until confirmed).
