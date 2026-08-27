import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotConfigVersionedField, RuleEntryView } from '@support/types';
import {
  fetchBotConfigVersion,
  fetchBotConfigVersions,
  rollbackBotConfigVersion,
} from '../../../api/agentApi.ts';
import { Button } from '../../../components/ui/button.tsx';
import { ScrollArea } from '../../../components/ui/scroll-area.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import {
  diffLimitsConfig,
  diffPromptText,
  diffRules,
  diffToolsConfig,
} from '../lib/diffBotConfigVersion.ts';

const FIELD_LABELS: Record<BotConfigVersionedField, string> = {
  prompt: 'Prompt',
  rules: 'Rules',
  tools_config: 'Tools',
  limits_config: 'Limits',
};

function VersionDiff({ token, version }: { token: string; version: number }) {
  const currentQuery = useQuery({
    queryKey: ['bot-config-version', version],
    queryFn: () => fetchBotConfigVersion(token, version),
  });
  const priorQuery = useQuery({
    queryKey: ['bot-config-version', version - 1],
    queryFn: () => fetchBotConfigVersion(token, version - 1),
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

  const promptTokens =
    current.prompt !== prior.prompt ? diffPromptText(prior.prompt, current.prompt) : null;
  // Version snapshots don't carry the server-computed `enforcement` field that
  // the live config view does; diffRules only reads key/enabled/text, so the
  // stricter RuleEntryView param type is satisfied with a cast rather than
  // widening the shared diff utility's signature (out of this task's scope).
  const ruleEntries = diffRules(prior.rules as RuleEntryView[], current.rules as RuleEntryView[]);
  const toolEntries = diffToolsConfig(prior.tools_config, current.tools_config);
  const limitEntries = diffLimitsConfig(prior.limits_config, current.limits_config);

  return (
    <div className="flex flex-col gap-2 text-xs">
      {promptTokens && (
        <div>
          <p className="font-medium">Prompt</p>
          <p className="rounded bg-slate-50 p-2 font-mono">
            {promptTokens.map((token, i) => (
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
      {[...ruleEntries, ...toolEntries, ...limitEntries].map((entry) => (
        <p key={entry.key + entry.description}>{entry.description}</p>
      ))}
    </div>
  );
}

export function VersionHistoryTab({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);

  const versionsQuery = useQuery({
    queryKey: ['bot-config-versions'],
    queryFn: () => fetchBotConfigVersions(token, { limit: 50 }),
  });

  const restore = useMutation({
    mutationFn: (version: number) => rollbackBotConfigVersion(token, version),
    onSuccess: () => {
      setRestoreTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['bot-config'] });
      void queryClient.invalidateQueries({ queryKey: ['bot-config-versions'] });
    },
  });

  const versions = versionsQuery.data?.versions ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-2">
          {versions.map((entry) => (
            <li key={entry.version} className="rounded-md border border-slate-200 p-2 text-xs">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 text-left"
                onClick={() => setExpanded((v) => (v === entry.version ? null : entry.version))}
              >
                <span className="flex items-center gap-2">
                  <span className="font-semibold">v{entry.version}</span>
                  <span className="text-muted">{entry.actor.display_name}</span>
                  <span className="text-muted">{new Date(entry.created_at).toLocaleString()}</span>
                </span>
                <span className="flex gap-1">
                  {entry.changed_fields.map((field) => (
                    <span key={field} className="rounded bg-slate-100 px-1.5 py-0.5">
                      {FIELD_LABELS[field]}
                    </span>
                  ))}
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
                  <VersionDiff token={token} version={entry.version} />
                </div>
              )}
            </li>
          ))}
          {versions.length === 0 && <li className="text-xs text-muted">No changes yet.</li>}
        </ul>
      </ScrollArea>
      {restore.isError && <p className="text-xs text-red-600">{restore.error?.message}</p>}
      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
        title="Roll back to this version?"
        description="This overwrites prompt, rules, tools and limits with this version's snapshot."
        confirmLabel="Roll back"
        confirming={restore.isPending}
        onConfirm={() => restoreTarget !== null && restore.mutate(restoreTarget)}
      />
    </div>
  );
}
