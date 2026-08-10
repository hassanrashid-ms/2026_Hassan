import * as React from 'react'
import { cn } from '@/surfaces/webview/lib/cn'

// Divergence from stock shadcn: no hover state (touch surface), tokens remapped
// (bg-surface instead of bg-transparent+border-input, border-accent focus instead
// of ring-ring), and game-scale padding/text sizing instead of shadcn's h-9 default.
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          'w-full rounded-full bg-surface px-4 py-3 text-base text-text placeholder:text-muted',
          'border border-transparent outline-none focus:border-accent',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    )
  },
)
Input.displayName = 'Input'

export { Input }
