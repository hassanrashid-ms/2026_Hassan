import type { AnalyticsGranularity, AnalyticsResponse, DashboardLayout } from '@support/types'
import { apiCall } from '../../../lib/httpClient.ts'

export type AnalyticsRangeParams = { from: string; to: string; granularity: AnalyticsGranularity }

export function fetchAnalytics(token: string, range: AnalyticsRangeParams): Promise<AnalyticsResponse> {
  const params = new URLSearchParams(range)
  return apiCall(`/agent/analytics?${params.toString()}`, token)
}

export function fetchLayout(token: string): Promise<{ layout: DashboardLayout }> {
  return apiCall('/agent/analytics/layout', token)
}

export function saveLayout(token: string, layout: DashboardLayout): Promise<{ ok: true }> {
  return apiCall('/agent/analytics/layout', token, { method: 'PUT', body: JSON.stringify({ layout }) })
}
