import type { ReactNode } from 'react';
import { GripVertical } from 'lucide-react';
import { cn } from '../../../lib/cn.ts';

type TileFrameProps = {
  title: string;
  dragHandleClassName?: string;
  children: ReactNode;
};

export function TileFrame({
  title,
  dragHandleClassName = 'tile-drag-handle',
  children,
}: TileFrameProps) {
  return (
    <div className="flex h-full min-w-0 flex-col rounded-card border border-border bg-surface p-3 shadow-card">
      <div className="mb-2 flex min-w-0 items-center justify-between">
        <div className="flex min-w-0 items-center gap-1.5">
          <GripVertical
            className={cn('h-4 w-4 shrink-0 cursor-grab text-muted', dragHandleClassName)}
          />
          <span className="truncate text-sm font-medium text-text">{title}</span>
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
