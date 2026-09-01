import { useState } from 'react'
import { subDays, startOfDay, formatISO } from 'date-fns'
import { useAnalyticsData } from './useAnalyticsData.ts'
import { useTileLayout } from './useTileLayout.ts'
import { AnalyticsTimeRangeBar } from './AnalyticsTimeRangeBar.tsx'
import { AnalyticsGrid } from './AnalyticsGrid.tsx'
import { Button } from '../../components/ui/button.tsx'

function toDateOnly(d: Date): string {
  return formatISO(d, { representation: 'date' })
}

export function Analytics() {
  const [range, setRange] = useState({ from: startOfDay(subDays(new Date(), 30)), to: new Date() })
  const { layout, updateLayout, isLoading: layoutLoading } = useTileLayout()
  const { data, isLoading, isError, refetch } = useAnalyticsData({
    from: toDateOnly(range.from),
    to: toDateOnly(range.to),
    granularity: 'day',
  })

  const isEmpty = data && data.volume.openTotal === 0 && data.volume.series.every((s) => s.opened === 0 && s.resolved === 0)

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-text">Analytics</h1>
        <AnalyticsTimeRangeBar value={range} onChange={setRange} />
      </div>

      {isError && (
        <div className="flex items-center justify-between rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <span>Couldn&apos;t load analytics data.</span>
          <Button type="button" variant="ghost" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
          <p className="text-sm font-medium text-text">No data yet</p>
          <p className="text-sm text-muted">No conversations in the selected range. Try a wider range.</p>
        </div>
      ) : (
        layout && (
          <AnalyticsGrid
            layout={layout}
            data={data}
            isLoading={isLoading || layoutLoading}
            onLayoutChange={(items) => updateLayout({ ...layout, items })}
            onRemoveTile={(id) => updateLayout({ ...layout, visibleTileIds: layout.visibleTileIds.filter((t) => t !== id) })}
          />
        )
      )}
    </div>
  )
}
