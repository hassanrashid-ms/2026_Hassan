import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import type { ArticleVersionedField } from '@support/types';
import {
  fetchArticleVersion,
  fetchArticleVersions,
  restoreArticleVersion,
} from '../../../api/agentApi.ts';
import { Button } from '../../../components/ui/button.tsx';
import { ScrollArea } from '../../../components/ui/scroll-area.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import { cn } from '../../../lib/cn.ts';
import { diffPromptText } from '../../BotConfig/lib/diffBotConfigVersion.ts';
import { diffAttachments, diffKeywords } from '../lib/diffArticleVersion.ts';

const FIELD_LABELS: Record<ArticleVersionedField, string> = {
  title: 'Title',
  body: 'Body',
  keywords: 'Keywords',
  attachments: 'Attachments',
};

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

function VersionDiff({
  token,
  articleId,
  version,
}: {
  token: string;
  articleId: string;
  version: number;
}) {
  const currentQuery = useQuery({
    queryKey: ['article-version', articleId, version],
    queryFn: () => fetchArticleVersion(token, articleId, version),
  });
  const priorQuery = useQuery({
    queryKey: ['article-version', articleId, version - 1],
    queryFn: () => fetchArticleVersion(token, articleId, version - 1),
    enabled: version > 1,
  });

  if (currentQuery.isLoading || (version > 1 && priorQuery.isLoading)) {
    return <p className="text-xs text-muted">Loading diff…</p>;
  }
  if (version === 1 || !priorQuery.data) {
    return <p className="text-xs text-muted">No prior changes.</p>;
  }
  const current = currentQuery.data;
  const prior = priorQuery.data;
  if (!current) return null;

  const titleTokens =
    current.title !== prior.title ? diffPromptText(prior.title, current.title) : null;
  const bodyTokens = current.body !== prior.body ? diffPromptText(prior.body, current.body) : null;
  const keywordEntries = diffKeywords(prior.keywords, current.keywords);
  const attachmentEntries = diffAttachments(prior.attachments, current.attachments);

  return (
    <div className="flex flex-col gap-2 text-xs">
      {titleTokens && (
        <div>
          <p className="font-medium">Title</p>
          <p className="rounded bg-slate-50 p-2 font-mono">
            {titleTokens.map((token, i) => (
              <span
                key={i}
                className={
                  token.type === 'added'
                    ? 'bg-green-100 text-green-800'
                    : token.type === 'removed'
                      ? 'bg-red-100 text-red-800 line-through'
                      : undefined
                }
              >
                {token.text}{' '}
              </span>
            ))}
          </p>
        </div>
      )}
      {bodyTokens && (
        <div>
          <p className="font-medium">Body</p>
          <p className="rounded bg-slate-50 p-2 font-mono">
            {bodyTokens.map((token, i) => (
              <span
                key={i}
                className={
                  token.type === 'added'
                    ? 'bg-green-100 text-green-800'
                    : token.type === 'removed'
                      ? 'bg-red-100 text-red-800 line-through'
                      : undefined
                }
              >
                {token.text}{' '}
              </span>
            ))}
          </p>
        </div>
      )}
      {[...keywordEntries, ...attachmentEntries].map((entry) => (
        <p key={entry.key}>{entry.description}</p>
      ))}
    </div>
  );
}

export function ArticleVersionHistoryTab({
  token,
  articleId,
  onRestored,
}: {
  token: string;
  articleId: string;
  onRestored: () => void;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);

  const versionsQuery = useQuery({
    queryKey: ['article-versions', articleId],
    queryFn: () => fetchArticleVersions(token, articleId, { limit: 50 }),
  });

  const restore = useMutation({
    mutationFn: (version: number) => restoreArticleVersion(token, articleId, version),
    onSuccess: (updated) => {
      setRestoreTarget(null);
      queryClient.setQueryData(['admin-article', articleId], updated);
      void queryClient.invalidateQueries({ queryKey: ['admin-articles'] });
      onRestored();
    },
  });

  const versions = versionsQuery.data?.versions ?? [];
  const currentVersion = versions[0]?.version ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-2">
          {versions.map((entry) => {
            const isExpanded = expanded === entry.version;
            return (
              <li key={entry.version} className="rounded-md border border-slate-200 text-xs">
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md p-2 text-left hover:bg-slate-50"
                  onClick={() => setExpanded((v) => (v === entry.version ? null : entry.version))}
                >
                  <span className="flex items-center gap-2">
                    <ChevronRight
                      className={cn(
                        'size-3.5 shrink-0 text-muted transition-transform',
                        isExpanded && 'rotate-90',
                      )}
                    />
                    <span className="font-semibold">
                      v{entry.version}
                      {entry.version === currentVersion ? ' · Current' : ''}
                    </span>
                    <span className="text-muted">{entry.actor.display_name}</span>
                    <span className="text-muted">{relativeTime(entry.created_at)}</span>
                  </span>
                  <span className="flex gap-1">
                    {entry.changed_fields.map((field) => (
                      <span key={field} className="rounded bg-slate-100 px-1.5 py-0.5">
                        {FIELD_LABELS[field]}
                      </span>
                    ))}
                  </span>
                </button>
                <div className="px-2 pb-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setRestoreTarget(entry.version)}
                    disabled={restore.isPending || entry.version === currentVersion}
                  >
                    {entry.version === currentVersion ? 'Current version' : 'Restore this version'}
                  </Button>
                  {isExpanded && (
                    <div className="mt-2 border-t border-slate-100 pt-2">
                      <VersionDiff token={token} articleId={articleId} version={entry.version} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
          {versions.length === 0 && <li className="text-xs text-muted">No changes yet.</li>}
        </ul>
      </ScrollArea>
      {restore.isError && <p className="text-xs text-red-600">{restore.error?.message}</p>}
      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
        title="Restore this version?"
        description="This loads it into your draft for review — nothing goes live until you publish."
        confirmLabel="Restore"
        confirming={restore.isPending}
        onConfirm={() => restoreTarget !== null && restore.mutate(restoreTarget)}
      />
    </div>
  );
}
