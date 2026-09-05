# Bulk Import Markdown Articles — Design

## Summary

Add a "Bulk Import" action to the KnowledgeBase list page that lets a
Team Lead or Admin upload a `.zip` of markdown files and have each `.md`
file inside it become a new draft article. Extends the existing
single-file "Import from Markdown" feature
(`docs/specs/2026-08-24-import-article-from-markdown-design.md`), which
explicitly scoped bulk/zip import out.

## Motivation

Agents migrating content from another docs system often have many
markdown files at once, not one. Repeating the single-file import flow
per file is the friction this removes.

## Scope

- Team Lead + Admin only (same role restriction as the existing
  single-file import, per `docs/project-overview.md`).
- Reads **only** `.md`/`.markdown` entries out of the zip (case-insensitive).
  Any other entry (images, folders, `.DS_Store`, nested paths, etc.) is
  silently skipped — not reported as an error.
- Every file that parses successfully becomes one new article with
  `state: draft`. Nothing is published. `intent_id` is always left
  `null` — bulk import never assigns a category, same as single-file
  import (no reliable way to resolve a frontmatter string to an intent).
- Best-effort per file: one bad file in the zip never blocks the rest of
  the batch.
- Caps: zip ≤ 20MB, ≤ 200 `.md` entries. Over either cap, the whole
  import is rejected upfront (no partial processing, no silent
  truncation) — the admin is told to split the batch.
- Out of scope: background job/progress socket, dedup against existing
  article titles, intent/category auto-assignment, editing content
  before creation, resumable/partial retry, nested-folder structure
  preservation.

## Data flow

1. Admin clicks **"Bulk Import"** in the KnowledgeBase list toolbar
   (next to "New Article"). A dialog opens with a `.zip` file picker.
2. Client validates the file is ≤ 20MB before doing anything else
   (immediate reject with a toast if not — no point uploading first).
3. Client requests a presigned PUT via the existing `POST /uploads`
   flow and PUTs the zip directly to storage under
   `pending/{workspaceId}/{agentId}/...`. This follows the existing
   "never proxy uploads through Node" convention — the zip bytes never
   pass through the API server on the way up.
4. Client calls `POST /articles/bulk-import { key }`. The dialog shows a
   loading state ("Importing articles…") for the duration — this is a
   synchronous request, not a background job (batch caps keep it
   bounded).
5. Server:
   a. `headObject(key)` to verify the pending object exists and belongs
   to this agent/workspace (same ownership check pattern as
   attachment finalization) and re-checks actual byte size ≤ 20MB.
   b. Fetches the object from storage into memory and unzips it.
   c. Filters entries to `.md`/`.markdown`, skipping directories and
   anything else. If this list is empty → reject (`no_markdown_files`).
   If it has more than 200 entries → reject (`too_many_files`), no
   processing happens.
   d. Deletes the pending object — it is not needed after this point.
   e. For each `.md` entry, independently (a failure in one does not
   stop the others):
   - Read the entry's text content.
   - Parse frontmatter with the `front-matter` package (same library
     the single-file import uses on the client; added as a backend
     dependency too — pure JS, no Node polyfills needed).
   - Resolve title: `frontmatter.title` → first `# H1` line in the
     body → the entry's basename with extension stripped (nested
     zip paths are flattened to their basename for this purpose).
     Truncate to 200 chars if longer (schema max) rather than
     failing the file.
   - Resolve keywords: `frontmatter.tags`, normalized the same way
     the single-file import does (array or comma-separated string),
     `[]` if absent.
   - Reject the file (do not create) if its body content is empty
     after stripping frontmatter.
   - Call the existing `createArticle()` service function directly
     (in-process, not over HTTP) with `{ title, body, keywords,
intent_id: null }`, in the calling agent's workspace context.
   - Record the outcome: `{ filename, title, status: 'created', article_id }`
     or `{ filename, status: 'error', reason }`.
     f. Return the full list of per-file outcomes plus a summary
     (`{ total, created, failed }`).
6. Dialog renders the results: a scrollable table — filename, resolved
   title, status icon, error reason if failed — plus the summary count
   ("18 of 20 imported") and a link/button back to the article list
   (which now shows the new drafts).

## API

`POST /articles/bulk-import`

Request:

```typescript
export const BulkImportArticlesBody = z.object({
  key: z.string(), // pending storage key from POST /uploads
});
```

Response:

```typescript
type BulkImportResult =
  | { filename: string; status: 'created'; title: string; article_id: string }
  | { filename: string; status: 'error'; reason: string };

type BulkImportArticlesResponse = {
  results: BulkImportResult[];
  summary: { total: number; created: number; failed: number };
};
```

Rejection responses (whole-batch, before any per-file processing):

| Code | Reason                | Condition                               |
| ---- | --------------------- | --------------------------------------- |
| 400  | `invalid_zip`         | Object isn't a valid zip archive        |
| 400  | `zip_too_large`       | Object size > 20MB                      |
| 400  | `no_markdown_files`   | Zero `.md`/`.markdown` entries          |
| 400  | `too_many_files`      | More than 200 `.md`/`.markdown` entries |
| 403  | (existing role check) | Caller is not Team Lead/Admin           |
| 404  | (existing pattern)    | `key` not found / not owned by caller   |

Registered in `backend/src/docs/openapi.ts` alongside the other
articles routes.

## Error handling

| Case                                                | Behavior                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| Zip > 20MB (caught client-side)                     | Toast before upload starts, no request made                                     |
| Zip > 20MB (caught server-side, defense in depth)   | 400 `zip_too_large`, nothing created                                            |
| > 200 `.md` entries                                 | 400 `too_many_files`, nothing created, admin splits the batch                   |
| Corrupt / non-zip upload                            | 400 `invalid_zip`, nothing created                                              |
| Zip has no `.md`/`.markdown` entries                | 400 `no_markdown_files`, nothing created                                        |
| Individual file is empty (post-frontmatter)         | That file recorded as `error`, rest of batch proceeds                           |
| Individual file's `createArticle()` fails           | That file recorded as `error` with the service's reason, rest of batch proceeds |
| Individual file's resolved title > 200 chars        | Truncated to 200 chars, file still created (not an error)                       |
| Non-`.md` entry in zip (image, folder, `.DS_Store`) | Silently skipped, not counted, not reported                                     |

## Dependencies

- Add `front-matter` to `backend/package.json` (already used on the
  frontend; same pure-JS library, no new concept).
- Add a zip-reading library to the backend (e.g. `jszip`, reading from
  an in-memory `Buffer`, no filesystem extraction — avoids zip-slip/
  path-traversal concerns entirely since nothing is ever written to
  disk by entry name).

## Testing

- Unit test the per-file parse-and-resolve logic (title fallback chain,
  keyword normalization, empty-body rejection, truncation) as a pure
  function, mirroring the existing frontend test coverage for
  `parseMarkdownImport`.
- Integration test `POST /articles/bulk-import`:
  - Happy path: zip with N valid `.md` files → N drafts created, RLS
    workspace scoping respected.
  - Mixed batch: some files valid, one empty, one absent title/tags →
    correct per-file result list, valid ones still created.
  - Zip containing non-`.md` entries → those silently ignored, only
    `.md` entries counted/processed.
  - Over the 200-file cap → whole batch rejected, zero articles created.
  - Over the 20MB cap → rejected before unzipping.
  - Non-Team-Lead/Admin caller → 403, zero articles created.
  - Corrupt zip → 400, zero articles created.
- Frontend: results table renders success/error rows correctly; loading
  state shown for the duration of the request; summary count matches
  results.

## Non-goals

- Background job / async progress reporting.
- Deduplication against existing article titles.
- Intent/category auto-assignment from frontmatter.
- Editing parsed content before article creation.
- Resumable or partial-retry import (admin re-zips just the failed
  files and re-uploads).
- Preserving zip folder structure in any way.
