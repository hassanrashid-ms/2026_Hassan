import { lazy, Suspense, useEffect } from 'react';
import { Badge } from '@/surfaces/webview/components/ui/badge';
import { ScrollArea } from '@/surfaces/webview/components/ui/scroll-area';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/surfaces/webview/components/ui/drawer';
import { Skeleton } from '@/surfaces/webview/components/ui/skeleton';
import { useSupport } from '@/surfaces/webview/components/SupportContext';
import { hasReadArticle, markArticleRead } from '@/surfaces/webview/hooks/useReadArticles';
import { useArticleDetail } from '@/surfaces/webview/hooks/useArticleDetail';
import { reportArticleRead } from '@/surfaces/webview/api/surfaceApi';
import { post } from '@/services/bridgeService';
/*
 * Loaded on demand, not with the home screen.
 *
 * SupportHome renders this sheet eagerly so the drawer can animate, which means a
 * static import here lands react-markdown and remark-gfm on the critical path of
 * the very first page load — ~790KB of unminified dev bundle before the player has
 * opened a single article. Over a tunnelled dev server that alone blew past the
 * SDK's 8s load timeout and the surface never opened at all.
 *
 * The renderer is only needed once an article is on screen, so it waits until then.
 */
const ArticleBody = lazy(() =>
  import('@/features/articles/components/ArticleBody').then((m) => ({ default: m.ArticleBody })),
);

/** Matches the pending-article skeleton below, so the swap is invisible. */
function BodySkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <Skeleton className="h-4 w-full bg-muted/15" />
      <Skeleton className="h-4 w-full bg-muted/15" />
      <Skeleton className="h-4 w-4/5 bg-muted/15" />
      <Skeleton className="h-4 w-2/3 bg-muted/15" />
    </div>
  );
}

type ArticleSheetProps = {
  /** null closes the sheet. Driven by the route so Android back closes it. */
  articleId: string | null;
  onClose: () => void;
};

export function ArticleSheet({ articleId, onClose }: ArticleSheetProps) {
  const { boot } = useSupport();

  const article = useArticleDetail(articleId);

  /*
   * Exactly once per article per session, as today: the module store is the guard,
   * so remounting the sheet — or arriving at the same article from search after
   * reading it on home — does not emit a second read.
   */
  useEffect(() => {
    if (!boot || articleId === null) return;
    if (hasReadArticle(articleId)) return;
    markArticleRead(articleId);
    void reportArticleRead(boot.token, boot.sessionId, articleId).catch(() => {});
    post({ type: 'article_read', id: articleId });
  }, [boot, articleId]);

  return (
    <Drawer open={articleId !== null} onOpenChange={(open) => !open && onClose()}>
      <DrawerContent className="h-[90dvh]">
        <DrawerHeader>
          {article.data ? (
            <DrawerTitle className="text-xl leading-snug">{article.data.title}</DrawerTitle>
          ) : (
            <>
              {/* Radix requires an accessible title on every dialog; a visually
                  hidden one keeps the contract while the real one loads. */}
              <DrawerTitle className="sr-only">Loading article</DrawerTitle>
              <Skeleton className="h-6 w-2/3 bg-muted/15" />
            </>
          )}
          <DrawerDescription className="sr-only">Help article</DrawerDescription>
        </DrawerHeader>

        {article.data && article.data.keywords.length > 0 && (
          <div className="flex shrink-0 flex-wrap gap-1.5 px-4 pb-3">
            {article.data.keywords.map((keyword) => (
              <Badge key={keyword} variant="soft">
                {keyword}
              </Badge>
            ))}
          </div>
        )}

        {/* The sheet does not scroll; this region does. */}
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-4 pb-10">
            {article.data ? (
              <Suspense fallback={<BodySkeleton />}>
                <ArticleBody markdown={article.data.body} />
              </Suspense>
            ) : article.isError ? (
              <p className="text-base text-muted">
                This article could not be loaded. Close and try another.
              </p>
            ) : (
              <BodySkeleton />
            )}
          </div>
        </ScrollArea>
      </DrawerContent>
    </Drawer>
  );
}
