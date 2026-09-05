export type AnalyticsGranularity = 'day' | 'week';

export type AnalyticsRange = {
  from: string;
  to: string;
  granularity: AnalyticsGranularity;
};

export type AnalyticsResponse = {
  range: AnalyticsRange;
  volume: {
    series: Array<{ bucket: string; opened: number; resolved: number }>;
    byStatus: Array<{ status: string; count: number }>;
    openTotal: number;
    byPriority: Array<{ priority: string; count: number }>;
  };
  speed: {
    firstResponse: {
      avgSeconds: number | null;
      p50Seconds: number | null;
      p90Seconds: number | null;
      series: Array<{ bucket: string; seconds: number | null }>;
    };
    resolution: {
      avgSeconds: number | null;
      p50Seconds: number | null;
      p90Seconds: number | null;
      series: Array<{ bucket: string; seconds: number | null }>;
    };
    timeToClaim: {
      series: Array<{ bucket: string; seconds: number | null }>;
    };
  };
  bot: {
    containmentRate: number | null;
    selfServeRate: number | null;
    handoff: { rate: number | null; byReason: Array<{ reason: string; count: number }> };
    articleHitRate: number | null;
  };
  team: {
    avgOpenPerActiveAgent: number | null;
    unassignedQueueDepth: { series: Array<{ bucket: string; depth: number }> };
  };
  articles: {
    topCited: Array<{ articleId: string; title: string; count: number }>;
    topRead: Array<{ articleId: string; title: string; count: number }>;
  };
};

export type DashboardLayoutItem = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
};

export type DashboardLayout = {
  items: DashboardLayoutItem[];
  visibleTileIds: string[];
};
