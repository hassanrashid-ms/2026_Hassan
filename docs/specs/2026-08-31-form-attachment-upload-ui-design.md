# Form attachment field: clickable container, preview, upload progress

## Problem

`FormCard`'s `attachment` field type renders a bare, unstyled `<input type="file">`
with no visual affordance that it's clickable, no image/video preview after picking,
and no upload progress or error feedback. A failed upload today propagates as an
unhandled promise rejection with nothing shown to the player.

## Design

### Component structure

Extract the `case 'attachment':` branch out of `FieldInput` in
`frontend/src/surfaces/webview/components/chat/FormCard.tsx` into its own
component, `AttachmentField`, defined in the same file (private to the form,
not reused elsewhere — consistent with `FieldInput` living there today).

`AttachmentField` owns local state, mirroring `features/chat/components/Composer.tsx`:

```ts
const [previewUrl, setPreviewUrl] = useState<string | null>(null);
const [previewMeta, setPreviewMeta] = useState<{ filename: string; mimeType: string } | null>(null);
const [uploading, setUploading] = useState(false);
const [progress, setProgress] = useState(0);
const [error, setError] = useState<string | null>(null);
```

### Idle state (no file picked yet)

A clickable container replaces the bare file input:

- `rounded-card border border-dashed border-muted/30 bg-surface`, `min-h-24`,
  flex column, centered content.
- Centered `Paperclip` icon (`lucide-react`) plus muted helper text ("Tap to
  attach a photo or video").
- Click handler on the container opens the picker via a ref
  (`fileInputRef.current?.click()`), the same indirection `ImageInsertDialog`
  uses. The real `<input type="file">` stays mounted but hidden
  (`className="hidden"`), keeping its existing
  `onClick={() => post({ type: 'expect_native_dialog' })}` and `onChange`
  wiring.
- `disabled` dims the container and suppresses the click handler, matching
  other field types.

### Client-side validation (new)

Ported from `Composer.tsx`, duplicated the same way `ChatComposer.tsx` already
duplicates it (surfaces don't cross-import each other's local constants):

```ts
const ALLOWED_CHAT_ATTACHMENT_MIME_TYPES = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm',
];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm']);

function maxBytesForAttachment(mimeType: string): number {
  return VIDEO_MIME_TYPES.has(mimeType) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}
```

A rejected file shows an inline error (`text-xs text-red-600`) and never calls
`onAttachmentPicked` — no wasted upload round-trip. The native input's value is
reset on rejection so re-picking the same file re-fires `onChange`.

### Picked / uploading state

On a valid pick: set `previewUrl` to `URL.createObjectURL(file)` immediately,
set `previewMeta`, set `uploading = true`, and render `AttachmentThumbnail`
(imported from `@/features/chat/components/AttachmentThumbnail`, already
cross-imported into this surface via `ChatComposer.tsx`) in place of the idle
container. Sized larger than the chat bubble's `h-14 w-14` — `h-32 w-32
rounded-card`, centered — since this is the sole focus of the screen rather
than a small composer chip. This gets the scrim (`bg-black/25`) and progress
ring for free from the shared component.

### Real upload progress

`FormCard`'s `onSendAttachment` prop gains a progress callback:

```ts
onSendAttachment?: (fieldKey: string, file: File, onProgress: (pct: number) => void) => Promise<void>;
```

In `frontend/src/surfaces/webview/pages/SupportChat.tsx`, thread that callback
into the existing `putFileToUploadUrl(uploaded.upload_url, file, onProgress)`
call — `putFileToUploadUrl` already supports an XHR progress callback; this
connects it on the player side the way the agent-console `Composer.tsx` path
already does on the desktop side.

### Success / failure

- Success: immediate advance to the next question — `FormCard`'s existing
  `handleAttachmentPicked` advance-on-resolve behavior is unchanged.
- Failure: `handleAttachmentPicked` gains a `catch` around `onSendAttachment`
  (today the rejection is unhandled). On catch: set an inline error message
  ("Upload failed. Please try again."), clear `previewUrl`/`previewMeta`, set
  `uploading = false`, and revert to the idle container so the player can
  retry.

## Files touched

1. `frontend/src/surfaces/webview/components/chat/FormCard.tsx` — new
   `AttachmentField` component; updated `onSendAttachment` prop type; error
   catch added in `handleAttachmentPicked`.
2. `frontend/src/surfaces/webview/pages/SupportChat.tsx` — thread
   `onProgress` through to `putFileToUploadUrl` in the `onSendAttachment`
   implementation.

## Out of scope

- Drag-and-drop (this is a mobile webview form field, not a desktop drop
  target).
- A success/checkmark dwell state before advancing — immediate advance is
  kept, matching existing `FormCard` behavior for every other field type.
- Multi-file selection — the existing contract is one file per attachment
  field.
