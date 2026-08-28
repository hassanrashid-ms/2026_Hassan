import { useRef, useState } from 'react';
import { Paperclip, SendHorizontal, X } from 'lucide-react';
import { cn } from '@/surfaces/webview/lib/cn';
import { post } from '@/services/bridgeService';
import type { UploadedAttachment } from '@/features/chat/components/Composer';
import { AttachmentThumbnail } from '@/features/chat/components/AttachmentThumbnail';

// Mirrors backend/src/shared/storage/presign.ts's ALLOWED_CHAT_ATTACHMENT_MIME_TYPES /
// maxBytesForAttachment — same duplication rationale as
// features/chat/components/Composer.tsx's own copy of these constants: a
// fast client-side rejection that matches what the server would reject anyway.
const ALLOWED_CHAT_ATTACHMENT_MIME_TYPES = [
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
 * Same behaviour as features/chat/components/Composer.tsx — trim, ignore empty,
 * Enter sends and Shift+Enter newlines, clear on submit — restyled for the
 * webview and with the visibility toggle removed rather than merely unset.
 *
 * There is no code path for a player to send an internal note. The shared
 * Composer guarantees that by omitting a prop; this one guarantees it by not
 * having the control at all, which is the stronger version of the same rule.
 *
 * Attachments (`allowAttachments`/`onUpload`/`onCancelUpload`) are handled by
 * re-implementing Composer's own upload/preview mechanics here rather than by
 * wrapping Composer itself: this component owns its own layout and the
 * safe-area inset handling below, which Composer does not need to know about.
 */
export function ChatComposer({
  onSend,
  disabled,
  allowAttachments,
  onUpload,
  onCancelUpload,
}: {
  onSend: (body: string, attachment?: UploadedAttachment) => void;
  disabled?: boolean;
  allowAttachments?: boolean;
  onUpload?: (file: File, onProgress?: (percent: number) => void) => Promise<UploadedAttachment>;
  onCancelUpload?: (key: string) => void;
}) {
  const [value, setValue] = useState('');
  const [pendingAttachment, setPendingAttachment] = useState<UploadedAttachment | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<{ filename: string; mimeType: string } | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const clearAttachment = () => {
    if (pendingAttachment) onCancelUpload?.(pendingAttachment.key);
    setPendingAttachment(null);
    setPreviewUrl(null);
    setPreviewMeta(null);
  };

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0 && !pendingAttachment) return;
    onSend(trimmed, pendingAttachment ?? undefined);
    setValue('');
    setPendingAttachment(null);
    setPreviewUrl(null);
    setPreviewMeta(null);
    setUploadError(null);
  };

  const handleFilePicked = async (file: File) => {
    if (!onUpload) return;
    setUploadError(null);

    if (!ALLOWED_CHAT_ATTACHMENT_MIME_TYPES.includes(file.type)) {
      setUploadError('Only PNG, JPEG, WebP, GIF images or MP4/WebM videos are supported.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    const cap = maxBytesForAttachment(file.type);
    if (file.size > cap) {
      setUploadError(
        VIDEO_MIME_TYPES.has(file.type)
          ? 'Videos must be 50 MB or smaller.'
          : 'Images must be 10 MB or smaller.',
      );
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // Local blob URL shown immediately — the user sees their file before the
    // network upload even starts, not only once it finishes.
    setPendingAttachment(null);
    setPreviewUrl(URL.createObjectURL(file));
    setPreviewMeta({ filename: file.name, mimeType: file.type });
    setUploading(true);
    setUploadProgress(0);
    try {
      const uploaded = await onUpload(file, setUploadProgress);
      setPendingAttachment(uploaded);
    } catch {
      setUploadError('Upload failed. Please try again.');
      setPreviewUrl(null);
      setPreviewMeta(null);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const empty = value.trim().length === 0 && !pendingAttachment;

  return (
    <div
      className="flex shrink-0 flex-col gap-2 border-t border-muted/15 bg-bg px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      // The safe-area inset is applied here as well as on the shell frame: this
      // row is the bottom-most thing on screen and must clear the home indicator
      // even while the keyboard is up and the shell's own padding is collapsed.
    >
      {previewUrl && previewMeta && (
        <div className="flex items-center gap-2">
          <AttachmentThumbnail
            previewUrl={previewUrl}
            mimeType={previewMeta.mimeType}
            filename={previewMeta.filename}
            uploading={uploading}
            progress={uploadProgress}
            className="h-14 w-14 rounded-card"
          />
          {!uploading && (
            <button
              type="button"
              aria-label="Remove attachment"
              onClick={clearAttachment}
              className="rounded-full bg-surface p-1 text-muted"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
      {uploadError && <span className="text-xs text-red-600">{uploadError}</span>}
      <div className="flex items-end gap-2">
        {allowAttachments && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
              aria-label="Attach image or video"
              className="hidden"
              disabled={disabled || uploading}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFilePicked(file);
              }}
            />
            <button
              type="button"
              aria-label="Choose image or video"
              disabled={disabled || uploading}
              onClick={() => {
                // Must post before .click(): the native picker (and any OS
                // permission prompt ahead of it) can start pausing the app as
                // soon as the click happens, and the SDK has to already know
                // to expect it.
                post({ type: 'expect_native_dialog' });
                fileInputRef.current?.click();
              }}
              className={cn(
                'inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-surface text-muted transition-colors outline-none',
                'disabled:opacity-60',
              )}
            >
              <Paperclip size={20} className="shrink-0" />
            </button>
          </>
        )}
        <textarea
          rows={1}
          value={value}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Type a message…"
          aria-label="Message"
          className={cn(
            'max-h-32 min-h-11 flex-1 resize-none rounded-card bg-surface px-4 py-3',
            'text-base text-text placeholder:text-muted',
            'border border-transparent focus:border-accent outline-none',
            'disabled:opacity-60',
          )}
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled === true || empty}
          aria-label="Send message"
          className={cn(
            'inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors outline-none',
            empty || disabled === true
              ? 'bg-surface text-muted'
              : 'bg-accent text-accent-fg active:bg-accent-deep',
          )}
        >
          <SendHorizontal size={24} className="shrink-0" />
        </button>
      </div>
    </div>
  );
}
