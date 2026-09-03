import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchFormVersion, fetchFormVersions, restoreFormVersion } from '../../../api/agentApi.ts';
import { Button } from '../../../components/ui/button.tsx';
import { ScrollArea } from '../../../components/ui/scroll-area.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import { diffFormFields } from '../lib/diffFormFields.ts';

function relativeTime(iso: string): string {
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
  formId,
  version,
  priorVersion,
}: {
  token: string;
  formId: string;
  version: number;
  priorVersion: number | null;
}) {
  const currentQuery = useQuery({
    queryKey: ['form-version', formId, version],
    queryFn: () => fetchFormVersion(token, formId, version),
  });
  const priorQuery = useQuery({
    queryKey: ['form-version', formId, priorVersion],
    queryFn: () => fetchFormVersion(token, formId, priorVersion!),
    enabled: priorVersion !== null,
  });

  if (currentQuery.isLoading || (priorVersion !== null && priorQuery.isLoading)) {
    return <p className="text-xs text-muted">Loading diff…</p>;
  }
  if (priorVersion === null || !priorQuery.data || !currentQuery.data) {
    return <p className="text-xs text-muted">No prior changes.</p>;
  }

  const entries = diffFormFields(priorQuery.data.fields, currentQuery.data.fields);
  if (entries.length === 0) {
    return <p className="text-xs text-muted">No field changes.</p>;
  }

  return (
    <ul className="flex flex-col gap-1 text-xs">
      {entries.map((entry) => (
        <li key={entry.key + entry.description}>{entry.description}</li>
      ))}
    </ul>
  );
}

export function FormVersionHistoryTab({
  token,
  formId,
  onRestored,
}: {
  token: string;
  formId: string;
  onRestored: () => void;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);

  const versionsQuery = useQuery({
    queryKey: ['form-versions', formId],
    queryFn: () => fetchFormVersions(token, formId),
  });

  const restore = useMutation({
    mutationFn: (version: number) => restoreFormVersion(token, formId, version),
    onSuccess: () => {
      setRestoreTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-form', formId] });
      void queryClient.invalidateQueries({ queryKey: ['form-versions', formId] });
      onRestored();
    },
  });

  const versions = versionsQuery.data?.versions ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-2">
          {versions.map((entry, index) => (
            <li key={entry.version} className="rounded-md border border-slate-200 p-2 text-xs">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 text-left"
                onClick={() => setExpanded((v) => (v === entry.version ? null : entry.version))}
              >
                <span className="flex items-center gap-2">
                  <span className="font-semibold">v{entry.version}</span>
                  <span className="text-muted">{entry.actor.display_name}</span>
                  <span className="text-muted">{relativeTime(entry.published_at)}</span>
                </span>
              </button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => setRestoreTarget(entry.version)}
                disabled={restore.isPending}
              >
                Restore
              </Button>
              {expanded === entry.version && (
                <div className="mt-2 border-t border-slate-100 pt-2">
                  <VersionDiff
                    token={token}
                    formId={formId}
                    version={entry.version}
                    priorVersion={versions[index + 1]?.version ?? null}
                  />
                </div>
              )}
            </li>
          ))}
          {versions.length === 0 && (
            <li className="text-xs text-muted">No published versions yet.</li>
          )}
        </ul>
      </ScrollArea>
      {restore.isError && <p className="text-xs text-red-600">{restore.error?.message}</p>}
      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
        title="Restore this version?"
        description="This replaces the current draft with this version's fields. Publish separately when you're ready."
        confirmLabel="Restore version"
        confirming={restore.isPending}
        onConfirm={() => restoreTarget !== null && restore.mutate(restoreTarget)}
      />
    </div>
  );
}
