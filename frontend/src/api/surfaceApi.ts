import type { BootstrapResponse } from '@support/types'
import { apiCall } from './httpClient.ts'

export function fetchBootstrap(token: string, sessionId: string): Promise<BootstrapResponse> {
  return apiCall<BootstrapResponse>(`/surface/bootstrap?session_id=${encodeURIComponent(sessionId)}`, token)
}

export function reportArticleRead(token: string, sessionId: string, articleId: string): Promise<{ ok: true }> {
  return apiCall<{ ok: true }>('/surface/events/article_read', token, {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, article_id: articleId }),
  })
}
