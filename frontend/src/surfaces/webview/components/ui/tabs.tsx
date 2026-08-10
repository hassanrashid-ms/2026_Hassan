import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '@/surfaces/webview/lib/cn'

const Tabs = TabsPrimitive.Root

// Divergence from stock shadcn: TabsList is a horizontally scrollable pill strip
// (no-scrollbar utility from webview.css) instead of a fixed-width grid — there is
// no desktop layout to size it against.
function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('flex w-full overflow-x-auto no-scrollbar gap-2', className)}
      {...props}
    />
  )
}

// Divergence from stock shadcn: pill chips (bg-surface/bg-accent) instead of the
// stock underline-style tab, and no hover state — this is a touch surface.
function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'shrink-0 rounded-card px-4 py-2 text-base font-medium outline-none transition-colors',
        'bg-surface text-muted',
        'data-[state=active]:bg-accent data-[state=active]:text-accent-fg',
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('outline-none', className)} {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
