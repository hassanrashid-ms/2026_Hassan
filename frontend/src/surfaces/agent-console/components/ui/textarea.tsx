import * as React from 'react'
import { cn } from '../../lib/cn.ts'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'flex min-h-16 w-full rounded-md border border-slate-200 bg-bg px-3 py-2 text-sm shadow-xs transition-colors outline-none',
        'placeholder:text-muted disabled:pointer-events-none disabled:opacity-50',
        'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
