import { describe, expect, it } from 'vitest';
import type { AnalyticsResponse, DashboardLayout } from '../src/analytics.ts';

describe('analytics types', () => {
  it('AnalyticsResponse shape compiles with every metric group present', () => {
    const sample: AnalyticsResponse = {
      range: { from: '2026-08-01', to: '2026-08-31', granularity: 'day' },
      volume: {
        series: [{ bucket: '2026-08-01', opened: 3, resolved: 1 }],
        byStatus: [{ status: 'open', count: 2 }],
        openTotal: 2,
        byPriority: [{ priority: 'p3', count: 2 }],
      },
      speed: {
        firstResponse: {
          avgSeconds: 120,
          p50Seconds: 90,
          p90Seconds: 300,
          series: [{ bucket: '2026-08-01', seconds: 100 }],
        },
        resolution: {
          avgSeconds: 3600,
          p50Seconds: 2000,
          p90Seconds: 9000,
          series: [{ bucket: '2026-08-01', seconds: 3000 }],
        },
        timeToClaim: { series: [{ bucket: '2026-08-01', seconds: 60 }] },
      },
      bot: {
        containmentRate: 0.4,
        selfServeRate: 0.7,
        handoff: { rate: 0.6, byReason: [{ reason: 'article_rejected', count: 3 }] },
        articleHitRate: 0.5,
      },
      team: {
        avgOpenPerActiveAgent: 4.2,
        unassignedQueueDepth: { series: [{ bucket: '2026-08-01', depth: 5 }] },
      },
      articles: {
        topCited: [{ articleId: 'a1', title: 'Reset your password', count: 5 }],
        topRead: [{ articleId: 'a2', title: 'Redeem a gift code', count: 8 }],
      },
    };
    expect(sample.range.granularity).toBe('day');
  });

  it('DashboardLayout carries items and visible tile ids', () => {
    const layout: DashboardLayout = {
      items: [{ i: 'volume-series', x: 0, y: 0, w: 4, h: 2 }],
      visibleTileIds: ['volume-series'],
    };
    expect(layout.items).toHaveLength(1);
  });
});
