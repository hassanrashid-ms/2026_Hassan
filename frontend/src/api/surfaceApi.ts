import type { BootstrapResponse, PublicArticleDetail, PublicArticlesResponse, PublicIntentsResponse } from '@support/types'
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

export function fetchIntents(token: string): Promise<PublicIntentsResponse> {
  return apiCall<PublicIntentsResponse>('/surface/intents', token)
}

export function fetchArticles(token: string, search?: string, intentId?: string): Promise<PublicArticlesResponse> {
  const params = new URLSearchParams()
  if (search) params.set('q', search)
  if (intentId) params.set('intentId', intentId)
  const query = params.toString() ? `?${params.toString()}` : ''
  return apiCall<PublicArticlesResponse>(`/surface/articles${query}`, token)
}

export function fetchArticleDetail(token: string, id: string): Promise<PublicArticleDetail> {
  return apiCall<PublicArticleDetail>(`/surface/articles/${id}`, token)
}

