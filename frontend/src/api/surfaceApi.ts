import type { BootstrapResponse, PublicArticleDetail, PublicArticlesResponse } from '@support/types'
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

export function fetchArticles(token: string, search?: string): Promise<PublicArticlesResponse> {
  const query = search ? `?q=${encodeURIComponent(search)}` : ''
  return apiCall<PublicArticlesResponse>(`/surface/articles${query}`, token)
}

export function fetchArticleDetail(token: string, id: string): Promise<PublicArticleDetail> {
  return apiCall<PublicArticleDetail>(`/surface/articles/${id}`, token)
}

