import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';
import { cn } from '../../lib/cn.ts';

/**
 * Shared "nothing here" placeholder — a muted line icon (never an emoji) plus
 * one line of copy, for any list/table that can legitimately be empty (a
 * fresh workspace, a cleared filter, an empty queue).
 */
export function EmptyState({
  icon: Icon = Inbox,
  message = 'Nothing to show',
  className,
}: {
  icon?: LucideIcon;
  message?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-3 py-10 text-muted',
        className,
      )}
    >
      <Icon className="size-8 stroke-[1.5]" />
      <p className="text-sm">{message}</p>
    </div>
  );
}
