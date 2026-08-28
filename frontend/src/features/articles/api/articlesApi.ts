import type { PublicArticleDetail, PublicArticlesResponse } from '@support/types';
import { apiCall } from '../../../lib/httpClient.ts';
import { buildArticleSearchParams } from '../lib/articleSearch.ts';

export function fetchPublicArticles(
  token: string,
  filter: { q?: string; intentId?: string } = {},
): Promise<PublicArticlesResponse> {
  const params = buildArticleSearchParams(filter);
  const query = params.toString();
  return apiCall(`/surface/articles${query ? `?${query}` : ''}`, token);
}

export function fetchPublicArticle(token: string, id: string): Promise<PublicArticleDetail> {
  return apiCall(`/surface/articles/${id}`, token);
}
