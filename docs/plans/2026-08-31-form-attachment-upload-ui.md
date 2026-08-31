# Form Attachment Upload UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare, unstyled `<input type="file">` on the webview form's `attachment` field with a clickable container (centered attachment icon), an image/video preview, and a real upload-progress overlay with scrim — matching the desktop `Composer`/`AttachmentThumbnail` pattern, and add the error handling that pattern implies (client-side validation, revert-on-failure) which the field has never had.

**Architecture:** Extract a self-contained `AttachmentField` component into `FormCard.tsx` (same file, private to the form — mirrors how `FieldInput` already lives there). It owns its own preview/uploading/progress/error state exactly like `features/chat/components/Composer.tsx` does, reuses the already-cross-imported `AttachmentThumbnail` for the preview+scrim+progress-ring rendering, and reports upload-in-progress / upload-done back to `FormCard` through two small callback props so `FormCard` keeps disabling Back/Skip/Next during the upload exactly as it does today. `onSendAttachment`'s prop signature grows a progress callback, threaded in `SupportChat.tsx` into the existing `putFileToUploadUrl(url, file, onProgress)` call.

**Tech Stack:** React + TypeScript, Vitest + Testing Library, Tailwind v4 utility classes on the webview's theme tokens, `lucide-react` icons.

## Global Constraints

- Tailwind v4 utilities only — no hand-written CSS classes (see repo `CLAUDE.md` Styling section).
- `frontend/src/features/**` components are shared across surfaces; local constants that mirror backend validation (`ALLOWED_CHAT_ATTACHMENT_MIME_TYPES`, byte caps) are duplicated per file rather than imported from the backend, matching the existing pattern in `Composer.tsx` and `ChatComposer.tsx`.
- No drag-and-drop, no success/checkmark dwell state before advancing, no multi-file selection — explicitly out of scope per the design spec (`docs/specs/2026-08-31-form-attachment-upload-ui-design.md`).
- Every new/changed behavior needs a test before the implementation (TDD): write the test, watch it fail, implement, watch it pass.

---

### Task 1: `AttachmentField` — clickable container, validation, preview, progress, error revert

**Files:**
- Modify: `frontend/src/surfaces/webview/components/chat/FormCard.tsx`
- Test: `frontend/src/surfaces/webview/components/chat/FormCard.test.tsx`

**Interfaces:**
- Produces: `AttachmentField` component (private to `FormCard.tsx`, not exported) with props:
  ```ts
  {
    fieldKey: string;
    disabled: boolean;
    onSendAttachment: (fieldKey: string, file: File, onProgress: (percent: number) => void) => Promise<void>;
    onUploading: (isUploading: boolean) => void;
    onUploaded: () => void;
  }
  ```
- Produces: updated `FormCardProps['onSendAttachment']` type:
  `(fieldKey: string, file: File, onProgress: (percent: number) => void) => Promise<void>`
- Consumes: `AttachmentThumbnail` from `@/features/chat/components/AttachmentThumbnail` (props: `previewUrl`, `mimeType`, `filename`, `uploading`, `progress`, `className`) — already cross-imported into this surface via `ChatComposer.tsx`, so no new dependency.

- [ ] **Step 1: Update the two existing attachment tests for the new 3-arg `onSendAttachment` call**

In `frontend/src/surfaces/webview/components/chat/FormCard.test.tsx`, change both occurrences of:

```ts
expect(onSendAttachment).toHaveBeenCalledWith('proof', file);
```

to:

```ts
expect(onSendAttachment).toHaveBeenCalledWith('proof', file, expect.any(Function));
```

(These are in the `'advances to the next question after onSendAttachment resolves'` and `'advances to the next question after picking a video for the attachment field'` tests.)

- [ ] **Step 2: Add a `makeFile` helper and the new failing tests**

Add near the top of `frontend/src/surfaces/webview/components/chat/FormCard.test.tsx`, right after the `FORM` constant's closing `};`:

```ts
function makeFile(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type });
}
```

Add these tests at the end of the `describe('FormCard', ...)` block, before the final closing `});`:

```tsx
  it('shows a clickable container with an attachment icon before any file is picked', () => {
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        { key: 'proof', label: 'Upload a photo', type: 'attachment', isRequired: false, position: 0 },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        busy={false}
        onSendAttachment={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: /tap to attach a photo or video/i }),
    ).toBeInTheDocument();
  });

  it('rejects an oversized image client-side without calling onSendAttachment', () => {
    const onSendAttachment = vi.fn();
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        { key: 'proof', label: 'Upload a photo', type: 'attachment', isRequired: false, position: 0 },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        busy={false}
        onSendAttachment={onSendAttachment}
      />,
    );
    const big = makeFile('huge.png', 'image/png', 11 * 1024 * 1024);
    fireEvent.change(screen.getByLabelText('Attach image or video'), { target: { files: [big] } });

    expect(onSendAttachment).not.toHaveBeenCalled();
    expect(screen.getByText(/10 MB or smaller/)).toBeInTheDocument();
  });

  it('rejects an oversized video client-side without calling onSendAttachment', () => {
    const onSendAttachment = vi.fn();
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        { key: 'proof', label: 'Upload a video', type: 'attachment', isRequired: false, position: 0 },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        busy={false}
        onSendAttachment={onSendAttachment}
      />,
    );
    const big = makeFile('huge.mp4', 'video/mp4', 51 * 1024 * 1024);
    fireEvent.change(screen.getByLabelText('Attach image or video'), { target: { files: [big] } });

    expect(onSendAttachment).not.toHaveBeenCalled();
    expect(screen.getByText(/50 MB or smaller/)).toBeInTheDocument();
  });

  it('rejects an unsupported file type client-side without calling onSendAttachment', () => {
    const onSendAttachment = vi.fn();
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        { key: 'proof', label: 'Upload a photo', type: 'attachment', isRequired: false, position: 0 },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        busy={false}
        onSendAttachment={onSendAttachment}
      />,
    );
    const bad = makeFile('doc.pdf', 'application/pdf', 100);
    fireEvent.change(screen.getByLabelText('Attach image or video'), { target: { files: [bad] } });

    expect(onSendAttachment).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Only PNG, JPEG, WebP, GIF images or MP4\/WebM videos are supported\./),
    ).toBeInTheDocument();
  });

  it('shows the picked file as a preview with a progress overlay while uploading', async () => {
    let resolveUpload!: () => void;
    const onSendAttachment = vi.fn(
      (_fieldKey: string, _file: File, onProgress: (percent: number) => void) =>
        new Promise<void>((resolve) => {
          onProgress(42);
          resolveUpload = resolve;
        }),
    );
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        { key: 'proof', label: 'Upload a photo', type: 'attachment', isRequired: false, position: 0 },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        busy={false}
        onSendAttachment={onSendAttachment}
      />,
    );
    const file = makeFile('shot.png', 'image/png', 3);
    fireEvent.change(screen.getByLabelText('Attach image or video'), { target: { files: [file] } });

    await screen.findByAltText('shot.png');
    expect(screen.getByTestId('upload-progress-overlay')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /tap to attach a photo or video/i }),
    ).not.toBeInTheDocument();

    resolveUpload();
    await waitFor(() =>
      expect(onSendAttachment).toHaveBeenCalledWith('proof', file, expect.any(Function)),
    );
  });

  it('reverts to the idle container and shows an error when the upload fails', async () => {
    const onSubmit = vi.fn();
    const onSendAttachment = vi.fn().mockRejectedValue(new Error('network error'));
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        { key: 'proof', label: 'Upload a photo', type: 'attachment', isRequired: false, position: 0 },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={onSubmit}
        onSkip={vi.fn()}
        busy={false}
        onSendAttachment={onSendAttachment}
      />,
    );
    const file = makeFile('shot.png', 'image/png', 3);
    fireEvent.change(screen.getByLabelText('Attach image or video'), { target: { files: [file] } });

    await screen.findByText(/Upload failed/);
    expect(
      screen.getByRole('button', { name: /tap to attach a photo or video/i }),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run the test file to verify the new/updated tests fail**

Run: `cd frontend && npx vitest run src/surfaces/webview/components/chat/FormCard.test.tsx`

Expected: The two updated assertions fail (called with 2 args, not 3), and every new test fails — `getByRole('button', { name: /tap to attach/i })` finds nothing, since the container doesn't exist yet.

- [ ] **Step 4: Implement `AttachmentField` and wire it into `FormCard`**

In `frontend/src/surfaces/webview/components/chat/FormCard.tsx`:

Change the import line (currently line 1):
```ts
import { useMemo, useState } from 'react';
```
to:
```ts
import { useMemo, useRef, useState } from 'react';
```

Add two new imports after the existing `import { cn } from '@/surfaces/webview/lib/cn';` line:
```ts
import { Paperclip } from 'lucide-react';
import { AttachmentThumbnail } from '@/features/chat/components/AttachmentThumbnail';
```

Update the `FormCardProps` type's `onSendAttachment` field (currently):
```ts
  onSendAttachment?: (fieldKey: string, file: File) => Promise<void>;
```
to:
```ts
  onSendAttachment?: (
    fieldKey: string,
    file: File,
    onProgress: (percent: number) => void,
  ) => Promise<void>;
```

Replace the whole `handleAttachmentPicked` function (currently lines 103-119, from the comment through the closing `};`) with:
```ts
  // The attachment field's own advance path: no draft/changed value to
  // compare, since a picked file that uploaded successfully is always a
  // "yes, send this" — there is no re-shown-unchanged case to skip posting
  // for. This mirrors advance()'s isLast/onSubmit/setIndex tail without its
  // changed-value branch. The upload itself, its preview, and its progress
  // are owned by AttachmentField below; this only runs once that upload has
  // actually succeeded.
  const handleAttachmentUploaded = (fieldKey: string) => {
    setCommitted((current) => ({ ...current, [fieldKey]: true }));
    if (isLast) onSubmit();
    else setIndex((current) => current + 1);
  };
```

Replace the `<FieldInput ... />` element (currently lines 162-168):
```tsx
      <FieldInput
        field={field}
        value={value}
        onChange={set}
        disabled={disabled}
        onAttachmentPicked={(file) => void handleAttachmentPicked(field.key, file)}
      />
```
with:
```tsx
      {field.type === 'attachment' ? (
        onSendAttachment && (
          <AttachmentField
            fieldKey={field.key}
            disabled={disabled}
            onSendAttachment={onSendAttachment}
            onUploading={setSending}
            onUploaded={() => handleAttachmentUploaded(field.key)}
          />
        )
      ) : (
        <FieldInput field={field} value={value} onChange={set} disabled={disabled} />
      )}
```

Remove the `onAttachmentPicked` prop from `FieldInput`'s props type and function signature (currently in the `function FieldInput({ field, value, onChange, disabled, onAttachmentPicked }: {...})` block) — delete the `onAttachmentPicked: (file: File) => void;` line from the type, and delete `onAttachmentPicked` from the destructured parameters.

Remove the entire `case 'attachment':` branch from `FieldInput`'s switch statement (the block with the comment `// Bypasses draft/onChange entirely...` down through its closing `);`) — attachment is now handled entirely in `FormCard`, above.

Add the validation constants and the new `AttachmentField` component after `FieldInput`'s closing `}` and before the `today()` helper function at the bottom of the file:

```ts
// Mirrors backend/src/shared/storage/presign.ts's ALLOWED_CHAT_ATTACHMENT_MIME_TYPES /
// maxBytesForAttachment. Duplicated rather than imported — the frontend doesn't
// import backend code, and this surface already duplicates the same constants
// in ChatComposer.tsx rather than sharing a module across surfaces — so a fast
// client-side rejection matches what the server would reject anyway, instead of
// round-tripping to find out.
const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm']);

function maxBytesForAttachment(mimeType: string): number {
  return VIDEO_MIME_TYPES.has(mimeType) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}

/**
 * The form's attachment field: a clickable container with a centered icon
 * when idle, replaced by AttachmentThumbnail's preview+scrim+progress-ring
 * once a file is picked. Owns its own preview/uploading/progress/error state
 * exactly like features/chat/components/Composer.tsx's attachment handling —
 * FormCard only learns "an upload is in flight" (to keep Back/Skip/Next
 * disabled) and "the upload succeeded" (to advance) via the two callback
 * props below.
 */
function AttachmentField({
  fieldKey,
  disabled,
  onSendAttachment,
  onUploading,
  onUploaded,
}: {
  fieldKey: string;
  disabled: boolean;
  onSendAttachment: (
    fieldKey: string,
    file: File,
    onProgress: (percent: number) => void,
  ) => Promise<void>;
  onUploading: (isUploading: boolean) => void;
  onUploaded: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<{ filename: string; mimeType: string } | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleFilePicked = async (file: File) => {
    setError(null);

    if (!ALLOWED_ATTACHMENT_MIME_TYPES.includes(file.type)) {
      setError('Only PNG, JPEG, WebP, GIF images or MP4/WebM videos are supported.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    const cap = maxBytesForAttachment(file.type);
    if (file.size > cap) {
      setError(
        VIDEO_MIME_TYPES.has(file.type)
          ? 'Videos must be 50 MB or smaller.'
          : 'Images must be 10 MB or smaller.',
      );
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // Local blob URL shown immediately — the player sees what they picked
    // before the network upload even starts.
    setPreviewUrl(URL.createObjectURL(file));
    setPreviewMeta({ filename: file.name, mimeType: file.type });
    setUploading(true);
    onUploading(true);
    setProgress(0);
    try {
      await onSendAttachment(fieldKey, file, setProgress);
      setPreviewUrl(null);
      setPreviewMeta(null);
      onUploaded();
    } catch {
      setError('Upload failed. Please try again.');
      setPreviewUrl(null);
      setPreviewMeta(null);
    } finally {
      setUploading(false);
      onUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
        aria-label="Attach image or video"
        className="hidden"
        disabled={disabled || uploading}
        // Must post before the native picker opens (it starts as this click's
        // default action): the SDK's resume watchdog needs to already know to
        // expect the pause it's about to see.
        onClick={() => post({ type: 'expect_native_dialog' })}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFilePicked(file);
        }}
      />
      {previewUrl && previewMeta ? (
        <AttachmentThumbnail
          previewUrl={previewUrl}
          mimeType={previewMeta.mimeType}
          filename={previewMeta.filename}
          uploading={uploading}
          progress={progress}
          className="mx-auto h-32 w-32 rounded-card"
        />
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          className="flex min-h-24 w-full flex-col items-center justify-center gap-2 rounded-card border border-dashed border-muted/30 bg-surface p-6 text-center disabled:opacity-60"
        >
          <Paperclip className="size-6 text-muted" />
          <span className="text-sm text-muted">Tap to attach a photo or video</span>
        </button>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
```

- [ ] **Step 5: Run the test file to verify everything passes**

Run: `cd frontend && npx vitest run src/surfaces/webview/components/chat/FormCard.test.tsx`

Expected: PASS — all existing tests plus the six new/updated ones.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`

Expected: no errors. (Catches the removed `onAttachmentPicked` prop and the `onSendAttachment` signature change if any call site was missed — `SupportChat.tsx` is fixed in Task 2.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/surfaces/webview/components/chat/FormCard.tsx frontend/src/surfaces/webview/components/chat/FormCard.test.tsx
git commit -m "Redesign form attachment field: clickable container, preview, upload progress"
```

---

### Task 2: Thread real upload progress through `SupportChat.tsx`

**Files:**
- Modify: `frontend/src/surfaces/webview/pages/SupportChat.tsx:374-398`
- Test: `frontend/src/surfaces/webview/pages/SupportChat.test.tsx`

**Interfaces:**
- Consumes: `AttachmentField`'s `onSendAttachment` shape from Task 1 —
  `(fieldKey: string, file: File, onProgress: (percent: number) => void) => Promise<void>`.
- Consumes: `putFileToUploadUrl(uploadUrl: string, file: File, onProgress?: (percent: number) => void): Promise<void>` from `frontend/src/features/chat/api/playerChatApi.ts:82-107` (already supports the callback — this task is the first caller on the player side to pass one).

- [ ] **Step 1: Add the failing test**

In `frontend/src/surfaces/webview/pages/SupportChat.test.tsx`:

Add `PlayerFormView` to the existing type-only import from `@support/types` (currently `import type { PlayerMessagesResponse } from '@support/types';`):
```ts
import type { PlayerFormView, PlayerMessagesResponse } from '@support/types';
```

Add `requestUpload`, `putFileToUploadUrl`, and `sendPlayerMessage` to the existing import from `@/features/chat/api/playerChatApi` (currently importing `fetchPlayerMessages, markPlayerMessagesRead, postFormAnswer, skipForm, submitForm`):
```ts
import {
  fetchPlayerMessages,
  markPlayerMessagesRead,
  postFormAnswer,
  putFileToUploadUrl,
  requestUpload,
  sendPlayerMessage,
  skipForm,
  submitForm,
} from '@/features/chat/api/playerChatApi';
```

Add this new `describe` block at the end of the file, after the last existing `describe(...)` block:

```tsx
describe('SupportChat form attachment upload', () => {
  it('threads a progress callback into putFileToUploadUrl when the active form asks for an attachment', async () => {
    const form: PlayerFormView = {
      submission_id: 'sub1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        { key: 'proof', label: 'Upload a photo', type: 'attachment', isRequired: false, position: 0 },
      ],
      answers: [],
    };
    vi.mocked(fetchPlayerMessages).mockResolvedValue(
      messages({ confirm_phase: 'form', form }),
    );
    vi.mocked(requestUpload).mockResolvedValue({
      key: 'pending/ws/player/uuid.png',
      upload_url: 'https://upload.example/put',
      expires_at: '2026-01-01T00:00:00.000Z',
    });
    vi.mocked(putFileToUploadUrl).mockResolvedValue(undefined);
    vi.mocked(sendPlayerMessage).mockResolvedValue({ conversation_id: 'c1', message: null });

    renderChat();
    await screen.findByLabelText('Attach image or video');

    const file = new File([new Uint8Array(3)], 'shot.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Attach image or video'), { target: { files: [file] } });

    await waitFor(() =>
      expect(putFileToUploadUrl).toHaveBeenCalledWith(
        'https://upload.example/put',
        file,
        expect.any(Function),
      ),
    );
    expect(sendPlayerMessage).toHaveBeenCalledWith(
      't',
      '',
      's',
      { key: 'pending/ws/player/uuid.png', filename: 'shot.png', mimeType: 'image/png', byteSize: 3 },
      'proof',
    );
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `cd frontend && npx vitest run src/surfaces/webview/pages/SupportChat.test.tsx`

Expected: FAIL — `putFileToUploadUrl` is called with only 2 arguments (no progress callback) today.

- [ ] **Step 3: Thread `onProgress` through in the implementation**

In `frontend/src/surfaces/webview/pages/SupportChat.tsx`, change the `onSendAttachment` prop (currently lines 374-398):

```tsx
            onSendAttachment={async (fieldKey, file) => {
              const uploaded = await requestUpload(boot!.token, {
                filename: file.name,
                contentType: file.type,
                byteSize: file.size,
              });
              await putFileToUploadUrl(uploaded.upload_url, file);
              await sendPlayerMessage(
                boot!.token,
                '',
                boot!.sessionId,
                {
                  key: uploaded.key,
                  filename: file.name,
                  mimeType: file.type,
                  byteSize: file.size,
                },
                fieldKey,
              );
              // The card owns its own progress and deliberately never
              // refetches mid-form (see FormCard's docstring) — but the
              // attachment answer just posted a real message row, and that
              // message must show up in the thread once the field advances.
              void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot?.sessionId] });
            }}
```

to:

```tsx
            onSendAttachment={async (fieldKey, file, onProgress) => {
              const uploaded = await requestUpload(boot!.token, {
                filename: file.name,
                contentType: file.type,
                byteSize: file.size,
              });
              await putFileToUploadUrl(uploaded.upload_url, file, onProgress);
              await sendPlayerMessage(
                boot!.token,
                '',
                boot!.sessionId,
                {
                  key: uploaded.key,
                  filename: file.name,
                  mimeType: file.type,
                  byteSize: file.size,
                },
                fieldKey,
              );
              // The card owns its own progress and deliberately never
              // refetches mid-form (see FormCard's docstring) — but the
              // attachment answer just posted a real message row, and that
              // message must show up in the thread once the field advances.
              void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot?.sessionId] });
            }}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `cd frontend && npx vitest run src/surfaces/webview/pages/SupportChat.test.tsx`

Expected: PASS — including every pre-existing test in this file (no other behavior changed).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/webview/pages/SupportChat.tsx frontend/src/surfaces/webview/pages/SupportChat.test.tsx
git commit -m "Thread real upload progress into the form attachment field"
```

---

### Task 3: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full frontend test suite**

Run: `cd frontend && npx vitest run`

Expected: PASS, no regressions anywhere else (in particular `ChatComposer.test.tsx` and `Composer.test.tsx`, which exercise the shared `AttachmentThumbnail` this plan reuses but does not modify).

- [ ] **Step 2: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`

Expected: no errors. A lint-only formatting diff (if `pnpm lint --fix` or a pre-commit hook reformats) is expected to be whitespace-only — verify with `git diff` before treating it as unexpected, per the repo's own note on this in `CLAUDE.md`.

- [ ] **Step 3: Manually verify in the browser**

Run: `pnpm dev`, open the webview support chat with a workspace/form configured with an `attachment` field (or seed one via `pnpm db:seed` if none exists), and walk through:
- The idle state shows a dashed container with a centered paperclip icon and helper text, not a raw file input.
- Picking a small image shows the image preview immediately, dimmed under a dark scrim with a progress ring while it uploads.
- Once upload completes, the form auto-advances to the next question (or submits, if it was the last).
- Picking an 11MB image (or a non-image/video file) shows the inline error and never starts an upload.
- Killing the network mid-upload (e.g. via devtools throttling → offline) reverts to the idle container with "Upload failed. Please try again." and lets you retry.

No automated test can drive a real browser upload here — this step is required before calling the work done.
