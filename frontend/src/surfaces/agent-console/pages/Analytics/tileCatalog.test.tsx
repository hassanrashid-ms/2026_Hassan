import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AnalyticsResponse } from '@support/types'
import { renderTile, TILE_IDS } from './tileCatalog.tsx'

const DATA: AnalyticsResponse = {
  range: { from: '2026-08-01', to: '2026-08-31', granularity: 'day' },
  volume: {
    series: [{ bucket: '2026-08-01', opened: 3, resolved: 1 }],
    byStatus: [{ status: 'open', count: 2 }],
    openTotal: 2,
    byPriority: [{ priority: 'p3', count: 2 }],
  },
  speed: {
    firstResponse: { avgSeconds: 120, p50Seconds: 90, p90Seconds: 300, series: [] },
    resolution: { avgSeconds: 3600, p50Seconds: 2000, p90Seconds: 9000, series: [] },
    timeToClaim: { series: [] },
  },
  bot: { containmentRate: 0.4, selfServeRate: 0.7, handoff: { rate: 0.6, byReason: [] }, articleHitRate: 0.5 },
  team: { avgOpenPerActiveAgent: 4.2, unassignedQueueDepth: { series: [] } },
}

describe('tileCatalog', () => {
  it('every declared tile id renders without throwing', () => {
    for (const id of TILE_IDS) {
      render(<div>{renderTile(id, DATA)}</div>)
    }
    expect(screen.getAllByText(/./).length).toBeGreaterThan(0)
  })

  it('renders the open-total tile with the correct value', () => {
    render(<div>{renderTile('open-total', DATA)}</div>)
    expect(screen.getByText('2')).toBeInTheDocument()
  })
})
