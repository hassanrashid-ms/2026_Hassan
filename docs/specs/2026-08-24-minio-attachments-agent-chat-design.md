# MinIO Object Storage + Agent-Chat Image Attachments

**Status:** Approved for implementation.
**Scope:** Phase 1 of a three-phase attachment rollout. This slice covers the MinIO/S3
foundation, the generic `attachment` table parented to `message`, and wiring image
attachments into the agent-console chat composer only.

**Out of scope (future phases, tracked separately, each gets its own spec/plan):**
- Article image upload (`article_attachment` — schema exists, stays a separate table,
  see "Relationship to `article_attachment`" below; needs `mime_type`/`byte_size` columns
  added when that phase starts)
- Player-side (webview) chat attachments and the form `attachment` field type. Per the
  existing spec decision (`docs/specs/2026-08-04-database-and-schema-design.md` line
  495-498, reaffirmed in `docs/decisions/spec-contradictions.md` §23), a form
  attachment answer arrives as an ordinary image message — so once the webview surface
  gets attachment-send wired onto the same `Composer`/message pipeline, the form field
  needs no separate storage of its own. That wiring is a later phase, not this one.
- **Known limitation, shipped as-is for this phase:** because the player-facing
  (webview) read path is exactly the deferred item above, a `public`-visibility
  message that carries an image attachment reaches the player as a bare filename
  with no image today — the webview read query never joins `attachment`. Agents
  should be aware that a public image attachment is currently visible only to
  other agents viewing the thread, not to the player, until the webview phase
  ships. This is a deliberate product decision, not a bug to fix in this phase.

---

## 1. Why MinIO

`CLAUDE.md`'s stack table already commits to "S3 or Cloudflare R2, presigned PUT — never
proxy uploads through Node." MinIO is S3-API-compatible, so it drops into that same
contract as a self-hosted object store, matching the existing local-dev pattern of
Postgres/Redis running as docker-compose services rather than managed cloud dependencies.
Nothing in the presigned-PUT design changes; only the endpoint the SDK points at does.

## 2. Infrastructure

- `docker-compose.yml` gains a `minio` service: image `minio/minio`, command
  `server /data --console-address ":9001"`, ports `9000` (S3 API) and `9001` (web
  console) published to localhost, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` from env, a
  named volume (`support-miniodata`), healthcheck against `/minio/health/live`.
- Backend uses `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` — no MinIO-specific
  SDK. The browser reaches MinIO on the same `localhost:9000` the backend signs against,
  so presigned URLs resolve identically for both in dev.
- A one-time setup script (`scripts/minio-setup.ts` or similar, mirroring the `db:setup`
  idempotent pattern) creates the bucket and applies a **private** bucket policy (no
  public-read, no anonymous listing) plus a narrow CORS rule: allowed origin = the app's
  own dev origin(s) from `SURFACE_ORIGINS`, methods `PUT`/`GET` only.

### New env vars (`backend/src/env.ts`)

| Var | Purpose | Default |
|---|---|---|
| `S3_ENDPOINT` | MinIO API URL | `http://localhost:9000` |
| `S3_REGION` | required by the SDK; MinIO ignores the value | `us-east-1` |
| `S3_ACCESS_KEY_ID` | credential, backend-only, never sent to the client | — |
| `S3_SECRET_ACCESS_KEY` | credential, backend-only, never sent to the client | — |
| `S3_BUCKET` | bucket name | `support-attachments` |
| `S3_FORCE_PATH_STYLE` | MinIO requires path-style addressing | `true` (fixed, not env-configurable) |

### Storage choke point

`backend/src/shared/storage/s3Client.ts` — singleton SDK client.
`backend/src/shared/storage/presign.ts` — `presignPut`, `presignGet`, `headObject`,
`copyObject`, `deleteObject`. Every call into the SDK goes through this module, same
"single choke point" shape as `logger`.

## 3. Signed-URL practices (applied throughout)

- **Short TTLs.** Presigned PUT: 5 minutes. Presigned GET: 10 minutes, re-signed fresh
  on every message-list read — never cached or stored.
- **Trust nothing client-declared past signing time.** The PUT is signed with
  `content-length-range` and `content-type` conditions, but the claim step re-verifies
  the *actual* object via `HEAD` before it's trusted — a presigned PUT's conditions can
  in principle be worked around by a non-browser client, so the server checks again.
- **Server-generated keys only.** Object keys are UUIDs the server mints, never a
  client-supplied filename — no path traversal, no collision, no enumeration via
  guessable names.
- **Private bucket, no public policy.** Every read goes through a presigned GET; there
  is no direct/public URL to an object, ever.
- **Ownership without a DB row.** A pending upload's key embeds `{agentId}` in its path
  (`pending/{workspaceId}/{agentId}/{uuid}.{ext}`); cancel-delete authorizes by comparing
  that segment to the caller's session identity, not a lookup — because no row exists
  for a pending upload by design (see §5).
- **Visibility-gated reads.** The GET signer walks `attachment.messageId → message.visibility`
  and is written to refuse `internal` for a player-scoped caller — enforced now even
  though this phase only wires the agent surface, so the webview phase needs no rework
  of the signer itself.
- **One credential pair, backend-only.** The browser only ever receives a presigned URL;
  raw MinIO credentials never reach client code.

## 4. Data model

New table in `backend/src/shared/db/schema/conversations.ts` (co-located with `message`):

```ts
export const attachment = pgTable('attachment', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  messageId: uuid('message_id')
    .notNull()
    .references(() => message.id, { onDelete: 'restrict' }),
  storageKey: text('storage_key').notNull(),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});
```

- RLS policy on `workspace_id`, same structural pattern as every other scoped table.
- **No row until the message sends.** Matches the existing "Attachment lifecycle"
  decision: an abandoned upload is bytes in `pending/`, never a DB row — nothing to
  reconcile at the row level, only object-storage lifecycle (out of scope here; MinIO
  lifecycle rules for `pending/` expiry can be added operationally later).
- Key layout:
  - Unclaimed: `pending/{workspaceId}/{agentId}/{uuid}.{ext}`
  - Claimed: `ws/{workspaceId}/attachments/{uuid}.{ext}`

### Relationship to `article_attachment`

`article_attachment` (`backend/src/shared/db/schema/articles.ts:28`) is **not**
superseded or made redundant by this table. The schema doc's own rule — "`attachment`
has exactly one parent: a message" — was a deliberate rejection of a polymorphic/nullable
FK design; the same reasoning means an article image gets its own table with
`article_id NOT NULL`, not a shared nullable-parent row. `article_attachment` stays,
unchanged, in this phase. It is schema-incomplete for real uploads (missing `mime_type`
and `byte_size`, which this phase's `attachment` table has) — that gap is fixed when the
article-image phase starts, not here.

## 5. API — `backend/src/agent/routers/uploadsRouter.ts`

All four routes registered in `backend/src/docs/openapi.ts`.

### `POST /agent/uploads`
Body: `{ filename, contentType, byteSize }` (Zod: `contentType` in
`['image/png','image/jpeg','image/webp','image/gif']`, `byteSize` ≤ 10 MB).
Mints a UUID, builds the pending key, returns
`{ key, uploadUrl, expiresAt }`.

### `DELETE /agent/uploads/:key`
Cancels an in-flight upload. `404` (not `403` — matches the repo's existing
"expect 404 not 403" RLS convention) if the key's `{agentId}` segment doesn't match the
caller. `204` on success, including if the object is already gone (idempotent).

### `POST /agent/messages` (extends existing `postAgentMessageHandler` / `messagesService`)
Request gains optional `attachment: { key, filename, mimeType, byteSize }`. On send:
1. `HEAD` the pending object. `422 attachment_not_found` if missing/expired.
2. `422 attachment_mismatch` if the real `Content-Type`/`Content-Length` disagrees with
   the declared values or fails the allowlist/size cap.
3. `CopyObject` `pending/... → ws/{workspaceId}/attachments/{uuid}.{ext}`, then delete the
   pending original.
4. Insert `message` (body = the attachment's filename, since an image-only send has no
   typed text and `postMessage` refuses empty bodies — this satisfies that guard with no
   special-casing) + `attachment` row, **in one transaction**.

### `GET /agent/messages` (existing, extended)
Each message carrying an attachment gets a freshly presigned GET URL computed at
serialization time (10 min TTL, never persisted). Signing failure (e.g. object
unexpectedly missing) omits the URL rather than throwing — a broken attachment must not
break loading the rest of the thread.

## 6. Frontend — agent-console chat

- **`Composer.tsx`** (`frontend/src/features/chat/components/`, shared by both surfaces)
  gains an attach button gated by a new `allowAttachments?: boolean` prop, mirroring how
  `allowVisibilityToggle` already gates the agent-only visibility control — the webview
  usage is untouched by default.
  - Pick file → client-side type/size fast-fail → `POST /agent/uploads` → PUT directly to
    `uploadUrl` → pending thumbnail shown above the textarea.
  - `onSend(body, visibility?, attachment?)` — the new third argument carries
    `{ key, filename, mimeType, byteSize }`. Sending with only an attachment and no typed
    text uses the filename as `body`.
  - ✕ on the pending thumbnail → `DELETE /agent/uploads/:key`.
- **`MessageBody.tsx`** renders an `<img>` from the message's presigned `attachment.url`
  when present; falls back to a broken-image placeholder + filename text if the URL
  fails to load (expired GET is unlikely at 10 min, but the component must not crash).
- `features/chat/components/types.ts` gains the shared `attachment` field on the message
  type.

## 7. Error handling summary

| Case | Response |
|---|---|
| Bad content-type/size at presign | `422 invalid_request` / `422 unsupported_media_type` |
| Pending object missing/expired at claim | `422 attachment_not_found` |
| Real object disagrees with declared metadata | `422 attachment_mismatch` |
| Cancel-delete, key not owned by caller | `404` |
| Cancel-delete, object already gone | `204` (idempotent) |
| GET-signing fails for an existing attachment row | Omit URL, don't throw |

## 8. Testing

- `backend/tests/uploads.test.ts` — presign shape, content-type/size rejection,
  ownership-scoped delete (404 for wrong agent).
- `backend/tests/messages.attachment.test.ts` — claim transaction (HEAD mismatch
  rejected; copy+delete+insert atomicity), body-defaults-to-filename, visibility gating
  on the GET-signing walk (asserted even though only the agent surface is wired yet).
- `Composer.test.tsx` (new) — attach/cancel/send-with-attachment flow.
- Extend `MessageBody.test.tsx` — image rendering + broken-image fallback.
