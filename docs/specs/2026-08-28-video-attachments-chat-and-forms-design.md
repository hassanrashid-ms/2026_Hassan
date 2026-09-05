# Video Attachments in Chat + Form Attachment Field

**Goal:** Extend the existing image-attachment pipeline (agent console chat, player webview chat, and the form `attachment` field) to also accept short videos. Article/Knowledge-Base image uploads are explicitly out of scope and unchanged.

**Why now:** The attachment field and chat attachment send/read paths (shipped in `2026-08-24-webview-chat-attachments-and-form-field-implementation.md`) currently hard-restrict to `ALLOWED_IMAGE_MIME_TYPES` (PNG/JPEG/WEBP/GIF, 10MB). Players and agents want to send short video clips (e.g. a bug repro) the same way they already send screenshots.

**Architecture — policy + rendering change, not a data-model change:** The `attachment` table, presigned S3 upload/claim flow, and `sendAgentMessage`/`sendPlayerMessage` are already mime-type/blob-agnostic — they store `mimeType`/`storageKey` generically and never branch on content type server-side except at the allowlist/size-cap check. This plan only:

1. Widens the allowed-mime-type and size-cap policy for chat/forms (articles keep their own, untouched policy).
2. Branches rendering (`<img>` vs `<video>`) on `attachment.mimeType` client-side.

No new field type, no new endpoints, no schema migration.

## Decisions

- **Formats:** `video/mp4`, `video/webm` only. No `video/quicktime` (MOV) — avoids Safari/iOS-only codec playback quirks in the shared `<video>` renderer.
- **Size cap:** Video max 50MB (`MAX_VIDEO_BYTES`). Images keep their existing 10MB cap (`MAX_ATTACHMENT_BYTES`), unchanged.
- **Chat thread rendering:** Video renders as a larger inline `<video controls>` block (not the existing 64×64 image tile). Images are unchanged.
- **Composer/FormCard pending-preview:** A picked video shows an inline muted, non-autoplay `<video>` preview using the local blob URL — same UX pattern as the current image preview, not a generic file icon.
- **Forms:** The existing `attachment` field type is reused as-is (its answer schema is already the opaque `{ attachmentId }` shape) — extending its accepted mime types requires no schema or field-type change, only the accept filter and the shared backend mime/size policy.
- **Articles / Knowledge Base image insert:** Untouched. `articlesService.ts`, `ImageDialogAdapter.tsx`, `ImageInsertDialog.tsx` keep using `ALLOWED_IMAGE_MIME_TYPES`/`MAX_ATTACHMENT_BYTES` exactly as today.

## Components

### 1. Backend mime/size policy — `backend/src/shared/storage/presign.ts`

Add, alongside the existing (untouched) `ALLOWED_IMAGE_MIME_TYPES`/`MAX_ATTACHMENT_BYTES`:

```ts
export const ALLOWED_VIDEO_MIME_TYPES = ['video/mp4', 'video/webm'] as const;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export const ALLOWED_CHAT_ATTACHMENT_MIME_TYPES = [
  ...ALLOWED_IMAGE_MIME_TYPES,
  ...ALLOWED_VIDEO_MIME_TYPES,
] as const;

export function maxBytesForAttachment(contentType: string): number {
  return (ALLOWED_VIDEO_MIME_TYPES as readonly string[]).includes(contentType)
    ? MAX_VIDEO_BYTES
    : MAX_ATTACHMENT_BYTES;
}
```

Call-site swaps (all chat/forms, not articles):

- `backend/src/agent/services/uploadsService.ts` — allowlist check → `ALLOWED_CHAT_ATTACHMENT_MIME_TYPES`; flat `MAX_ATTACHMENT_BYTES` check → `maxBytesForAttachment(body.content_type)`. `extensionFor()` gains `video/mp4 → mp4`, `video/webm → webm`.
- `backend/src/surface/services/uploadsService.ts` — identical swap.
- `backend/src/agent/services/messagesService.ts` — claim-time allowlist/size re-check swaps the same way.
- `backend/src/surface/services/messagesService.ts` — identical swap.
- `backend/src/agent/controllers/uploadsController.ts` / `backend/src/surface/controllers/uploadsController.ts` — the hardcoded `10 * 1024 * 1024` early-reject in the handler (ahead of the service call) becomes `50 * 1024 * 1024` (or delegates to `maxBytesForAttachment`, preferred, to avoid a second hardcoded number) so a video isn't rejected before the service even runs.

`articlesService.ts` is not touched — it keeps using `ALLOWED_IMAGE_MIME_TYPES`/`MAX_ATTACHMENT_BYTES` directly.

### 2. Frontend accept filters + client-side validation

Mirrors the backend policy, duplicated on purpose (frontend doesn't import backend code — same existing convention as the image allowlist today). Update in lockstep:

- `frontend/src/features/chat/components/Composer.tsx`
- `frontend/src/surfaces/webview/components/chat/ChatComposer.tsx`
- `frontend/src/surfaces/webview/components/chat/FormCard.tsx`

Each gets:

- `ALLOWED_CHAT_ATTACHMENT_MIME_TYPES` (images + `video/mp4`/`video/webm`) replacing the local `ALLOWED_IMAGE_MIME_TYPES` array.
- `accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"`.
- A `maxBytesForAttachment(contentType)`-equivalent local helper (mirrors 10MB images / 50MB video) replacing the flat `MAX_ATTACHMENT_BYTES` check.
- Error copy: `"Only PNG, JPEG, WebP, GIF images or MP4/WebM videos are supported."` for the type rejection; the size-rejection message becomes type-dependent, e.g. `"Videos must be 50MB or smaller."` / `"Images must be 10MB or smaller."`.
- `aria-label` on the file input changes from `"Attach image"` to `"Attach image or video"`.

`frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ImageDialogAdapter.tsx` and `frontend/src/components/ImageInsertDialog.tsx` are untouched.

### 3. Rendering

- `frontend/src/features/chat/components/MessageBody.tsx`: branch on `attachment.mimeType.startsWith('video/')`.
  - Video: a larger inline block (e.g. `max-w-xs`, not the 64×64 tile) containing `<video src={attachment.url} controls className="..." />`. Same loading/error-state pattern as images — `onError` swaps to the existing "Attachment unavailable — {filename}" fallback; no separate poster/loading-skeleton is required since `<video controls>` shows its own native loading state.
  - Image: unchanged, keeps the existing 64×64 tile, load-pulse skeleton, and click-to-expand (`onImageClick`) behavior.
- `frontend/src/features/chat/components/Composer.tsx` pending-attachment preview: branch on `pendingAttachment.mimeType` — image keeps `<img>`; video becomes `<video src={previewUrl} muted className="h-14 w-14 rounded-md object-cover" />` (no `autoPlay`, no `controls` — it's just a preview thumbnail-equivalent).
- `frontend/src/surfaces/webview/components/chat/FormCard.tsx`'s `case 'attachment':` branch: only the `accept` filter and `aria-label` change — it has no pending-preview step today (the file input fires straight into `onSendAttachment` and advances), so no new preview branch is needed there.

### 4. Testing

Extend existing tests, following the same patterns already present for images — no new test files:

- `backend/tests/agent.uploads.test.ts` / `backend/tests/surface.uploads.test.ts`: add cases — accepts `video/mp4` and `video/webm`; rejects an unsupported type (e.g. `video/x-msvideo`) with `unsupported_media_type`; rejects a video over 50MB; accepts a video between 10MB and 50MB (proves the cap is type-dependent, not the old flat 10MB image cap).
- `backend/tests/agent.messages.test.ts` / `backend/tests/surface.messages.test.ts`: extend the claim-time tests with an equivalent video case (claims a video the same way it claims an image today).
- `frontend/.../Composer.test.tsx`, `ChatComposer.test.tsx`: extend upload-rejection and preview-render tests for video; every existing `getByLabelText('Attach image')` assertion in these files updates to `'Attach image or video'`.
- `frontend/.../FormCard.test.tsx`: same aria-label update; add a case confirming a video file picked in the attachment field advances the form the same way an image does.
- `frontend/.../MessageBody.test.tsx` (or wherever image-attachment rendering is currently tested — confirm exact file before writing): add a case asserting a video-mimeType attachment renders a `<video>` element with the signed URL as `src`, not an `<img>`.
- `frontend/.../SupportChat.test.tsx`: update its own `getByLabelText('Attach image')` reference (added in the original attachment plan) to the new label text.

## Out of scope

- Article/Knowledge Base image uploads and `ImageInsertDialog`/`ImageDialogAdapter` — untouched.
- Video thumbnail/poster generation, client-side transcoding/compression, or duration limits — not required at this size cap.
- MOV (`video/quicktime`) support.
- A distinct "video" form field type — the existing `attachment` field type is reused unchanged.
