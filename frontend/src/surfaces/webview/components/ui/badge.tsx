import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/surfaces/webview/lib/cn';

// Divergence from stock shadcn: variants remapped to our tokens (accent/accent-soft
// instead of primary/secondary), "destructive" dropped (unused here), and no hover
// state — badges are static chips, not interactive controls, on this surface.
const badgeVariants = cva(
  'inline-flex items-center justify-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'bg-accent text-accent-fg',
        soft: 'bg-accent-soft text-accent',
        outline: 'border border-muted/30 text-muted',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
