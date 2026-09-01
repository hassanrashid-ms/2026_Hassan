import { ResponsiveGridLayout, useContainerWidth } from 'react-grid-layout'
import type { AnalyticsResponse, DashboardLayout, DashboardLayoutItem } from '@support/types'
import { TileSkeleton } from './tiles/TileSkeleton.tsx'
import { renderTile } from './tileCatalog.tsx'
import 'react-grid-layout/css/styles.css'

// Tile ids that render as a single number, vs. everything else (chart) — used
// only to pick the right skeleton shape while loading.
const NUMBER_TILE_IDS = new Set([
  'open-total',
  'first-response-time',
  'resolution-time',
  'bot-containment',
  'article-hit-rate',
  'avg-open-per-agent',
])

type AnalyticsGridProps = {
  layout: DashboardLayout
  data: AnalyticsResponse | undefined
  isLoading: boolean
  onLayoutChange: (items: DashboardLayoutItem[]) => void
}

export function AnalyticsGrid({ layout, data, isLoading, onLayoutChange }: AnalyticsGridProps) {
  const { width, containerRef, mounted } = useContainerWidth()
  const visibleItems = layout.items.filter((item) => layout.visibleTileIds.includes(item.i))

  return (
    <div ref={containerRef}>
      {mounted && (
        <ResponsiveGridLayout
          className="relative"
          width={width}
          layouts={{ lg: visibleItems }}
          breakpoints={{ lg: 1024, sm: 0 }}
          cols={{ lg: 12, sm: 1 }}
          rowHeight={100}
          dragConfig={{ handle: '.tile-drag-handle' }}
          onLayoutChange={(current) => {
            onLayoutChange(
              current.map((item) => ({
                i: item.i,
                x: item.x,
                y: item.y,
                w: item.w,
                h: item.h,
                minW: item.minW,
                minH: item.minH,
              })),
            )
          }}
        >
          {visibleItems.map((item) => (
            <div key={item.i}>
              {isLoading || !data ? (
                <TileSkeleton kind={NUMBER_TILE_IDS.has(item.i) ? 'number' : 'chart'} />
              ) : (
                renderTile(item.i, data)
              )}
            </div>
          ))}
        </ResponsiveGridLayout>
      )}
    </div>
  )
}
