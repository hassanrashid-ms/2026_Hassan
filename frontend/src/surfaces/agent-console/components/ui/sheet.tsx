import * as React from 'react'
import * as SheetPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/cn.ts'

function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root {...props} />
}
function SheetTrigger(props: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger {...props} />
}
function SheetClose(props: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close {...props} />
}
function SheetOverlay({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  )
}

const sheetVariants = cva(
  'fixed z-50 flex flex-col gap-4 bg-bg shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500',
  {
    variants: {
      side: {
        right:
          'inset-y-0 right-0 h-full w-full border-l border-slate-200 sm:max-w-xl data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:animate-in data-[state=open]:slide-in-from-right',
        left: 'inset-y-0 left-0 h-full w-full border-r border-slate-200 sm:max-w-xl data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:slide-in-from-left',
        top: 'inset-x-0 top-0 h-auto border-b border-slate-200',
        bottom: 'inset-x-0 bottom-0 h-auto border-t border-slate-200',
      },
    },
    defaultVariants: { side: 'right' },
  },
)

function SheetContent({
  className,
  children,
  side = 'right',
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & VariantProps<typeof sheetVariants>) {
  return (
    <SheetPrimitive.Portal>
      <SheetOverlay />
      <SheetPrimitive.Content className={cn(sheetVariants({ side }), className)} {...props}>
        {children}
        <SheetPrimitive.Close className="absolute top-4 right-4 rounded-xs opacity-70 outline-none hover:opacity-100">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}
function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 p-4', className)} {...props} />
}
function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('mt-auto flex flex-col gap-2 p-4', className)} {...props} />
}
function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title className={cn('font-semibold text-text', className)} {...props} />
}
function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return <SheetPrimitive.Description className={cn('text-sm text-muted', className)} {...props} />
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription }
