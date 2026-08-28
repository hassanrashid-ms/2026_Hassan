# Articles Versioning — Design

## Problem

`article` rows are immutable once published — `updateArticle` rejects any edit once
`state !== 'draft'` (`articlesService.ts:140`). There is no version history: publishing
overwrites `title`/`body`/`keywords` in place and stamps `publishedBy`/`publishedAt`,
with nothing kept of what the article looked like before. An admin who wants to fix a
typo or update an article's content after it has gone live has no path to do so
without losing the fact that it was ever published, and there is no way to see what
changed between edits or roll back a bad edit.

## Goal

Let admins edit a published article via a staged draft, publish that draft to promote
it to a new live version (incrementing a version number), optionally discard an
in-progress draft without publishing, and browse/diff/restore prior versions — mirroring
the pattern already established for bot config
(`docs/specs/2026-08-27-bot-config-versioning-design.md`).

## Non-goals

- Versioning of `state='draft'` (never-yet-published) articles before their first
  publish. That flow is unchanged — free editing until the first publish, which mints
  `version = 1`.
- Partial/field-level restore. Restoring a version loads its full snapshot
  (title/body/keywords/attachments) into the draft for review — never a direct,
  unreviewed live overwrite.
- Changing how player-facing surfaces or the bot read articles. Both continue to read
  `article.title`/`body`/`keywords` directly — always the current live content, no join
  required.

## Data model

**`article_version`** (new table, `backend/src/shared/db/schema/articles.ts`) — doubles
as both the version-history table and the one-active-draft-per-article store:

| column | type | notes |
| --- | --- | --- |
| `id` | bigserial PK | |
| `articleId` | uuid, FK → `article` | |
| `status` | `'draft' \| 'published' \| 'discarded'` | at most one `'draft'` row per `articleId` (partial unique index on `articleId` where `status = 'draft'`) |
| `version` | int, nullable | assigned only on publish, `MAX(published version for articleId) + 1`; null while `status = 'draft'` |
| `title` | text | full snapshot |
| `body` | text | full snapshot |
| `keywords` | text[] | full snapshot |
| `attachmentIds` | uuid[] | snapshot of live attachment ids, filled in at publish time |
| `actorId` | uuid, FK → `agent`, not null | last editor while draft; publisher once published |
| `changedFields` | text[] | subset of `title`/`body`/`keywords`/`attachments` differing from the prior published version — computed at publish time; empty/unused while draft |
| `createdAt` | timestamptz | |
| `updatedAt` | timestamptz | bumped on every draft save |

- `support_app` (the application DB role) is never granted `DELETE` on any table in
  this schema — nothing can be hard-deleted, full stop. So published rows can't be
  mutated (enforced the same way as `change_log`/`bot_config_version`, via a
  `BEFORE UPDATE OR DELETE` trigger that raises when `OLD.status = 'published'`,
  since a blanket `REVOKE UPDATE` on the whole table would also block legitimate
  draft edits), and a discarded draft is never deleted either — `discardArticleDraft`
  updates the row's `status` to `'discarded'` instead. `'discarded'` rows are excluded
  from both "current draft" lookups (`status='draft'`) and version history
  (`status='published'`); they just sit there as an inert record of an abandoned edit.
- Unique index `(articleId, version)` where `status='published'`, plus
  `(articleId, createdAt)` for the list view.

**`article`** — add one cached column:

| column | type | notes |
| --- | --- | --- |
| `version` | int, not null, default 1 | cached current live version number, updated alongside `title`/`body`/`keywords` on publish, so list/detail views show "v{N}" without a join |

No other `article` columns change. `title`/`body`/`keywords` remain the live content,
read by every existing path (player surface, bot grounding, Weaviate index) unchanged.

**`article_attachment`** — add:

| column | type | notes |
| --- | --- | --- |
| `draftOnly` | boolean, not null, default false | uploaded during an in-progress draft edit, not yet live |
| `pendingRemovalAt` | timestamptz, nullable | staged for removal by the current draft; still live/visible until publish |
| `removedAt` | timestamptz, nullable | soft-removed (no hard deletes, per repo convention) |

- Live attachments (player view, live editor default) = `removedAt IS NULL AND draftOnly = false`.
- Draft editor view = live attachments (minus `pendingRemovalAt`-staged ones, shown as
  "removing") plus `draftOnly = true` ones.
- Restoring a version that references an attachment later soft-removed re-stages it as
  `draftOnly` by clearing `removedAt` — never re-uploads, since the row and its storage
  key still exist.

**Backfill migration**: for every `article` with `state = 'published'`, insert one
`article_version` row: `status='published'`, `version=1`, `title`/`body`/`keywords` =
current values, `attachmentIds` = current live attachment ids, `actorId = publishedBy`,
`createdAt = publishedAt`, `changedFields = ['title','body','keywords']`. Set
`article.version = 1`. `state='draft'` articles get no version row; `article.version`
stays at its default, unused until their first publish.

## Backend changes

`backend/src/agent/services/articlesService.ts`:

- `updateArticle` — unchanged; still only for `state='draft'` articles.
- New `saveArticleDraft(articleId, {title, body, keywords}, actorId)` — published
  articles only (400 otherwise). Upserts the `status='draft'` row: create if absent,
  else update `title`/`body`/`keywords`/`actorId`/`updatedAt`.
- New `discardArticleDraft(articleId)` — updates the `status='draft'` row to
  `status='discarded'` (never deleted — `support_app` has no `DELETE` grant on any
  table); soft-removes (`removedAt`) any `draftOnly` attachments; clears
  `pendingRemovalAt` on any attachment that had one staged. Live content and version
  history untouched.
- `publishArticle` — branches:
  - **Draft row exists**: compute `changedFields` (diff draft vs. current live
    `title`/`body`/`keywords` and live-attachment-set), assign
    `version = MAX(published)+1`, flip the row to `status='published'` with that
    version, copy `title`/`body`/`keywords` onto `article`, bump `article.version`,
    apply attachment staging (`draftOnly→false`; `pendingRemovalAt` rows get
    `removedAt` stamped), snapshot the resulting live attachment ids into
    `attachmentIds`, reindex Weaviate, stamp `publishedBy`/`publishedAt`.
  - **No draft row** (first-ever publish of a `state='draft'` article): unchanged
    existing behavior, plus insert one `article_version` row directly as
    `status='published', version=1, changedFields=['title','body','keywords']`.
  - Both branches run in one transaction, matching the `saveBotConfig` choke-point
    pattern — one write path, no ad-hoc updates.
- New `listArticleVersions(articleId)` — paginated, newest-first,
  `{version, actor, createdAt, changedFields}`, `status='published'` only.
- New `getArticleVersion(articleId, version)` — full snapshot, for client-side diff
  against the adjacent version.
- New `restoreArticleVersion(articleId, version, actorId)` — loads that snapshot's
  `title`/`body`/`keywords`/`attachmentIds` into the draft row (same upsert as
  `saveArticleDraft`). Never publishes directly.

Routes (`backend/src/agent/routers/articlesRouter.ts`, Team Lead/Admin only):

- `PATCH /agent/articles/:id/draft` — save draft
- `DELETE /agent/articles/:id/draft` — discard draft
- `GET /agent/articles/:id/versions` — list
- `GET /agent/articles/:id/versions/:version` — snapshot
- `POST /agent/articles/:id/versions/:version/restore` — restore into draft
- `POST /agent/articles/:id/attachments` — gains a `draft: boolean` flag; uploads during
  draft-editing are tagged `draftOnly`
- `DELETE /agent/articles/:id/attachments/:attachmentId` — for a published article with
  a draft in progress, stamps `pendingRemovalAt` instead of removing immediately; for a
  never-published `state='draft'` article, unchanged (immediate soft-remove)

All new routes and their Zod schemas registered in `backend/src/docs/openapi.ts`.

Weaviate sync — unchanged trigger point: only `publishArticle` calls
`upsertArticleObject`, using post-publish live content. Draft edits never touch the
index, so bot answers never cite unpublished/staged content.

## Frontend changes

`frontend/src/surfaces/agent-console/pages/KnowledgeBase/`:

- `ArticleEditorSheet.tsx`: on a `published` article, shows live content by default with
  a "Draft in progress" banner when a draft row exists (last editor, timestamp).
  Editing writes to the draft (`useArticleAutosave.ts` retargeted to
  `PATCH .../draft` for published articles). Two actions when a draft exists: Publish
  and Discard draft (behind the existing `ConfirmDialog` pattern). A persistent
  "Live: v{N}" badge in the header shows the current published version at all times, so
  it's never ambiguous which version is actually serving players while a draft is being
  edited.
- `ArticleTable.tsx`: adds a version badge (`v{N}`) beside the state badge, and an
  indicator on rows with an in-progress draft.
- New `ArticleVersionHistoryTab.tsx` (panel within the sheet, mirroring
  `VersionHistoryTab.tsx` from bot_config): lists published versions newest-first, with
  the current live version clearly marked (e.g. "v4 · Current"), actor, relative
  timestamp, `changedFields` chips. Expanding a row diffs against the prior version
  (text diff for `title`/`body`, plain-language add/remove list for
  `keywords`/attachments). "Restore this version" per non-current row loads it into the
  draft and returns to the editor for review. Empty state: "No prior changes."
- `agentApi.ts` (`frontend/src/surfaces/agent-console/api/agentApi.ts` — the client the
  editor sheet already imports `fetchArticle`/`updateArticle`/`publishArticle` from,
  not the public-surface `features/articles/api/articlesApi.ts`): add
  `saveArticleDraft`, `discardArticleDraft`, `fetchArticleVersions`,
  `fetchArticleVersion`, `restoreArticleVersion`, `removeArticleAttachment`, typed
  against new `@support/types` shapes shared with the backend Zod schemas.

Player-facing surfaces (`frontend/src/surfaces/webview/`) are unaffected — they only
ever read `article.title/body/keywords`, always the live version.

## Testing

Backend:

- `saveArticleDraft` creates on first edit, updates in place after, rejects for
  non-published articles.
- `publishArticle` with a draft: correct next version, correct `changedFields`
  (including attachment adds/removals), draft row flips to published, `article`
  updated, Weaviate reindexed, staged attachment flags cleared.
- `publishArticle` first-ever publish (no draft row): unchanged existing behavior,
  still creates `version=1`.
- `discardArticleDraft`: sets draft row to `status='discarded'`, soft-removes
  `draftOnly` attachments, clears `pendingRemovalAt`, live article/history untouched.
- `restoreArticleVersion`: populates draft without touching live content or
  `article.version`; re-stages a since-removed attachment as `draftOnly` without
  re-upload.
- Partial unique index enforced: one `status='draft'` row per `articleId`.
- Migration backfill: existing published articles get a correct `version=1` row with
  carried-over `publishedBy`/`publishedAt`; `state='draft'` articles get none.

Frontend:

- `ArticleEditorSheet`: draft banner appears/disappears correctly, Publish and Discard
  draft flows, "Live: v{N}" badge stays correct through edits.
- `ArticleVersionHistoryTab`: version list renders with current version marked, diff
  expansion per field type, restore flow returns to editor with draft populated.
- `ArticleTable`: version badge and in-progress-draft indicator render correctly.
