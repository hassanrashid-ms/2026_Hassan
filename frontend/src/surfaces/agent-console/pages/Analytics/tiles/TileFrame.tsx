import type { ReactNode } from 'react'
import { GripVertical, X } from 'lucide-react'
import { cn } from '../../../lib/cn.ts'

type TileFrameProps = {
  title: string
  onRemove?: () => void
  dragHandleClassName?: string
  children: ReactNode
}

export function TileFrame({ title, onRemove, dragHandleClassName = 'tile-drag-handle', children }: TileFrameProps) {
  return (
    <div className="flex h-full flex-col rounded-card border border-accent-soft bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <GripVertical className={cn('h-4 w-4 cursor-grab text-muted', dragHandleClassName)} />
          <span className="text-sm font-medium text-text">{title}</span>
        </div>
        {onRemove && (
          <button
            type="button"
            aria-label="Remove tile"
            onClick={onRemove}
            className="rounded p-1 text-muted hover:bg-accent-soft hover:text-text"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}
