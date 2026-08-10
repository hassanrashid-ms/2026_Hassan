import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { MessageCircle } from 'lucide-react'
import { TopBar } from '@/surfaces/webview/components/TopBar'
import { SupportHero } from '@/surfaces/webview/components/SupportHero'
import { CategoryTabs } from '@/surfaces/webview/components/CategoryTabs'
import { ArticleCard } from '@/surfaces/webview/components/ArticleCard'
import { ArticleSheet } from '@/surfaces/webview/components/ArticleSheet'
import { DebugDialog } from '@/surfaces/webview/components/DebugDialog'
import { SupportButton } from '@/surfaces/webview/components/SupportButton'
import { ArticleListSkeleton, BootstrapFailedScreen, EmptyState } from '@/surfaces/webview/components/StateScreens'
import { useGameName, useSupport } from '@/surfaces/webview/components/SupportContext'
import { useReadArticles } from '@/surfaces/webview/hooks/useReadArticles'
import { useArticleDetail } from '@/surfaces/webview/hooks/useArticleDetail'
import { useCloseOverlay } from '@/surfaces/webview/hooks/useCloseOverlay'
import { fetchArticles, fetchIntents } from '@/surfaces/webview/api/surfaceApi'

/**
 * Also serves /embed/support/articles/:id — the deep link is this screen with the
 * article sheet already open over it, so the player who closes it lands somewhere
 * real rather than on a blank route.
 */
export function SupportHome() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const articleId = id ?? null

  const { boot, error, retry } = useSupport()
  const gameName = useGameName()
  const isRead = useReadArticles()
  const closeSheet = useCloseOverlay('/embed/support')

  const [intentId, setIntentId] = useState<string | null>(null)
  const [debugOpen, setDebugOpen] = useState(false)

  const intentsQuery = useQuery({
    queryKey: ['surfaceIntents', boot?.token],
    queryFn: () => fetchIntents(boot!.token),
    enabled: boot !== null,
  })

  // No `q` here: home is the browse view. Search is its own screen and its own
  // query key, so moving home → search → home hits cache both ways.
  const articlesQuery = useQuery({
    queryKey: ['surfaceArticles', boot?.token, '', intentId],
    queryFn: () => fetchArticles(boot!.token, undefined, intentId || undefined),
    enabled: boot !== null,
  })

  // Only for the deep-link top bar title. Same query key as the sheet's, so this
  // costs no extra request.
  const deepLinked = useArticleDetail(articleId)

  const articles = articlesQuery.data?.articles

  if (error !== null && boot !== null) {
    return (
      <>
        <TopBar variant="home" onOpenDebug={() => setDebugOpen(true)} />
        <BootstrapFailedScreen message={error} onRetry={retry} />
        <DebugDialog open={debugOpen} onOpenChange={setDebugOpen} />
      </>
    )
  }

  return (
    <>
      {articleId === null ? (
        <TopBar variant="home" onOpenDebug={() => setDebugOpen(true)} />
      ) : (
        <TopBar variant="article" title={deepLinked.data?.title ?? 'Article'} onOpenDebug={() => setDebugOpen(true)} />
      )}

      {/* The one scroll region on this screen. The shell frame is overflow-hidden. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <SupportHero gameName={gameName} onSearchTap={() => navigate('/embed/support/search')} />

        <div className="flex flex-col gap-4 px-4 pt-5 pb-8">
          {intentsQuery.data?.intents && (
            <CategoryTabs
              intents={intentsQuery.data.intents}
              intentId={intentId}
              onIntentChange={setIntentId}
            />
          )}

          {articlesQuery.isPending ? (
            <ArticleListSkeleton />
          ) : articles === undefined || articles.length === 0 ? (
            <EmptyState title="No articles yet" body="Nothing has been published for this game so far." />
          ) : (
            <div className="flex flex-col gap-3">
              {/*
                Rendered in the order the API returned. That order is Weaviate's
                BM25 ranking, reconstructed server-side; sorting or filtering this
                array here would discard relevance and look like nothing is wrong.
              */}
              {articles.map((article) => (
                <ArticleCard
                  key={article.id}
                  title={article.title}
                  keywords={article.keywords}
                  read={isRead(article.id)}
                  onOpen={() => navigate(`/embed/support/articles/${article.id}`)}
                />
              ))}
            </div>
          )}

          {/* No dead ends: whatever the articles did or didn't answer, a person is
              always one tap away from here. */}
          <div className="mt-2 flex flex-col gap-2 rounded-card bg-surface p-5">
            <p className="text-base font-semibold text-text">Still need help?</p>
            <p className="text-sm text-muted">Send us a message and someone will get back to you.</p>
            <SupportButton className="mt-2" onClick={() => navigate('/embed/support/chat')}>
              <MessageCircle className="size-5" />
              Talk to a person
            </SupportButton>
          </div>
        </div>
      </div>

      <ArticleSheet articleId={articleId} onClose={closeSheet} />
      <DebugDialog open={debugOpen} onOpenChange={setDebugOpen} />
    </>
  )
}
