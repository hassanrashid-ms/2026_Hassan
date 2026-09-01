import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { Analytics } from './Analytics.tsx'
import { loadAgentSession } from '../../lib/agentSession.ts'
import * as analyticsApi from '../../api/analyticsApi.ts'

vi.mock('../../lib/agentSession.ts')
vi.mock('../../api/analyticsApi.ts')

const EMPTY_DATA = {
  range: { from: '2026-08-01', to: '2026-08-31', granularity: 'day' as const },
  volume: { series: [], byStatus: [], openTotal: 0, byPriority: [] },
  speed: {
    firstResponse: { avgSeconds: null, p50Seconds: null, p90Seconds: null, series: [] },
    resolution: { avgSeconds: null, p50Seconds: null, p90Seconds: null, series: [] },
    timeToClaim: { series: [] },
  },
  bot: { containmentRate: null, handoff: { rate: null, byReason: [] }, articleHitRate: null },
  team: { avgOpenPerActiveAgent: null, unassignedQueueDepth: { series: [] } },
}

beforeEach(() => {
  vi.mocked(loadAgentSession).mockReturnValue({ token: 't' } as never)
  vi.mocked(analyticsApi.fetchLayout).mockResolvedValue({
    layout: { items: [{ i: 'open-total', x: 0, y: 0, w: 3, h: 1 }], visibleTileIds: ['open-total'] },
  })
})

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/analytics']}>
        <Analytics />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Analytics page', () => {
  it('shows an empty state when the workspace has zero conversations in range', async () => {
    vi.mocked(analyticsApi.fetchAnalytics).mockResolvedValue(EMPTY_DATA)

    renderPage()

    await waitFor(() => expect(screen.getByText(/no data yet/i)).toBeInTheDocument())
  })

  it('shows an inline retry banner on fetch failure', async () => {
    vi.mocked(analyticsApi.fetchAnalytics).mockRejectedValue(new Error('boom'))

    renderPage()

    await waitFor(() => expect(screen.getByText(/couldn.t load/i)).toBeInTheDocument())
  })
})
