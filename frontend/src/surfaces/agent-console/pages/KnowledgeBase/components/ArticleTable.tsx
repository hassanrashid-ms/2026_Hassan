import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { AgentArticlesResponse, ArticleStateValue } from '@support/types';
import {
  archiveArticle,
  bulkExportArticles,
  fetchArticles,
  publishArticle,
} from '../../../api/agentApi.ts';
import { canBuildForms, loadAgentSession } from '../../../lib/agentSession.ts';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { EmptyState } from '../../../components/ui/empty-state.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table.tsx';
import { cn } from '../../../lib/cn.ts';
import { BulkImportDialog } from './BulkImportDialog.tsx';

type ArticleRow = AgentArticlesResponse['articles'][number];
type BulkAction = 'publish' | 'archive' | 'export';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * All-or-nothing on purpose: if even one selected article is already
 * published, the bulk Publish button is disabled entirely rather than
 * quietly re-publishing the rest and skipping that one — same for Archive
 * against an already-archived article. A mixed selection means the agent
 * picked the wrong rows, not that the action should partially apply.
 */
function canBulkPublish(rows: ArticleRow[]): boolean {
  return rows.length > 0 && rows.every((a) => a.state === 'draft');
}

function canBulkArchive(rows: ArticleRow[]): boolean {
  return rows.length > 0 && rows.every((a) => a.state !== 'archived');
}

const STATE_BADGE_VARIANT: Record<ArticleStateValue, 'secondary' | 'success' | 'outline'> = {
  draft: 'secondary',
  published: 'success',
  archived: 'outline',
};

function displayTitle(title: string, body: string): string {
  if (title.trim()) return title;
  const bodyStart = body.trim().split(/\s+/).slice(0, 2).join(' ');
  return bodyStart || 'Untitled';
}

export function ArticleTable({
  token,
  selectedId,
  onSelect,
  onNew,
}: {
  token: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const queryClient = useQueryClient();
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busyAction, setBusyAction] = useState<BulkAction | null>(null);
  const [confirmAction, setConfirmAction] = useState<'publish' | 'archive' | null>(null);
  const session = loadAgentSession();
  const canBulkAct = canBuildForms(session);
  const articles = useQuery({ queryKey: ['admin-articles'], queryFn: () => fetchArticles(token) });
  const rows = articles.data?.articles ?? [];
  const allSelected = rows.length > 0 && rows.every((a) => selectedIds.has(a.id));
  const selectedRows = rows.filter((a) => selectedIds.has(a.id));
  const publishAllowed = canBulkPublish(selectedRows);
  const archiveAllowed = canBulkArchive(selectedRows);

  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds(allSelected ? new Set() : new Set(rows.map((a) => a.id)));
  }

  async function runExport() {
    setBusyAction('export');
    try {
      const blob = await bulkExportArticles(token, [...selectedIds]);
      downloadBlob(blob, 'articles-export.zip');
    } finally {
      setBusyAction(null);
    }
  }

  async function runConfirmedAction() {
    const action = confirmAction;
    if (action === null) return;
    const ids = [...selectedIds];
    setBusyAction(action);
    try {
      const call = action === 'publish' ? publishArticle : archiveArticle;
      await Promise.allSettled(ids.map((id) => call(token, id)));
      setSelectedIds(new Set());
      void queryClient.invalidateQueries({ queryKey: ['admin-articles'] });
    } finally {
      setBusyAction(null);
      setConfirmAction(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Articles</span>
        <div className="flex items-center gap-2">
          {canBuildForms(session) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setBulkImportOpen(true)}
            >
              Bulk Import
            </Button>
          )}
          <Button type="button" size="sm" onClick={onNew}>
            + New
          </Button>
        </div>
      </div>
      {canBulkAct && selectedIds.size > 0 && (
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-accent-soft px-3 py-2">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busyAction !== null}
              onClick={() => void runExport()}
            >
              {busyAction === 'export' && <Loader2 className="size-3.5 animate-spin" />}
              Export
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busyAction !== null || !publishAllowed}
              onClick={() => setConfirmAction('publish')}
            >
              {busyAction === 'publish' && <Loader2 className="size-3.5 animate-spin" />}
              Publish
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busyAction !== null || !archiveAllowed}
              onClick={() => setConfirmAction('archive')}
            >
              {busyAction === 'archive' && <Loader2 className="size-3.5 animate-spin" />}
              Archive
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busyAction !== null}
              onClick={() => setSelectedIds(new Set())}
            >
              Clear
            </Button>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <EmptyState message="Nothing to show" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {canBulkAct && (
                  <TableHead className="w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all articles"
                      checked={allSelected}
                      onChange={toggleAll}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </TableHead>
                )}
                <TableHead>Title</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow
                  key={a.id}
                  onClick={() => onSelect(a.id)}
                  className={cn('cursor-pointer', selectedId === a.id && 'bg-accent-soft')}
                >
                  {canBulkAct && (
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${displayTitle(a.title, a.body)}`}
                        checked={selectedIds.has(a.id)}
                        onChange={() => toggleRow(a.id)}
                      />
                    </TableCell>
                  )}
                  {/* max-w-0 + w-full lets the cell shrink below its content's natural
                    width in an auto-layout table — without it, `truncate` alone has no
                    bound to clip against, and a long title wraps character-by-character
                    once the sheet next to it eats most of the available width. */}
                  <TableCell className="max-w-0 w-full truncate font-medium" title={a.title}>
                    {displayTitle(a.title, a.body)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Badge variant={STATE_BADGE_VARIANT[a.state]}>{a.state}</Badge>
                      {a.state === 'published' && (
                        <span className="text-xs text-muted">v{a.version}</span>
                      )}
                      {a.has_draft && (
                        <span
                          className="h-1.5 w-1.5 rounded-full bg-amber-500"
                          title="Draft in progress"
                        />
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted">
                    {new Date(a.published_at ?? a.created_at).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <BulkImportDialog
        open={bulkImportOpen}
        onOpenChange={setBulkImportOpen}
        token={token}
        onImported={(response) => {
          if (response.summary.created > 0) {
            void queryClient.invalidateQueries({ queryKey: ['admin-articles'] });
          }
        }}
      />
      <ConfirmDialog
        open={confirmAction === 'publish'}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={`Publish ${selectedRows.length} article${selectedRows.length === 1 ? '' : 's'}?`}
        description="These become visible to players and the bot immediately."
        confirmLabel="Publish"
        confirming={busyAction === 'publish'}
        onConfirm={() => void runConfirmedAction()}
      />
      <ConfirmDialog
        open={confirmAction === 'archive'}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={`Archive ${selectedRows.length} article${selectedRows.length === 1 ? '' : 's'}?`}
        description="This removes them from player-facing search and the bot's knowledge base immediately. You can unarchive them later without losing content or version history."
        confirmLabel="Archive"
        variant="destructive"
        confirming={busyAction === 'archive'}
        onConfirm={() => void runConfirmedAction()}
      />
    </div>
  );
}
