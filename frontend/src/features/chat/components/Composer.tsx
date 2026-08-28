import { useRef, useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import { AttachmentThumbnail } from './AttachmentThumbnail.tsx';

// Mirrors backend/src/shared/storage/presign.ts's ALLOWED_CHAT_ATTACHMENT_MIME_TYPES /
// maxBytesForAttachment. Duplicated rather than imported — the frontend
// doesn't import backend code — so a fast client-side rejection matches what
// the server would reject anyway, instead of round-tripping to find out.
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

export type UploadedAttachment = {
  key: string;
  filename: string;
  mimeType: string;
  byteSize: number;
};

type ComposerProps = {
  onSend: (
    body: string,
    visibility?: 'public' | 'internal',
    attachment?: UploadedAttachment,
  ) => void;
  disabled?: boolean;
  /** Only the agent console passes this. The player surface's Composer usage omits it, so
   *  onSend is always called with visibility undefined there — there is no code path for a
   *  player to send an internal note. */
  allowVisibilityToggle?: boolean;
  /** Defaults to today's copy, so the webview surface is untouched. */
  placeholder?: string;
  /** Only the agent console passes these three — the player surface's usage omits them. */
  allowAttachments?: boolean;
  onUpload?: (file: File, onProgress?: (percent: number) => void) => Promise<UploadedAttachment>;
  onCancelUpload?: (key: string) => void;
};

/**
 * Styled with bare Tailwind utilities against the --color-* tokens rather than
 * a semantic classname — shared across surfaces, each of which defines those
 * tokens differently in its own scoped stylesheet (see ChatThread.tsx).
 */
export function Composer({
  onSend,
  disabled,
  allowVisibilityToggle,
  placeholder = 'Type a message…',
  allowAttachments,
  onUpload,
  onCancelUpload,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'internal'>('public');
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
    onSend(trimmed, allowVisibilityToggle ? visibility : undefined, pendingAttachment ?? undefined);
    setValue('');
    setVisibility('public');
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

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-muted/20 bg-bg p-2">
      {previewUrl && previewMeta && (
        <div className="flex items-center gap-2">
          <AttachmentThumbnail
            previewUrl={previewUrl}
            mimeType={previewMeta.mimeType}
            filename={previewMeta.filename}
            uploading={uploading}
            progress={uploadProgress}
          />
          {!uploading && (
            <button
              type="button"
              aria-label="Remove attachment"
              onClick={clearAttachment}
              className="rounded-full bg-muted/20 p-1"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
      {uploadError && <span className="text-xs text-red-600">{uploadError}</span>}
      <div className="flex items-center gap-2">
        {allowVisibilityToggle && (
          <div className="flex shrink-0 gap-1" role="radiogroup" aria-label="Message visibility">
            <button
              type="button"
              aria-pressed={visibility === 'public'}
              onClick={() => setVisibility('public')}
              className={
                visibility === 'public'
                  ? 'rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-fg'
                  : 'rounded-md bg-accent-soft px-2 py-1 text-xs font-medium text-muted'
              }
            >
              Public
            </button>
            <button
              type="button"
              aria-pressed={visibility === 'internal'}
              onClick={() => setVisibility('internal')}
              className={
                visibility === 'internal'
                  ? 'rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-fg'
                  : 'rounded-md bg-accent-soft px-2 py-1 text-xs font-medium text-muted'
              }
            >
              Internal
            </button>
          </div>
        )}
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
              disabled={disabled || uploading}
              onClick={() => fileInputRef.current?.click()}
              className="flex size-9 shrink-0 items-center justify-center rounded-md border border-muted/20 text-muted disabled:pointer-events-none disabled:opacity-50"
            >
              <Paperclip className="size-4" />
            </button>
          </>
        )}
        <textarea
          value={value}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          // The visibility toggle above is labelled; this had no accessible name
          // at all, which the webview's own composer has always carried.
          aria-label="Message"
          className="min-h-9 max-h-24 flex-1 resize-none rounded-md border border-muted/20 bg-accent-soft px-3 py-1.5 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled === true || (value.trim().length === 0 && !pendingAttachment)}
          className="h-9 shrink-0 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:pointer-events-none disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
