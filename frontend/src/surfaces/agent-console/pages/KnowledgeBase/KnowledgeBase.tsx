import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { loadAgentSession } from '../../lib/agentSession.ts';
import { ArticleTable } from './components/ArticleTable.tsx';
import { ArticleEditorSheet } from './components/ArticleEditorSheet.tsx';

export function KnowledgeBase() {
  const session = loadAgentSession();
  /*
   * Route param seeds selection so /articles/:id is a real deep link — that is
   * what a conversation's "Read more" opens, in its own tab, and it is also what
   * lets an agent share an article by URL. In-page selection still works exactly
   * as before: it sets state and does not touch the URL, so nothing about the
   * list's own behaviour changes.
   */
  const { id: routeArticleId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(routeArticleId ?? null);
  const [sheetOpen, setSheetOpen] = useState(routeArticleId !== undefined);

  if (!session) return null;

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1">
        <ArticleTable
          token={session.token}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setSheetOpen(true);
          }}
          onNew={() => {
            setSelectedId(null);
            setSheetOpen(true);
          }}
        />
      </div>
      <ArticleEditorSheet
        token={session.token}
        session={session}
        articleId={selectedId}
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open);
          if (!open) {
            setSelectedId(null);
            // Closing a deep-linked sheet must also leave the deep link, or the
            // URL still names an article that is no longer on screen — and a
            // reload would reopen it.
            if (routeArticleId) navigate('/articles', { replace: true });
          }
        }}
        onCreated={(id) => setSelectedId(id)}
      />
    </div>
  );
}
