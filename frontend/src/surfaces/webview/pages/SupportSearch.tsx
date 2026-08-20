import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { TopBar } from '@/surfaces/webview/components/TopBar'
import { ArticleCard } from '@/surfaces/webview/components/ArticleCard'
import { ArticleListSkeleton, EmptyState } from '@/surfaces/webview/components/StateScreens'
import { useSupport } from '@/surfaces/webview/components/SupportContext'
import { useReadArticles } from '@/surfaces/webview/hooks/useReadArticles'
import { fetchArticles } from '@/surfaces/webview/api/surfaceApi'

/**
 * 800ms to match the previous surface behavior.
 */
const DEBOUNCE_MS = 800

export function SupportSearch() {
  const navigate = useNavigate()
  const { boot } = useSupport()
  const isRead = useReadArticles()

  /*
   * The query lives in the URL, not in component state. Opening an article is a
   * real navigation, so the search screen unmounts; keeping `q` in the location
   * means coming back — by the Cancel button, by Android's back button, or by
   * closing the article sheet — restores the results the player was looking at,
   * and TanStack serves them from cache without a refetch.
   */
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const [debounced, setDebounced] = useState(query)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  const trimmed = debounced.trim()

  const results = useQuery({
    queryKey: ['surfaceArticles', boot?.token, trimmed, null],
    queryFn: () => fetchArticles(boot!.token, trimmed, undefined),
    enabled: boot !== null && trimmed.length > 0,
  })

  const articles = results.data?.articles

  return (
    <>
      <TopBar
        variant="search"
        value={query}
        onValueChange={(value) => setParams(value ? { q: value } : {}, { replace: true })}
       
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-8">
        {trimmed.length === 0 ? (
          // Idle. Not an error and not an empty result — the player has simply not
          // typed anything yet, and saying "no results" here would be a lie.
          <EmptyState
            icon={<Search className="size-7" />}
            title="Search help articles"
            body="Type a word or two — a topic, an error message, anything."
          />
        ) : results.isPending ? (
          <ArticleListSkeleton count={3} />
        ) : articles === undefined || articles.length === 0 ? (
          // No local-filter fallback. If the server found nothing, there is
          // nothing — a client-side match here would invent relevance.
          <EmptyState title={`No results for “${trimmed}”`} body="Try a different word, or send us a message." />
        ) : (
          <div className="flex flex-col gap-3">
            {/* API order is Weaviate's BM25 ranking. Never re-sorted here. */}
            {articles.map((article) => (
              <ArticleCard
                key={article.id}
                title={article.title}
                read={isRead(article.id)}
                onOpen={() => navigate(`/embed/support/articles/${article.id}`)}
              />
            ))}
          </div>
        )}
      </div>

    </>
  )
}
