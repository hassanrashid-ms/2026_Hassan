import { Badge } from '../../../components/ui/badge.tsx'
import { TileFrame } from './TileFrame.tsx'

type RankedListTileProps = {
  title: string
  items: Array<{ id: string; label: string; count: number }>
}

export function RankedListTile({ title, items }: RankedListTileProps) {
  const labelCounts = new Map<string, number>()
  for (const item of items) labelCounts.set(item.label, (labelCounts.get(item.label) ?? 0) + 1)

  return (
    <TileFrame title={title}>
      {items.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-muted">No data in this range</div>
      ) : (
        <ol className="space-y-2">
          {items.map((item, i) => {
            // Two distinct articles can share a title (duplicate content, or one
            // renamed after the other was created) — without this, identical rows
            // look like a rendering bug instead of two real, separate articles.
            const isAmbiguous = (labelCounts.get(item.label) ?? 0) > 1
            return (
              <li key={item.id} className="flex min-w-0 items-center gap-2.5 text-sm">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-text">
                  {item.label}
                  {isAmbiguous && <span className="ml-1.5 font-mono text-xs font-normal text-muted">#{item.id.slice(0, 8)}</span>}
                </span>
                <Badge variant="secondary" className="shrink-0 tabular-nums">
                  {item.count}
                </Badge>
              </li>
            )
          })}
        </ol>
      )}
    </TileFrame>
  )
}
