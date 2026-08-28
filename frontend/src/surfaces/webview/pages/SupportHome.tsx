import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import { TopBar } from '@/surfaces/webview/components/TopBar';
import { SupportHero } from '@/surfaces/webview/components/SupportHero';
import { CategoryTabs } from '@/surfaces/webview/components/CategoryTabs';
import { ArticleCard } from '@/surfaces/webview/components/ArticleCard';
import { ArticleSheet } from '@/surfaces/webview/components/ArticleSheet';
import { SupportButton } from '@/surfaces/webview/components/SupportButton';
import {
  ArticleListSkeleton,
  BootstrapFailedScreen,
  EmptyState,
} from '@/surfaces/webview/components/StateScreens';
import { useGameName, useSupport } from '@/surfaces/webview/components/SupportContext';
import { useReadArticles } from '@/surfaces/webview/hooks/useReadArticles';
import { useArticleDetail } from '@/surfaces/webview/hooks/useArticleDetail';
import { useCloseOverlay } from '@/surfaces/webview/hooks/useCloseOverlay';
import { fetchArticles, fetchIntents } from '@/surfaces/webview/api/surfaceApi';

/**
 * Also serves /embed/support/articles/:id — the deep link is this screen with the
 * article sheet already open over it, so the player who closes it lands somewhere
 * real rather than on a blank route.
 */
export function SupportHome() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const articleId = id ?? null;

  const { boot, error, retry } = useSupport();
  const gameName = useGameName();
  const isRead = useReadArticles();
  const closeSheet = useCloseOverlay('/embed/support');

  const [intentId, setIntentId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(5);

  const intentsQuery = useQuery({
    queryKey: ['surfaceIntents', boot?.token],
    queryFn: () => fetchIntents(boot!.token),
    enabled: boot !== null,
  });

  // No `q` here: home is the browse view. Search is its own screen and its own
  // query key, so moving home → search → home hits cache both ways.
  const articlesQuery = useQuery({
    queryKey: ['surfaceArticles', boot?.token, '', intentId],
    queryFn: () => fetchArticles(boot!.token, undefined, intentId || undefined),
    enabled: boot !== null,
  });

  // Only for the deep-link top bar title. Same query key as the sheet's, so this
  // costs no extra request.
  const deepLinked = useArticleDetail(articleId);

  const articles = articlesQuery.data?.articles;

  if (error !== null && boot !== null) {
    return (
      <>
        <TopBar variant="home" />
        <BootstrapFailedScreen message={error} onRetry={retry} />
      </>
    );
  }

  return (
    <>
      {articleId === null ? (
        <TopBar variant="home" />
      ) : (
        <TopBar variant="article" title={deepLinked.data?.title ?? 'Article'} />
      )}

      {/* The one scroll region on this screen. The shell frame is overflow-hidden. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <SupportHero gameName={gameName} onSearchTap={() => navigate('/embed/support/search')} />

        <div className="flex flex-col gap-4 px-4 pt-5 pb-8">
          {intentsQuery.data?.intents && (
            <CategoryTabs
              intents={intentsQuery.data.intents}
              intentId={intentId}
              onIntentChange={(newIntent) => {
                setIntentId(newIntent);
                setVisibleCount(5);
              }}
            />
          )}

          {articlesQuery.isPending ? (
            <ArticleListSkeleton />
          ) : articles === undefined || articles.length === 0 ? (
            <EmptyState
              title="No articles yet"
              body="Nothing has been published for this game so far."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {/*
                Rendered in the order the API returned. That order is Weaviate's
                BM25 ranking, reconstructed server-side; sorting or filtering this
                array here would discard relevance and look like nothing is wrong.
              */}
              {articles.slice(0, visibleCount).map((article) => (
                <ArticleCard
                  key={article.id}
                  title={article.title}
                  read={isRead(article.id)}
                  onOpen={() => navigate(`/embed/support/articles/${article.id}`)}
                />
              ))}
              {articles.length > visibleCount && (
                <SupportButton variant="soft" onClick={() => setVisibleCount((c) => c + 5)}>
                  Show more
                </SupportButton>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-muted/15 bg-bg p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="flex flex-col gap-1.5 text-center mb-3">
          <p className="text-sm font-semibold text-text">Still need help?</p>
          <p className="text-xs text-muted">
            Send us a message and our support bot will help you right away.
          </p>
        </div>
        <SupportButton className="w-full" onClick={() => navigate('/embed/support/chat')}>
          <MessageCircle className="size-5" />
          Talk to Support
        </SupportButton>
      </div>

      <ArticleSheet articleId={articleId} onClose={closeSheet} />
    </>
  );
}
