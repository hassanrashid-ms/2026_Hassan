import * as React from 'react';
import { cn } from '@/surfaces/webview/lib/cn';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-card bg-surface', className)} {...props} />;
}

export { Skeleton };
