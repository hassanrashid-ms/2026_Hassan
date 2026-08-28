# Bot Config Versioning — Design

## Problem

`bot_config` changes are already audited field-by-field via the `change_log` table
(append-only, `entityType='bot_config'`, one row per field per save), and the agent
console surfaces this through a `HistoryPanel` embedded in each of the Prompt, Rules,
and Tools tabs. But that panel only shows "who changed this field, when" with a
restore button — no version numbers, and no view of what the change actually was.
There's no single answer to "what does version 3 of this bot look like" or "what
changed between v2 and v3."

## Goal

Give the bot config a real version history: an incrementing version number per
workspace, a single shared History view (not one per field), a diff of what changed
in each version, and full-snapshot restore.

## Non-goals

- Replacing or removing `change_log`. It keeps writing exactly as it does today and
  remains the field-level audit trail behind permission/actor tracking.
- Adding a standalone "Limits" tab. `limits_config` is already editable inside the
  Tools tab ("Conversation limits" section); this project only adds it to version
  snapshots and diffs, no new tab.
- Partial/smart restore. Restoring a version is a full snapshot restore of all four
  fields, recorded as a new version — the same mental model as `git revert`.

## Data model

New table `bot_config_version` (`backend/src/shared/db/schema/audit.ts`), one row per
save, per workspace:

| column          | type                                    | notes                                       |
| --------------- | ---------------------------------------- | -------------------------------------------- |
| `id`            | bigserial PK                             |                                               |
| `workspaceId`   | uuid, FK → workspace                     |                                               |
| `version`       | int                                       | `1, 2, 3...` — unique per `(workspaceId)`    |
| `prompt`        | text                                      | full snapshot, not a diff                    |
| `rules`         | jsonb                                     | full snapshot                                |
| `toolsConfig`   | jsonb                                     | full snapshot                                |
| `limitsConfig`  | jsonb                                     | full snapshot                                |
| `actorId`       | uuid, FK → agent, NOT NULL                | who triggered the save                      |
| `changedFields` | text[]                                    | subset of `prompt`/`rules`/`tools_config`/`limits_config` that differ from the prior version — computed at write time |
| `createdAt`     | timestamptz                              |                                               |

- Append-only: `REVOKE UPDATE, DELETE`, same as `change_log`.
- Indexed on `(workspaceId, version)` unique, plus `(workspaceId, createdAt)` for the
  list view.
- `version` is computed as `MAX(version) + 1` for the workspace, inside the same
  transaction that already writes `bot_config` and `change_log` rows.

## Backend changes

- `saveBotConfig` (`backend/src/domain/bot/botConfig.ts`): after the existing
  `bot_config` update and `appendChangeLog` calls, insert one `bot_config_version` row
  with the post-save full config and the computed `changedFields`. Still one
  transaction, one write path — no new choke point.
- `seedBotConfig` (first-time provisioning) writes `bot_config_version` v1 the same
  way `change_log`'s seed row works today (`changedFields` = all four).
- New endpoint `GET /bot-config/versions` (Team Lead/Admin) — paginated, newest first,
  returns `{ version, actor, createdAt, changedFields }` per row (no full snapshot
  payload in the list — keeps it light).
- New endpoint `GET /bot-config/versions/:version` — returns the full snapshot for
  that version, used to compute a diff client-side against the adjacent version
  (avoids a dedicated diff endpoint; the list already tells the client which two
  versions to fetch and compare).
- `POST /bot-config/rollback` changes shape: body becomes `{ version }` instead of
  `{ field, change_log_id, side }`. Server loads that version's snapshot and calls
  `saveBotConfig` with all four fields — this creates version N+1 (never mutates
  history), and still goes through `appendChangeLog` per field as today.
- Register the new routes' Zod schemas in `backend/src/docs/openapi.ts` per repo
  convention.
- Old `GET /bot-config/history` endpoint and `botConfigService.listBotConfigHistory`
  are removed along with the per-tab `HistoryPanel`s that were their only caller.

## Frontend changes

- `BotConfig.tsx`: add a fourth tab, "History", alongside Prompt/Rules/Tools.
- Remove `HistoryPanel` renders (and the `HistoryPanel` component itself) from
  `PromptTab.tsx`, `RulesTab.tsx`, `ToolsTab.tsx`.
- New `VersionHistoryTab.tsx`:
  - Lists versions newest-first: `v{N}`, actor display name, relative timestamp, and
    a chip per changed field (e.g. "Prompt", "Rules").
  - Expanding a row fetches that version's and the prior version's snapshots and
    renders a type-aware diff:
    - `prompt`: line/word-level text diff (red/green).
    - `rules` / `tools_config` / `limits_config`: structured diff listing
      added/removed/changed entries in plain language (e.g. `Rule "greeting":
      enabled → disabled`, `Tool "search_articles": max_calls 3 → 5`), not raw JSON.
  - "Restore this version" button per row, behind the existing `ConfirmDialog`
    pattern used elsewhere on this page.
  - Empty state (only v1 exists, nothing to compare): "No prior changes."
- `agentApi.ts`: replace `fetchBotConfigHistory`/`rollbackBotConfig` with
  `fetchBotConfigVersions`, `fetchBotConfigVersion`, `rollbackBotConfigVersion`, typed
  against new `@support/types` shapes shared with the backend Zod schemas.

## Testing

- Backend: `saveBotConfig` writes a version row with correct `changedFields` on
  create, update-with-no-actual-change (no-op, mirrors `change_log`'s
  `before IS DISTINCT FROM after` guard — a save where nothing differs should not
  mint a new version), and multi-field saves. Rollback creates a new version, not a
  history mutation.
- Frontend: `VersionHistoryTab` renders version list, diff expansion for each field
  type, restore flow behind confirm dialog. Existing `HistoryPanel.test.tsx` is
  removed/replaced.
