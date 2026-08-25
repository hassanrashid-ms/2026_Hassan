# Image Insert Dialog Design

**Goal:** Replace MDXEditor's stock "Insert Image" dialog in the article editor with a single,
themed modal that supports drag-and-drop, clipboard paste, click-to-browse, and pasting an
external link — all in one place, built as a generic, reusable component so it isn't tied to
articles specifically.

**Prior art this reuses:** `docs/specs/2026-08-25-article-image-attachments-design.md` — the
`imageUploadHandler`/`imagePreviewHandler` wiring in `ArticleEditorSheet.tsx` is unchanged by this
design; this spec only replaces the picker UI in front of it.

## Non-goals

- Wiring this into chat's `Composer.tsx` — that composer's click-to-upload flow is untouched. The
  component is built generic enough to drop in there later, but this spec doesn't do that work.
- Preview-then-confirm before insert — selecting a file/link inserts immediately, matching current
  behavior. A spinner over the drop zone covers the upload wait.
- Validating that a pasted link actually points at a reachable image before inserting — MDXEditor
  renders whatever `src` it's given; a broken link degrades to `ArticleImage`'s existing "Attachment
  unavailable" style fallback (via its `onError` handler), same as any other bad `<img>` src today.

## 1. Component placement

`frontend/src/components/ImageInsertDialog.tsx` — global, presentational only, per this repo's
`components/` vs `features/` convention. It knows nothing about articles, attachments, or
MDXEditor's realm. Its props:

```ts
type ImageInsertDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'new' | 'editing';
  initialAltText?: string;
  initialSrc?: string; // editing mode only, for the Link tab's prefill
  uploading: boolean;
  error: string | null;
  onUpload: (file: File, altText: string) => void;
  onLink: (src: string, altText: string) => void;
};
```

It has no knowledge of `File` validation rules beyond what's passed in via `error` — the caller
(the MDXEditor adapter, §2) owns MIME/size checking against the existing
`ALLOWED_IMAGE_MIME_TYPES`/`MAX_ATTACHMENT_BYTES` constants, exactly as `Composer.tsx` does today,
and passes the resulting message through `error`.

## 2. MDXEditor integration (article editor only, for now)

A thin adapter component, `ImageDialogAdapter`, lives next to the plugin wiring in
`ArticleEditorSheet.tsx` and is passed as `imagePlugin({ ImageDialog: ImageDialogAdapter, ... })`.
It bridges MDXEditor's realm to the generic dialog:

- Reads `imageDialogState$` (`{ type: 'inactive' | 'new' | 'editing', initialValues? }`) — renders
  nothing when `inactive`, otherwise renders `ImageInsertDialog` with `mode`/`initialAltText`/
  `initialSrc` derived from it.
- `onUpload(file, altText)` publishes `saveImage$({ file, altText })` — MDXEditor's own subscriber
  then runs the **existing, unmodified** `imageUploadHandler` from Task 10 and inserts/updates the
  node itself.
- `onLink(src, altText)` publishes `saveImage$({ src, altText })` — no upload handler involved;
  MDXEditor inserts the literal `src` as-is. This is the same code path MDXEditor's own stock
  dialog already uses for its URL field today, so "link" requires no new backend work and nothing
  to remove — it already matches how `ArticleBody` renders a non-`attachment:` src unchanged.
- `onOpenChange(false)` publishes `closeImageDialog$()`.
- Client-side MIME/size validation on drop/paste/browse happens in this adapter (reusing
  `ALLOWED_IMAGE_MIME_TYPES`/`MAX_ATTACHMENT_BYTES`, matching `Composer.tsx`'s existing messages)
  before ever calling `onUpload` — a rejected file never reaches `saveImage$`.

## 3. Layout

shadcn `Dialog` containing two `Tabs`: **Upload** and **Link**. Editing mode opens on **Link**,
prefilled with the current `src`/alt text, for a quick text edit; switching to **Upload**
replaces the image.

```
┌─────────────────────────────┐
│  Insert image                │
│  [ Upload ]  [ Link ]        │
├───────────────────────────────┤
│                               │
│        ⬆  (upload icon)       │
│   Drag & drop an image here   │
│   or paste, or click to browse│
│                               │
│  [ Alt text ______________ ]  │
└───────────────────────────────┘
```

**Upload tab:**
- One drop zone (dashed border, `rounded-card`, `border-muted/40` idle → `border-accent` on
  drag-over) handles all three input methods:
  - `onDrop` — reads `e.dataTransfer.files[0]`.
  - `onPaste` (bound while the dialog is open) — reads the first image item off
    `e.clipboardData.items`.
  - `onClick` — opens a hidden `<input type="file" accept="image/png,image/jpeg,image/webp,image/gif">`.
- An alt-text input below the zone (optional, not blocking).
- While `uploading` is true, the zone shows a centered spinner and disables further drops/clicks/
  paste.
- `error` (if set) renders as an inline message below the zone, same tone as `Composer.tsx`'s
  existing `uploadError` text.

**Link tab:**
- URL `Input` + alt-text `Input`, both required-empty-allowed (alt text optional, URL required to
  enable the button).
- "Insert" `Button`, calls `onLink(url, altText)` and closes the dialog.

**Styling:** Tailwind utilities on theme tokens only — `bg-surface`, `text-text`, `text-muted`,
`text-accent`, `rounded-card` — no hand-written CSS, consistent with the rest of the console per
`CLAUDE.md`.

## 4. Testing

- `ImageInsertDialog.test.tsx` (component-level, no MDXEditor): renders both tabs, fires `onUpload`
  on drop/paste/browse-select, fires `onLink` on Link-tab submit, shows `error` text when passed,
  disables the zone while `uploading`.
- `ArticleEditorSheet.test.tsx` (extend): the existing "uploads an image and inserts an
  `attachment:` reference" test is updated to drive the new dialog's DOM instead of the stock
  MDXEditor dialog's file input — drop/paste a file via the adapter and assert
  `finalizeArticleAttachment` is still called the same way. A new test drives the Link tab and
  asserts a plain `![alt](https://...)` markdown src is inserted, with no attachment API call made.

## Accepted tradeoffs

- No preview-before-insert step (see Non-goals) — matches current editor behavior and keeps the
  interaction to one step per input method.
- No link reachability check — consistent with how any other external image src already behaves in
  this editor.
