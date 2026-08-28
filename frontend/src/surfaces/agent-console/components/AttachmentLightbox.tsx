import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.tsx';
import type { ChatAttachment } from '../../../features/chat/components/types.ts';

/**
 * The one click-to-expand lightbox for the whole console — the chat thread's
 * image/video bubbles and the context rail's form-attachment preview both open
 * this, rather than each owning its own Dialog. Agent-console-only, desktop
 * affordance; ChatThread/MessageBody are shared with the webview and know
 * nothing about it beyond firing the click callback.
 */
export function AttachmentLightbox({
  attachment,
  onClose,
}: {
  attachment: ChatAttachment | null;
  onClose: () => void;
}) {
  const isVideo = attachment?.mimeType.startsWith('video/') ?? false;

  return (
    <Dialog open={attachment !== null} onOpenChange={(open) => !open && onClose()}>
      {/* w-auto, not w-full: the content's own bounding box must hug the
          media, not stretch to max-w-[90vw] regardless of its real size —
          otherwise a click in the empty space around a small image still
          lands "inside" the dialog content and Radix's click-outside-to-close
          never fires. */}
      <DialogContent
        showCloseButton={false}
        className="w-auto max-w-[90vw] border-none bg-transparent p-0 shadow-none"
      >
        <DialogTitle className="sr-only">
          {attachment?.filename ?? 'Attachment preview'}
        </DialogTitle>
        {/* Own close button, not the Dialog's default small corner X: that
            default is styled for a solid bg-bg card and reads as nearly
            invisible against a photo, a video, or the transparent backdrop
            here. */}
        <DialogPrimitive.Close
          aria-label="Close"
          className="absolute -top-4 -right-4 z-10 flex size-9 items-center justify-center rounded-full bg-bg text-text shadow-lg outline-none hover:bg-muted/20"
        >
          <X className="size-5" />
        </DialogPrimitive.Close>
        {attachment?.url &&
          (isVideo ? (
            <video
              src={attachment.url}
              controls
              autoPlay
              className="max-h-[85vh] max-w-[90vw] rounded-card object-contain"
            />
          ) : (
            <img
              src={attachment.url}
              alt={attachment.filename}
              className="max-h-[85vh] max-w-[90vw] rounded-card object-contain"
            />
          ))}
      </DialogContent>
    </Dialog>
  );
}
