import { useQuery } from '@tanstack/react-query';
import { useSupport } from '@/surfaces/webview/components/SupportContext';
import { fetchArticleDetail } from '@/surfaces/webview/api/surfaceApi';

/**
 * Shared by ArticleSheet (which renders the body) and SupportHome (which only
 * needs the title for the deep-link top bar). Same query key both times, so
 * TanStack dedupes them into one request rather than two.
 */
export function useArticleDetail(articleId: string | null) {
  const { boot } = useSupport();

  return useQuery({
    queryKey: ['surfaceArticleDetail', boot?.token, articleId],
    queryFn: () => fetchArticleDetail(boot!.token, articleId!),
    enabled: boot !== null && articleId !== null,
  });
}
