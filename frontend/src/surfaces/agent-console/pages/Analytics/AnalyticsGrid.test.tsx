import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AnalyticsResponse, DashboardLayout } from '@support/types';
import { AnalyticsGrid } from './AnalyticsGrid.tsx';

const LAYOUT: DashboardLayout = {
  items: [{ i: 'open-total', x: 0, y: 0, w: 3, h: 1 }],
  visibleTileIds: ['open-total'],
};

const DATA: AnalyticsResponse = {
  range: { from: '2026-08-01', to: '2026-08-31', granularity: 'day' },
  volume: { series: [], byStatus: [], openTotal: 5, byPriority: [] },
  speed: {
    firstResponse: { avgSeconds: null, p50Seconds: null, p90Seconds: null, series: [] },
    resolution: { avgSeconds: null, p50Seconds: null, p90Seconds: null, series: [] },
    timeToClaim: { series: [] },
  },
  bot: {
    containmentRate: null,
    selfServeRate: null,
    handoff: { rate: null, byReason: [] },
    articleHitRate: null,
  },
  team: { avgOpenPerActiveAgent: null, unassignedQueueDepth: { series: [] } },
  articles: { topCited: [], topRead: [] },
};

describe('AnalyticsGrid', () => {
  it('renders skeletons for every layout item while loading', () => {
    render(<AnalyticsGrid layout={LAYOUT} data={undefined} isLoading onLayoutChange={vi.fn()} />);
    expect(screen.queryByText('5')).not.toBeInTheDocument();
  });

  it('renders real tile content once data has loaded', () => {
    render(
      <AnalyticsGrid layout={LAYOUT} data={DATA} isLoading={false} onLayoutChange={vi.fn()} />,
    );
    expect(screen.getByText('5')).toBeInTheDocument();
  });
});
