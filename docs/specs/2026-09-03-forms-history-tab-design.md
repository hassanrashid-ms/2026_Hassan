# Forms History Tab

## Problem

The Forms admin page (agent-console) has no way to see how a form's fields have
changed over time, or to recover a prior version. `form_version` already stores
every published state as an immutable snapshot, but nothing surfaces it in the UI.

## Goals

- Add a "History" tab to the form detail view listing every version of a form.
- Show a full diff (added/removed/edited fields) between adjacent versions.
- Let an admin restore a prior version's fields into a new draft for review
  before publishing — never publish directly from history.

## Non-goals

- Field-level audit log (who changed which single field mid-draft). `form_version`
  snapshots are the unit of history, same granularity as BotConfig's history tab.
- Restoring a version directly to "published" without a review step.

## Data model

No schema changes. `form_version` (`backend/src/shared/db/schema/forms.ts:40-65`)
already holds one immutable row per version: `version`, `fields` (jsonb array),
`publishedAt`, `publishedBy`. A restore reuses `updateForm`'s existing
fork-a-new-version logic (`formsService.ts:156-199`) to create a new unpublished
version, so restore produces the same shape as any other edit-to-a-published-form.

## Backend

Three new routes on `formsRouter.ts`, same auth as existing form reads
(Team Lead + Admin):

| Method | Path                                   | Behavior                                                                                                                |
| ------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GET    | `/forms/:id/versions`                  | List versions (version, publishedAt, publishedBy→actor, created_at), newest first                                       |
| GET    | `/forms/:id/versions/:version`         | Single version's full field snapshot                                                                                    |
| POST   | `/forms/:id/versions/:version/restore` | Copies that version's `fields[]` into a new unpublished draft version; does not touch `publishedAt` on any existing row |

Restore is a dedicated route rather than reusing `PATCH /forms/:id`, so the
action is explicit and self-documenting server-side rather than looking like an
ordinary field edit.

Register all three in `backend/src/docs/openapi.ts` per repo convention.

## Frontend

Forms currently has no tabbed detail view — `FormEditorSheet` is a single
overlay. Add a `Tabs` strip inside `FormEditorSheet` (same Radix `Tabs` component
BotConfig uses, `frontend/src/surfaces/agent-console/components/ui/tabs.tsx`):
`Fields` (existing editor content, unchanged) and `History`.

New `FormVersionHistoryTab.tsx`, mirroring
`pages/BotConfig/components/VersionHistoryTab.tsx`:

- Lists versions via `fetchFormVersions(token, formId)`. Each row: version
  number, `publishedAt` (or "Draft" if null), publisher's display name, relative
  time.
- Expand-to-diff: fetches version `v` and `v-1` via `fetchFormVersion`, runs a
  new `diffFormFields(prior, current)` util (added / removed / edited-field
  entries — key, label, type changes), same shape as `diffRules` for BotConfig.
- Restore button per row, disabled on the current draft version. Clicking it
  opens a `ConfirmDialog` — **"Restore version N? This replaces the current
  draft with this version's fields."** — and the restore mutation only fires
  from the dialog's `onConfirm`, never from the row button directly. This
  matches BotConfig's rollback confirmation and must not be skipped.
- On confirmed restore: `restoreFormVersion(token, formId, version)` →
  invalidates `['form', formId]` and `['form-versions', formId]` queries →
  switches the tab strip back to `Fields` so the admin immediately sees the
  restored draft.
- New API functions in `agentApi.ts`: `fetchFormVersions`, `fetchFormVersion`,
  `restoreFormVersion`.

## Error handling

Restore mutation error renders inline under the version list, same pattern as
`restore.isError` in `VersionHistoryTab.tsx`. No restore can occur without
passing through the confirm dialog.

## Testing

- Backend: route tests for list/get/restore — auth, 404 on unknown form or
  version, restore creates a new unpublished version with the copied fields,
  and never mutates `publishedAt` on the version being restored or the current
  published version.
- Frontend: `FormVersionHistoryTab.test.tsx` — renders version list, expand
  shows diff, restore button opens the confirm dialog, and the mutation does
  **not** fire until the dialog is confirmed. Unit test for `diffFormFields`.
