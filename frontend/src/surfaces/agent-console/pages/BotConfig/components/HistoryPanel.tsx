import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { fetchBotConfigHistory, rollbackBotConfig } from '../../../api/agentApi.ts';
import { Button } from '../../../components/ui/button.tsx';
import { ScrollArea } from '../../../components/ui/scroll-area.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';

/**
 * "Restore" always targets the entry's `before_value` — the state right
 * before this change happened, i.e. "undo this specific edit" — which is what
 * the doc's per-row Restore control means. `after_value` restores are still
 * reachable via the rollback endpoint (e.g. redo), but there is no button for
 * that in this UI.
 */
export function HistoryPanel({
  token,
  field,
  onRestored,
}: {
  token: string;
  field: 'prompt' | 'rules' | 'tools_config' | 'limits_config';
  onRestored: () => void;
}) {
  const historyQuery = useQuery({
    queryKey: ['bot-config-history', field],
    queryFn: () => fetchBotConfigHistory(token, { field, limit: 20 }),
  });

  const restore = useMutation({
    mutationFn: (changeLogId: string) =>
      rollbackBotConfig(token, { field, change_log_id: changeLogId, side: 'before' }),
    onSuccess: () => {
      setRestoreTarget(null);
      onRestored();
    },
  });

  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const entries = historyQuery.data?.entries ?? [];

  return (
    <div className="flex w-64 shrink-0 flex-col gap-2 border-l border-slate-200 pl-3">
      <span className="text-xs font-semibold text-muted">History</span>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-col gap-1 rounded-md border border-slate-200 p-2 text-xs"
            >
              <span className="font-medium">{entry.actor.display_name}</span>
              <span className="text-muted">{new Date(entry.changed_at).toLocaleString()}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRestoreTarget(entry.id)}
                disabled={restore.isPending}
              >
                Restore
              </Button>
            </li>
          ))}
          {entries.length === 0 && <li className="text-xs text-muted">No changes yet.</li>}
        </ul>
      </ScrollArea>
      {restore.isError && <p className="text-xs text-red-600">{restore.error?.message}</p>}
      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
        title="Roll back to this version?"
        description="This overwrites the current value with the historical one shown here."
        confirmLabel="Roll back"
        confirming={restore.isPending}
        onConfirm={() => restoreTarget && restore.mutate(restoreTarget)}
      />
    </div>
  );
}
