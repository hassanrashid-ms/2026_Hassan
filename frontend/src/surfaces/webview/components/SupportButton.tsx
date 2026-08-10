import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/surfaces/webview/lib/cn'

type Variant = 'primary' | 'soft' | 'ghost'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg active:bg-accent-deep',
  soft: 'bg-accent-soft text-accent active:bg-accent-soft/70',
  ghost: 'bg-transparent text-muted active:bg-surface',
}

type SupportButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  children: ReactNode
}

/**
 * Hand-built rather than shadcn's Button: this surface needs game-scale touch
 * targets and a pressed state, and has no use for the hover/focus-ring vocabulary
 * shadcn's default styling is built around. There is no mouse here.
 */
export function SupportButton({ variant = 'primary', className, children, ...props }: SupportButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-card px-5 py-3',
        'text-base font-semibold transition-colors outline-none',
        'disabled:opacity-50',
        VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}
