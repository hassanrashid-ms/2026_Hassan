# Declared Fields — Lock Seeded Rows Except Label

## Problem

`updateDeclaredField` (`backend/src/agent/services/declaredFieldService.ts`) currently lets
an admin edit both `label` and `type` on any `declared_field` row, seeded or promoted. The
UI mirrors this: `DeclaredFieldRow.tsx` renders a `type` select in the edit form for every
row (`TYPES` select, `DeclaredFieldRow.tsx:22,84-99`).

That's a problem specifically for the eleven seeded rows (`player_id`, `client_version`,
`platform`, `os_version`, `device_model`, `locale`, `player_level`, `total_spend`,
`spend_tier`, `account_created_at`, `last_session_at` — `packages/types/src/player-state.ts`
`DECLARED_FIELD_SEED`). `type` (and `label`) are looked up **live** from `declared_field`
every time a conversation's player-state panel renders (`conversationContextService.ts`
`getPlayerStateView`, lines 108-162) — the stored `player_state_snapshot.declared` jsonb
holds only `{ key: value }`, never the field's type. So editing a seeded field's `type`
retroactively changes how every already-captured historical snapshot is labeled and typed,
with no way to tell which interpretation a given snapshot was actually written under.

Locking `type` (and any future non-`label` property) on seeded rows removes that drift.
Fields an admin promotes later have no history to protect and stay fully editable, matching
`docs/specs/2026-08-27-declared-fields-admin-tab-design.md`'s existing edit contract for
those rows.

## What counts as "seeded"

No schema change. `declaredBy` is already nullable specifically because "the eleven seeded
rows have no human actor" (`backend/src/shared/db/schema/playerState.ts:38`), and every
admin-driven create — both fresh promotion and the revive-on-conflict path — sets
`declaredBy = ctx.agentId` (`declaredFieldService.ts` `createDeclaredField`). So
`declaredBy IS NULL` already means exactly "seeded, never touched by a promote/revive," with
no migration required.

**`isSeeded = declaredField.declaredBy === null`** is the single predicate this whole change
keys off, computed the same way on both the backend guard and the frontend disable.

Edge case: if a seeded row is later archived and re-promoted through `createDeclaredField`'s
revive path, that sets `declaredBy` to the reviving admin — the row stops being "seeded" and
becomes fully editable from then on. That's correct: revival already discards the old
identity's history-freezing guarantee (the field goes back through active promotion), so
there's no reason to keep it locked.

## Scope

- Backend: `updateDeclaredField` rejects a `type` change (not just ignores it — a rejected
  request should surface, not silently no-op) when the target row's `declaredBy IS NULL`.
  `label` edits on seeded rows continue to work unchanged.
- Frontend: `DeclaredFieldRow.tsx`'s edit form disables the `type` select (visibly, not just
  on submit) when the row is seeded, and always allows the `label` input.
- No change to `create`, `deactivate`, `reactivate`, or `archive` — those already operate on
  identity/lifecycle, not the taxonomy fields this spec locks.

Out of scope: adding an explicit `isSystem` column, changing how snapshots are split or
displayed, backfilling any historical data, changing seeded `key` values (already immutable
for every row per the existing spec).

## Backend

`backend/src/agent/services/declaredFieldService.ts`, `updateDeclaredField`:

- Before applying the patch, if `patch.type !== undefined` and the existing row has
  `declaredBy === null`, throw the same shape of domain error the service already uses for
  its other update-time rejections (404 on `archived` is the existing precedent — this is a
  sibling validation error, not a 404; use a `400`/`ValidationError`-style rejection
  consistent with how `declaredFieldController.ts` surfaces Zod failures today, e.g.
  `SeededFieldTypeLockedError` mapped to `409` or `400` in the controller's catch — match
  whatever this service's existing error convention is for "the request was well-formed but
  not allowed").
- `label` changes are unaffected — they apply regardless of `declaredBy`.
- No change to `createDeclaredField`, `deactivateDeclaredField`, `reactivateDeclaredField`,
  `archiveDeclaredField`.

`backend/src/agent/controllers/declaredFieldController.ts`: no new Zod validation needed —
`type` stays optional on the PATCH body as it is today; the new rule is an authorization/
business-rule check inside the service, not a shape check.

## Frontend

`frontend/src/surfaces/agent-console/pages/DeclaredFields/components/DeclaredFieldRow.tsx`:

- Compute `isSeeded = row.declaredBy == null` (the list response already carries
  `declaredBy` per the existing table read).
- Edit form: `label` input stays as-is. The `type` select (`TYPES` select,
  `DeclaredFieldRow.tsx:22,84-99`) gets `disabled={isSeeded}`, with the existing value still
  shown (not blanked) so the row communicates "this is what it is" rather than "unset."
- Add a short inline hint next to the disabled `type` select on seeded rows (e.g. "Type is
  locked for built-in fields") so the disabled control doesn't read as a bug.
- No change to the promote-new-field form — new fields are never seeded, `type` stays
  editable there.

## Testing

- Backend: service-level test that `updateDeclaredField` on a seeded row (`declaredBy:
  null`) rejects a `type`-only patch and a combined `label`+`type` patch, but accepts a
  `label`-only patch; a parallel test that the same patches all succeed on a
  promoted/reviveable row (`declaredBy` set).
- Frontend: component test that `DeclaredFieldRow`'s `type` select is `disabled` for a row
  with `declaredBy: null` and enabled otherwise, and that submitting the edit form on a
  seeded row with `label` changed (but `type` untouched) still calls the update mutation.
