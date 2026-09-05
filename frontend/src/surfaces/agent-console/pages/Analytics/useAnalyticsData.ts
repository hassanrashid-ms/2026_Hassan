import { useQuery } from '@tanstack/react-query';
import type { AnalyticsGranularity } from '@support/types';
import { fetchAnalytics } from '../../api/analyticsApi.ts';
import { loadAgentSession } from '../../lib/agentSession.ts';

export function useAnalyticsData(range: {
  from: string;
  to: string;
  granularity: AnalyticsGranularity;
}) {
  const session = loadAgentSession();
  return useQuery({
    queryKey: ['analytics', range.from, range.to, range.granularity],
    queryFn: () => fetchAnalytics(session!.token, range),
    enabled: session !== null,
  });
}
