import * as React from 'react';
import * as SheetPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/surfaces/webview/lib/cn';

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;

// Divergence from stock shadcn: overlay uses our fade keyframes (webview-fade-in/out)
// driven off Radix's data-state, instead of shadcn's default tailwindcss-animate classes.
function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
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

type SheetContentProps = React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: 'bottom' | 'top';
};

// Divergence from stock shadcn: only bottom/top sides exist (mobile sheet, no left/right
// desktop drawer), and every color class is remapped onto our @theme tokens (bg-bg instead
// of bg-background, etc). The grab handle is our own addition for the mobile "sheet" feel.
function SheetContent({ side = 'bottom', className, children, ...props }: SheetContentProps) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        className={cn(
          'fixed inset-x-0 z-50 flex flex-col bg-bg',
          side === 'bottom' &&
            cn(
              'bottom-0 max-h-[90dvh] rounded-t-[1.5rem]',
              'data-[state=open]:animate-[webview-sheet-in_0.3s_cubic-bezier(0.32,0.72,0,1)]',
              'data-[state=closed]:animate-[webview-sheet-out_0.3s_cubic-bezier(0.32,0.72,0,1)]',
            ),
          side === 'top' &&
            cn(
              'top-0 max-h-[90dvh] rounded-b-[1.5rem]',
              'data-[state=open]:animate-[webview-fade-in_0.3s_ease-out]',
              'data-[state=closed]:animate-[webview-fade-out_0.3s_ease-in]',
            ),
          className,
        )}
        {...props}
      >
        {side === 'bottom' && (
          <div className="flex justify-center pt-3 pb-1" aria-hidden="true">
            <div className="h-1.5 w-10 rounded-card bg-muted/30" />
          </div>
        )}
        {children}
        <SheetPrimitive.Close className="absolute right-3 top-3 flex h-14 w-14 items-center justify-center rounded-full bg-surface/50 text-muted outline-none">
          <X className="h-8 w-8" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 p-4', className)} {...props} />;
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-2 p-4', className)} {...props} />;
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title className={cn('text-lg font-semibold text-text', className)} {...props} />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return <SheetPrimitive.Description className={cn('text-sm text-muted', className)} {...props} />;
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetPortal,
  SheetOverlay,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
