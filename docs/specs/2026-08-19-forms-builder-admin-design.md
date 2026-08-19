# Forms builder — admin design

**Date:** 2026-08-19
**Status:** Proposed
**Scope:** Admin UI + API for creating, editing, versioning, publishing, archiving forms and
mapping them to subintents. No schema changes.

---

## What this slice is

The admin-facing "Forms" tab described in `Docs/Customer Support Tool - CRM v2.txt`
("Bot settings · Forms") — the screen support uses to build the structured questions the bot
shows before handing a conversation to an agent.

This is the piece the 2026-08-11 data-model spec explicitly deferred: *"The admin form-builder UI
and its authoring workflow. Nothing in this slice mints a `form_version` row or bumps a version."*
That gap is what this spec closes. Everything the bot reads at runtime — `resolveSubintentForm`,
the player-side form card, the agent context rail (forms slices 1–3) — already exists and is
correct against the data model as written. This slice only adds the authoring surface on top of it.

### In scope

- `formsRouter` / `formsController` / `formsService` — list, create, read, edit, publish, archive
  a form; map a form to a set of subintents.
- One additive field on the existing intents/subintents read (`GET /agent/intents`): each
  subintent gains `formId` and `archivedAt`.
- The admin frontend page: a standalone route (`/forms`) with a form list and an editor sheet.

### Out of scope — named so nobody wonders

- **The Bot Settings four-tab shell** (Prompt / Rules / Forms / Knowledge). This ships as a
  standalone page today, matching how `KnowledgeBase.tsx` is standalone. When the shell is built,
  this becomes its Forms tab — a routing change, not a rework.
- **Form deletion.** Matches the doc's taxonomy rule applied to forms: not permitted, archive
  instead.
- **Any change to `resolveSubintentForm`, the player-side form card, or the agent context rail.**
  All three already read this data model correctly.
- **The `attachment` field type as a working answer type.** It stays declared-but-inert
  (`packages/types/src/forms.ts`) until the `attachment` table exists; the builder must not offer
  it.
- **The `time` field type.** Declared in the enum, but per the existing amendment note it "must
  never be offered by the form-builder or used by a seeded form."
- **Drag-and-drop field reordering.** No DnD library is installed in `frontend/package.json`. Up/down
  move buttons cover the same requirement (`position` is just an integer) without adding a
  dependency for one screen.

---

## Backend

### Routes — `backend/src/agent/routers/formsRouter.ts`

Same shape as `taxonomyRouter.ts`: `requireWorkspaceRole` gates reads and drafting, `requireAdminRole`
gates the two irreversible-ish actions.

```ts
const canBuildForms = requireWorkspaceRole('team_lead', 'admin')

formsRouter.get('/forms', canBuildForms, listFormsHandler)
formsRouter.post('/forms', canBuildForms, createFormHandler)
formsRouter.get('/forms/:id', canBuildForms, getFormHandler)
formsRouter.patch('/forms/:id', canBuildForms, updateFormHandler)
formsRouter.post('/forms/:id/publish', requireAdminRole, publishFormHandler)
formsRouter.post('/forms/:id/archive', requireAdminRole, archiveFormHandler)
formsRouter.patch('/forms/:id/subintents', canBuildForms, setFormSubintentsHandler)
```

This mirrors the doc's permission matrix exactly:

| Action | Team Lead | Admin |
|---|---|---|
| Build or edit a draft | ✓ | ✓ |
| Map forms to subintents | ✓ | ✓ |
| Publish a form | · | ✓ |
| Archive a form | · | ✓ |

`PATCH` is used (not `POST`) for edit/mapping since these mutate an existing resource — this
diverges from `botConfigRouter`'s POST-only note (that one was about the CORS allowlist for the
*console's save button specifically*; these are still same-origin console calls, and every other
admin route pattern in this repo — `taxonomyRouter`'s `POST` aside — doesn't yet establish a PATCH
precedent, so confirm CORS allows PATCH before implementing, and fall back to POST-with-verb-suffix
if it does not).

### Service — `backend/src/agent/services/formsService.ts`

**`listForms(ctx)`** — one row per form:
```ts
{
  id, name, archivedAt, createdAt,
  mappedSubintentCount: number,
  publishedVersion: number | null,   // highest version with published_at set, or null
  hasDraft: boolean,                 // a version exists with published_at IS NULL
}
```

**`createForm(ctx, name)`** — inserts `form`, then inserts `formVersion` v1 with `fields: []`,
`publishedAt: null`. One transaction. Returns the form id and its draft version id.

**`getForm(ctx, formId)`** — form row + its draft version's fields (if any) + its current
published version's fields and number (if any) + the list of subintents currently mapped to it
(id, name, intentId).

**`updateForm(ctx, formId, { name?, fields? })`** — the auto-fork rule:

1. Load the form's versions, find the highest `version`.
2. If that version has `publishedAt IS NULL` (a draft already exists), update its `fields` in
   place — never touch `publishedAt` here.
3. If that version is published (or none exists, which cannot happen post-`createForm`), insert a
   new `formVersion` row at `version + 1`, `publishedAt: null`, seeded from the caller's `fields`
   (or from the published version's fields if the caller only sent `name`).
4. `name` changes always update the `form` row directly — the form's name is not versioned, only
   its fields are.
5. Validate `fields` with `formFieldsSchema` from `@support/types` before any write. Reject if it
   contains `attachment` or `time` — the builder-level exclusion that the schema alone does not
   enforce (the schema permits both; this is a service-layer policy check, same shape as the
   "no hard-coded subintent in the default prompt" assertion elsewhere in the bot code).

This makes "editing a live form creates v4, old submissions still render against v3" (the doc's own
phrasing) happen with no explicit "new version" step from the admin — matching the original
wireframe, which shows only Save and Publish, never a version-bump control.

**`publishForm(ctx, formId)`** — finds the current draft (`publishedAt IS NULL`), validates its
`fields` with `publishedFormFieldsSchema` (non-empty), sets `publishedAt = now()`,
`publishedBy = ctx.agentId`. Rejects with a named error if there is no draft (nothing to publish)
or the draft is empty.

**`archiveForm(ctx, formId)`** — sets `form.archivedAt = now()`. No cascade to `subintent.formId` —
`resolveSubintentForm`'s existing three-condition check (`formId IS NOT NULL`, `archivedAt IS NULL`,
has a published version) already treats an archived form as "no form" for every subintent still
pointing at it. This is deliberate: unmapping every subintent on archive would erase a mapping the
admin might restore later (there is no "unarchive" in this slice, matching taxonomy's archive being
one-way, so the mapping is left intact and inert rather than destroyed).

**`setFormSubintents(ctx, formId, subintentIds)`** — in one transaction:
1. Scoped `SELECT` to confirm every id in `subintentIds` belongs to this workspace and is not
   archived (client-supplied ids, so this pre-verification is mandatory per the FK-bypasses-RLS
   rule — same reasoning as the composite-FK ADR).
2. `UPDATE subintent SET form_id = NULL WHERE form_id = :formId AND id NOT IN (:subintentIds)`.
3. `UPDATE subintent SET form_id = :formId WHERE id IN (:subintentIds)`.

This makes the "shown for" chip list in the wireframe a full set-replacement call, which is simpler
to reason about from the UI than incremental add/remove calls, and gives one atomic point where "a
subintent can only map to one form" is trivially true — step 3 just overwrites whatever it pointed
to before.

### Read-path addition — `taxonomyService.listIntents`

`subintent`'s select gains two columns:

```ts
.select({ id: subintent.id, name: subintent.name, intentId: subintent.intentId,
          formId: subintent.formId, archivedAt: subintent.archivedAt })
```

Additive on `IntentsResponse` — existing consumers (none exist yet outside the console) are
unaffected. The builder uses `formId` to pre-select a form's mapped subintents and `archivedAt` to
exclude archived ones from the picker.

### Audit

Per `CLAUDE.md`'s "all state changes go through one function... never ad-hoc updates" and the
existing `change_log` table: form create/edit/publish/archive and subintent-mapping changes are
**not** wired into `change_log` in this slice. `change_log`'s only current writer is `bot_config`,
and the 2026-08-11 spec explicitly named "audit writers other than `bot_config`" as future work with
no schema change required to add them. Wiring forms into it is a natural follow-up, not required
for this slice to be usable, and is called out here so it isn't silently assumed done.

### OpenAPI

Every new route registered in `backend/src/docs/openapi.ts`, per `CLAUDE.md`.

---

## Frontend

### Route

`frontend/src/routes/AppRoutes.tsx` gains a lazy route, same pattern as `KnowledgeBase`:

```tsx
const Forms = lazy(async () => ({
  default: (await import('../surfaces/agent-console/pages/Forms/Forms.tsx')).Forms,
}))
...
<Route path="forms" element={<Forms />} />
<Route path="forms/:id" element={<Forms />} />
```

Nav entry visible only to Team Lead and Admin — Agents get no link (the API would 403 them anyway;
hiding the link is UX, not the enforcement point, per the existing "checks run at the API" rule).

### `pages/Forms/Forms.tsx`

Structured exactly like `KnowledgeBase.tsx`: a list (`FormTable.tsx`) on the left/main area, an
editor (`FormEditorSheet.tsx`) opened as a `Sheet`, deep-linkable via `/forms/:id`.

### `components/FormTable.tsx`

Columns: Name, Shown for (subintent chips, "+N" overflow), Status (`Published v{n}` /
`Draft` / `Published v{n} · draft pending` / `Archived`), actions menu (Archive, if Admin).
"New" button opens the sheet with `formId = null`.

### `components/FormEditorSheet.tsx`

- Name (`Input`).
- Field list: each row shows label, type badge, required toggle, up/down buttons, remove (✕).
  "Add a field" opens a type picker limited to the 5 allowed types.
- Field detail (inline or a small popover per row, following `ArticleEditorSheet`'s inline-form
  style rather than a nested modal): label, type (fixed once added — changing type after creation
  would orphan existing option/format assumptions, so type change requires remove-and-re-add),
  required toggle, placeholder, helper text, and — only for `choice` — an options list editor
  (min 2, matching `formFieldSchema`).
- Fixed, non-editable row at the bottom: "Skip and talk to an agent" — styled to look present but
  disabled/greyed, per the doc's "cannot be removed."
- "Shown for" — a multi-select (`Select` with checkboxes, or a simple chip-add list) over
  non-archived subintents from `GET /agent/intents`, pre-populated from `formId` matches.
- Footer buttons: **Save** (calls `PATCH /forms/:id`, or `POST /forms` then `PATCH .../subintents`
  for a brand-new form), **Publish** (calls `POST /forms/:id/publish`; hidden/disabled for
  non-Admins and disabled when there's no draft or the draft has zero fields), **Archive**
  (Admin-only, confirm dialog).

Client-side validation mirrors `formFieldsSchema` before the API call fires (duplicate keys,
`choice` needing ≥2 options, non-`choice` types rejecting `options`) so the admin sees the error
inline rather than round-tripping to the server for something Zod already expresses — same pattern
`articleForm.ts`'s `canEditFields`/`canPublish` establish for articles.

### `api/agentApi.ts` additions

`fetchForms`, `fetchForm`, `createForm`, `updateForm`, `publishForm`, `archiveForm`,
`setFormSubintents` — same fetch-wrapper shape as the existing `fetchArticle`/`updateArticle`/etc.

---

## Field type picker — final list

Five types, matching `formFieldSchema`'s allowed set minus the two excluded here:

| Type | Options editor shown? |
|---|---|
| `short_text` | no |
| `long_text` | no |
| `number` | no |
| `date` | no |
| `choice` | yes, ≥2 options |

`attachment` and `time` are declared in `FORM_FIELD_TYPES` but never appear in this picker.

---

## Verification

- **Service tests** (`backend/tests/formsAdmin.test.ts`, new): auto-fork happens only when the
  latest version is published; editing an existing draft never creates a second draft; publish
  rejects an empty draft; publish rejects when no draft exists; archive is idempotent
  (archiving twice doesn't error); `setFormSubintents` correctly clears the old mapping and
  rejects a cross-workspace subintent id; a subintent never ends up mapped to two forms.
- **RLS/tenancy**: extend the existing cross-tenant probes — a form id from workspace B is
  invisible to workspace A's `GET /forms/:id`, and `setFormSubintents` rejects a subintent id from
  another workspace even though the FK on `subintent.formId` would bypass RLS on the write itself
  (this is exactly the client-supplied-id vector the composite-FK ADR calls out).
- **Permission tests**: an Agent role gets 403 on every route in this router; a Team Lead gets 403
  on `publish` and `archive` specifically, 200 on everything else.
- **Frontend tests**: `formFieldsSchema`-equivalent client validation rejects the same cases the
  shared schema does (existing `formFieldsSchema` test coverage in `packages/types` is the source
  of truth; the frontend guard is a subset, tested the way `articleForm.test.ts` tests
  `canEditFields`/`canPublish`).
- **Manual verification**: create a form, publish it, map it to a subintent, trigger the bot
  handoff for that subintent in the webview, confirm the published fields (not a later unpublished
  edit) are what the player sees — then edit the published form's fields and confirm the change
  does *not* retroactively alter the in-flight submission's rendering in the agent context rail.
