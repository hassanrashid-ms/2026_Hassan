import * as React from 'react';
import { cn } from '../../lib/cn.ts';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-slate-200 bg-bg px-3 py-1 text-sm shadow-xs transition-colors outline-none',
        'placeholder:text-muted disabled:pointer-events-none disabled:opacity-50',
        'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
