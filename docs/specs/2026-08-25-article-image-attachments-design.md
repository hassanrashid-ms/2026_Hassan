# Article Image Attachments + Autosave Design

**Goal:** Let agents upload images into knowledge-base articles (agent-authored, embedded in the
markdown body) and have them render correctly on both the agent-console editor/preview and the
player-facing webview article view. Along the way, replace explicit Create/Save buttons with
Google-Docs-style debounced autosave, since image upload needs an `articleId` to attach to and the
editor currently only creates one on an explicit button click.

**Prior art this reuses:** `docs/specs/2026-08-24-minio-attachments-agent-chat-design.md` (the
agent-chat attachment feature) — same storage choke point (`s3Client.ts` / `presign.ts`), same
image-only / 10MB constraints, same "no DB row until the object is verified real" philosophy, and
the existing generic `POST /agent/uploads` presign endpoint is reused as-is.

## Non-goals

- Player-side article image _upload_ — players never author articles.
- Reference counting or a cleanup job for orphaned attachments — see "Accepted tradeoffs" below.
- Non-image attachments (PDFs, etc.) — same `ALLOWED_IMAGE_MIME_TYPES` as chat.
- Collaborative/multi-agent concurrent editing of the same article (out of scope; single-editor
  debounced autosave only).

## 1. Storage & schema

`articleAttachment` (in `backend/src/shared/db/schema/articles.ts`) is simplified to mirror chat's
`attachment` table exactly, dropping the unused `status`/nullable-`storageKey` shape that predates
this design:

```
articleAttachment
  id          uuid primary key default random
  workspaceId uuid not null, FK -> workspace, restrict
  articleId   uuid not null, FK -> article, restrict
  storageKey  text not null   -- ws/{workspaceId}/attachments/{uuid}.{ext}, set only once verified
  filename    text not null   -- original filename, display-only
  mimeType    text not null   -- verified via headObject at finalize time
  byteSize    integer not null -- verified via headObject at finalize time
  createdAt   timestamptz not null default now
```

A row is inserted only after the object is confirmed to exist in storage — never before, matching
chat's `attachment` table and the repo's "structural RLS via `workspace_id`" convention (no manual
policy needed).

## 2. Upload flow (agent-console editor)

1. Agent picks an image via MDXEditor's `InsertImage` toolbar action, which now has a real
   `imageUploadHandler(file)`.
2. Handler calls the existing `POST /agent/uploads` (unchanged from the chat feature) to get a
   presigned PUT + `pending/{workspaceId}/{agentId}/{uuid}.{ext}` key, PUTs the file directly to
   MinIO/S3.
3. Handler calls new `POST /agent/articles/:id/attachments` with `{ key, filename, mime_type,
byte_size }`. This HEAD-verifies the pending object (rejecting on mismatch/missing, same
   `attachment_not_found` / `attachment_mismatch` error codes as chat), `CopyObject`s it to
   `ws/{workspaceId}/attachments/{uuid}.{ext}`, inserts the `articleAttachment` row, and deletes the
   pending original after the transaction commits. Unlike the general article-detail read path,
   this response includes a freshly-signed `url` inline — `{ id, filename, mime_type, byte_size,
url }` — since the editor needs one immediately for WYSIWYG display and it would be wasteful to
   make a second round-trip just to sign the image it already knows about.
4. `imageUploadHandler` returns that `url` to MDXEditor for immediate WYSIWYG display. Before the
   next autosave fires, the editor boundary (§4) rewrites this back to a stable handle.

If the article has no `articleId` yet (agent typed nothing before reaching for the image button),
the autosave create-on-first-edit flow (§5) fires first, synchronously, so the upload always has a
real `articleId` to attach to.

## 3. Stable image handles, not URLs, in stored markdown

Presigned GET URLs expire (10 min TTL) and article bodies are permanent, storable, exportable text
— so the markdown never stores a real URL. Instead the upload flow embeds
`![alt](attachment:{attachmentId})` — a handle, not a fetchable link.

**Resolving handles to real images:** article _detail_ reads only —
`GET /agent/articles/:id` and the player-facing `GET /articles/:id` — are extended to return
`attachments: [{ id, filename, mime_type, byte_size, url }]`, with `url` freshly presigned at read
time (same pattern chat already uses for message attachments). List endpoints are unchanged; only
a detail view ever renders a body.

`ArticleBody`/`ArticleImage` (shared by both surfaces) takes this `attachments` array as a prop.
When an `<img>` src starts with `attachment:`, it looks up the id in the array and renders the
resolved `url`, or the existing "Attachment unavailable — {filename}" fallback if the id is missing
(e.g. the object was somehow removed). One API round-trip resolves every image in an article, not
one per image.

This was revised from an earlier "stable backend redirect endpoint" idea: `<img src>` cannot carry
an `Authorization` bearer header, this app has no cookie-based session, and CLAUDE.md forbids ever
putting the session token in a query string — so a same-origin redirect endpoint has no legal way
to authenticate the request. Client-side resolution against an already-authenticated detail
response is the only approach that fits this app's auth model.

## 4. The live-editing boundary

MDXEditor's own WYSIWYG canvas renders `<img>` straight from markdown text; it doesn't know about
the `attachment:` scheme. Without care, a just-inserted image (or an existing one, on reopening a
draft) would show broken until reload. Two small pure functions contain this, isolated to the
editor's load/save boundary — nothing else in the app is aware of the substitution:

- `decodeArticleBodyForEditing(markdown, attachments)` — on opening a draft, replaces
  `attachment:{id}` with the currently-resolved signed `url` from the article-detail response, so
  MDXEditor's canvas renders existing images live.
- `encodeArticleBodyForSaving(markdown, uploadedUrlToHandle)` — before each autosave PATCH, replaces
  any image src matching a URL returned from an upload this session back to its `attachment:{id}`
  handle, using a lookup built as uploads happen. (A signed URL from a _previous_ session's
  resolve pass is never re-encoded — it's already been decoded from a handle we know, so the
  encode step tracks handles keyed by their last-known resolved URL for this editing session only.)

## 5. Autosave (title / body / keywords)

Replaces the current explicit Create Draft / Save buttons entirely, modeled on Google Docs:

- Debounced ~800ms after the last edit to any of title/body/keywords/intent.
- Status states shown in the editor: **Unsaved** (dirty, debounce pending) → **Saving…** (request
  in flight) → **Saved**.
- No `articleId` yet → debounce fires `POST /agent/articles`. Has one → `PATCH /agent/articles/:id`.
  A ref-guarded in-flight flag prevents a duplicate create if two fields debounce-trigger close
  together; the resolved `articleId` from the first create is what every subsequent save (and any
  attachment upload) uses.
- `CreateArticleBody`/`UpdateArticleBody` relax `title`/`body` from `min(1)` to allow empty strings
  during draft autosave (DB columns are already just `notNull`, not `min(1)`-enforced, so this is a
  Zod-only relaxation).
- **Publish gains new validation**: the existing draft→published transition now rejects if title or
  body is empty/whitespace — autosave allows an incomplete draft to exist, but nothing incomplete
  can be published. This is the only place non-empty content is still required.
- A flush-on-sheet-close call is a safety net for a pending debounced edit that hasn't fired yet.

## 6. Accepted tradeoffs

- **Orphaned attachments**: uploading then deleting an image from the text (or abandoning a draft
  before ever saving further) leaves the `articleAttachment` row and S3 object in place, unreferenced.
  No reference-counting or sweep job — consistent with this repo's "nothing is deleted" convention
  elsewhere (events, messages, conversations). Harmless extra storage, not a correctness bug.
- **No collaborative editing**: autosave assumes one agent editing one draft at a time; no conflict
  resolution for two agents editing the same article simultaneously (pre-existing gap, not
  introduced by this design).

## 7. API surface summary

| Method | Path                                       | Change                                                      |
| ------ | ------------------------------------------ | ----------------------------------------------------------- |
| POST   | `/agent/uploads`                           | Reused unchanged from chat feature                          |
| POST   | `/agent/articles/:id/attachments`          | New — finalize/claim, mirrors chat's claim-on-send          |
| POST   | `/agent/articles`                          | Relaxed `title`/`body` validation (empty allowed)           |
| PATCH  | `/agent/articles/:id`                      | Relaxed `title`/`body` validation; new autosave caller      |
| POST   | `/agent/articles/:id/publish`              | Existing route; gains validation rejecting empty title/body |
| GET    | `/agent/articles/:id`                      | Adds `attachments: [...]` to response                       |
| GET    | `/articles/:id` (player, `surface` router) | Adds `attachments: [...]` to response                       |

All new/changed routes registered in `backend/src/docs/openapi.ts` per repo convention.

## 8. Testing

- **Backend**: upload+finalize happy path; `attachment_not_found` / `attachment_mismatch` rejections
  (mirrors existing `agent.messages.test.ts` / `agent.uploads.test.ts` patterns); article-detail
  reads include a fetchable, freshly-signed `attachments[].url`; publish rejects empty title/body;
  autosave's relaxed create/update accepts empty strings.
- **Frontend**: `decodeArticleBodyForEditing` / `encodeArticleBodyForSaving` round-trip unit tests
  (encode(decode(x)) === x for a body with multiple handles, and decode is a no-op for a body with
  no handles); autosave debounce/state-machine tests with fake timers (dirty → saving → saved,
  and the duplicate-create race guard); manual browser check that a just-uploaded image renders
  live in the MDXEditor canvas without a reload, and that a saved-then-reopened draft's existing
  images render live too.
