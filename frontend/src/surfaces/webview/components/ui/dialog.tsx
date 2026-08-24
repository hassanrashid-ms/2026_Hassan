import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/surfaces/webview/lib/cn';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogPortal = DialogPrimitive.Portal;

// Divergence from stock shadcn: fade animation driven by our webview-fade-in/out
// keyframes instead of tailwindcss-animate, and black/50 in place of bg-black/80
// (no bg-black/80 opacity token needed — plain Tailwind color + opacity modifier).
function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-black/50',
        'data-[state=open]:animate-[webview-fade-in_0.3s_ease-out]',
        'data-[state=closed]:animate-[webview-fade-out_0.3s_ease-in]',
        className,
      )}
      {...props}
    />
  );
}

// Divergence from stock shadcn: centred/percentage sizing (w-[92%], max-h-[85dvh])
// instead of fixed max-w-lg, no hover states on the close button, and colors remapped
// to our tokens (bg-bg, text-muted, no bg-popover/text-foreground).
function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[92%] max-h-[85dvh] -translate-x-1/2 -translate-y-1/2',
          'flex flex-col overflow-y-auto rounded-card bg-bg p-4',
          'data-[state=open]:animate-[webview-fade-in_0.3s_ease-out]',
          'data-[state=closed]:animate-[webview-fade-out_0.3s_ease-in]',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-3 top-3 flex h-14 w-14 items-center justify-center rounded-card text-muted outline-none">
          <X className="h-8 w-8" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 pr-8', className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-2 pt-4', className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-lg font-semibold text-text', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-sm text-muted', className)} {...props} />;
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
