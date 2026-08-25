import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { Loader2, Upload as UploadIcon, X } from 'lucide-react';

export type ImageInsertDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'new' | 'editing';
  initialAltText?: string;
  initialSrc?: string;
  uploading: boolean;
  error: string | null;
  onUpload: (file: File, altText: string) => void;
  onLink: (src: string, altText: string) => void;
};

// Built on bare Radix primitives and theme tokens rather than either surface's
// shadcn ui/ wrappers — this lives in components/, which the surfaces/
// dependency-boundary lint rule forbids from importing surface-scoped code.
export function ImageInsertDialog({
  open,
  onOpenChange,
  mode,
  initialAltText,
  initialSrc,
  uploading,
  error,
  onUpload,
  onLink,
}: ImageInsertDialogProps) {
  const [altText, setAltText] = useState(initialAltText ?? '');
  const [linkSrc, setLinkSrc] = useState(initialSrc ?? '');
  const [linkAlt, setLinkAlt] = useState(initialAltText ?? '');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Re-seed from props only when the dialog opens, not on every prop change —
  // otherwise typing in the alt-text field would be clobbered by re-renders.
  useEffect(() => {
    if (!open) return;
    setAltText(initialAltText ?? '');
    setLinkSrc(initialSrc ?? '');
    setLinkAlt(initialAltText ?? '');
  }, [open, initialAltText, initialSrc]);

  // Paste is bound at the document level while the dialog is open — the drop
  // zone can't guarantee focus (drag/drop and click-to-browse don't leave it
  // focused), and paste events don't bubble through a blurred element.
  useEffect(() => {
    if (!open || uploading) return;
    const handlePaste = (event: ClipboardEvent) => {
      const item = Array.from(event.clipboardData?.items ?? []).find((candidate) =>
        candidate.type.startsWith('image/'),
      );
      const file = item?.getAsFile();
      if (file) onUpload(file, altText);
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [open, uploading, altText, onUpload]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 grid w-full max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-card bg-surface p-6 shadow-lg">
          <Dialog.Title className="text-lg font-semibold text-text">Insert image</Dialog.Title>
          <Dialog.Close className="absolute top-4 right-4 text-muted outline-none hover:text-text">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </Dialog.Close>

          <Tabs.Root defaultValue={mode === 'editing' ? 'link' : 'upload'}>
            <Tabs.List className="inline-flex w-fit rounded-card bg-bg p-1">
              <Tabs.Trigger
                value="upload"
                className="rounded-card px-3 py-1.5 text-sm font-medium text-muted outline-none data-[state=active]:bg-surface data-[state=active]:text-text"
              >
                Upload
              </Tabs.Trigger>
              <Tabs.Trigger
                value="link"
                className="rounded-card px-3 py-1.5 text-sm font-medium text-muted outline-none data-[state=active]:bg-surface data-[state=active]:text-text"
              >
                Link
              </Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value="upload" className="flex flex-col gap-3 pt-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                aria-label="Browse for an image"
                className="hidden"
                disabled={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) onUpload(file, altText);
                }}
              />
              <div
                role="button"
                tabIndex={0}
                aria-label="Drag and drop an image, paste, or click to browse"
                onClick={() => !uploading && fileInputRef.current?.click()}
                onKeyDown={(event) => {
                  if (!uploading && (event.key === 'Enter' || event.key === ' ')) {
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (!uploading) setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(false);
                  const file = event.dataTransfer.files[0];
                  if (file && !uploading) onUpload(file, altText);
                }}
                className={
                  'flex flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed p-8 text-center outline-none ' +
                  (dragOver ? 'border-accent' : 'border-muted/40') +
                  (uploading ? ' pointer-events-none opacity-60' : ' cursor-pointer')
                }
              >
                {uploading ? (
                  <Loader2 className="size-6 animate-spin text-accent" />
                ) : (
                  <>
                    <UploadIcon className="size-6 text-muted" />
                    <p className="text-sm text-muted">
                      Drag & drop an image here, or paste, or click to browse
                    </p>
                  </>
                )}
              </div>
              <input
                placeholder="Alt text (optional)"
                value={altText}
                disabled={uploading}
                onChange={(event) => setAltText(event.target.value)}
                className="h-9 rounded-card border border-muted/40 bg-bg px-3 text-sm text-text outline-none placeholder:text-muted focus:border-accent disabled:opacity-50"
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
            </Tabs.Content>

            <Tabs.Content value="link" className="flex flex-col gap-3 pt-3">
              <input
                placeholder="https://..."
                value={linkSrc}
                onChange={(event) => setLinkSrc(event.target.value)}
                className="h-9 rounded-card border border-muted/40 bg-bg px-3 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
              />
              <input
                placeholder="Alt text (optional)"
                value={linkAlt}
                onChange={(event) => setLinkAlt(event.target.value)}
                className="h-9 rounded-card border border-muted/40 bg-bg px-3 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={linkSrc.trim().length === 0}
                  onClick={() => {
                    onLink(linkSrc.trim(), linkAlt.trim());
                    onOpenChange(false);
                  }}
                  className="h-9 rounded-card bg-accent px-4 text-sm font-medium text-accent-fg disabled:pointer-events-none disabled:opacity-50"
                >
                  Insert
                </button>
              </div>
            </Tabs.Content>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
