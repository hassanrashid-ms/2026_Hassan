import * as React from 'react'
import { cn } from '../../lib/cn.ts'

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-card bg-slate-200', className)} {...props} />
}

export { Skeleton }
