import type { AnalyticsGranularity, AnalyticsResponse, DashboardLayout } from '@support/types';
import { apiCall } from '../../../lib/httpClient.ts';
import { loadAgentSession } from '../lib/agentSession.ts';

export type AnalyticsRangeParams = { from: string; to: string; granularity: AnalyticsGranularity };

// Every /agent/* call needs X-Workspace-Id since the JWT no longer carries a
// workspace claim — mirrors the `call()` wrapper in agentApi.ts.
function call<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  return apiCall(path, token, init, loadAgentSession()?.workspaceId);
}

export function fetchAnalytics(
  token: string,
  range: AnalyticsRangeParams,
): Promise<AnalyticsResponse> {
  const params = new URLSearchParams(range);
  return call(`/agent/analytics?${params.toString()}`, token);
}

export function fetchLayout(token: string): Promise<{ layout: DashboardLayout }> {
  return call('/agent/analytics/layout', token);
}

export function saveLayout(token: string, layout: DashboardLayout): Promise<{ ok: true }> {
  return call('/agent/analytics/layout', token, {
    method: 'PUT',
    body: JSON.stringify({ layout }),
  });
}
