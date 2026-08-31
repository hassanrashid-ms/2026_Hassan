import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BotConfigView, LimitToggleValue, ToolToggleValue } from '@support/types';
import { saveBotConfig } from '../../../api/agentApi.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { Switch } from '../../../components/ui/switch.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import { useBotConfigDraft } from '../BotConfigDraftContext.tsx';

// Mirrors backend/src/domain/bot/tools.ts TOOL_CATALOG — kept in sync by hand;
// this is display copy only, not enforcement (the API is the enforcement point).
const CONSEQUENCE_COPY: Record<string, string> = {
  search_articles: 'Bot can never look anything up; every turn ends in classify-only or handoff.',
  classify: 'Conversations stay unclassified from the bot; agents classify manually.',
  answer_from_article:
    'Bot can search/classify but never answers itself — always hands off after searching.',
  confirm_resolution:
    'Article answers are never confirmed by the player; bot_active exits only via handoff or the turn cap.',
  player_declared_resolved:
    'The bot never notices a player declaring their own issue resolved — the player must wait for the bot to offer an article or for an agent to ask instead.',
};

const LIMIT_LABELS: Record<string, string> = {
  max_bot_messages: 'Max bot messages per conversation',
  max_tool_calls_per_turn: 'Max tool calls per turn',
  max_articles_per_turn: 'Max article searches per turn',
  max_unhelped_replies: 'Max unhelped replies before handoff',
};

export function ToolsTab({ token, config }: { token: string; config: BotConfigView | undefined }) {
  const queryClient = useQueryClient();
  const { setDraftField } = useBotConfigDraft();
  const [toolsConfig, setToolsConfig] = useState<ToolToggleValue[]>(config?.tools_config ?? []);
  const [limitsConfig, setLimitsConfig] = useState<LimitToggleValue[]>(config?.limits_config ?? []);
  const [toolsConfirmOpen, setToolsConfirmOpen] = useState(false);
  const [limitsConfirmOpen, setLimitsConfirmOpen] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bot-config'] });

  useEffect(() => {
    if (config) setToolsConfig(config.tools_config);
  }, [config?.tools_config]);

  useEffect(() => {
    if (config) setLimitsConfig(config.limits_config);
  }, [config?.limits_config]);

  useEffect(() => {
    setDraftField('toolsConfig', toolsConfig);
  }, [toolsConfig, setDraftField]);

  useEffect(() => {
    setDraftField('limitsConfig', limitsConfig);
  }, [limitsConfig, setDraftField]);

  const save = useMutation({
    mutationFn: (toolsConfig: ToolToggleValue[]) =>
      saveBotConfig(token, { tools_config: toolsConfig }),
    onSuccess: () => {
      setToolsConfirmOpen(false);
      void invalidate();
    },
  });

  const saveLimits = useMutation({
    mutationFn: (limitsConfig: LimitToggleValue[]) =>
      saveBotConfig(token, { limits_config: limitsConfig }),
    onSuccess: () => {
      setLimitsConfirmOpen(false);
      void invalidate();
    },
  });

  if (!config) return null;

  const toggle = (tool: string) => {
    setToolsConfig((prev) =>
      prev.map((t) => (t.tool === tool ? { ...t, enabled: !t.enabled } : t)),
    );
  };

  const updateLimit = (key: string, value: number) => {
    setLimitsConfig((prev) => prev.map((l) => (l.key === key ? { ...l, value } : l)));
  };

  const toolsDirty = JSON.stringify(toolsConfig) !== JSON.stringify(config.tools_config);
  const limitsDirty = JSON.stringify(limitsConfig) !== JSON.stringify(config.limits_config);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {toolsConfig.map((t) => (
          <li key={t.tool} className="flex flex-col gap-1 rounded-md border border-slate-200 p-2">
            <div className="flex items-center gap-3">
              <Switch
                checked={t.enabled}
                disabled={save.isPending}
                onCheckedChange={() => toggle(t.tool)}
              />
              <span className="text-xs font-medium">{t.tool}</span>
            </div>
            {!t.enabled && <p className="pl-11 text-xs text-muted">{CONSEQUENCE_COPY[t.tool]}</p>}
          </li>
        ))}
        <li className="flex items-center gap-3 rounded-md border border-slate-200 p-2 opacity-70">
          <Badge variant="secondary">Always on</Badge>
          <span className="text-xs font-medium">handoff</span>
        </li>
      </ul>
      <div>
        <Button
          type="button"
          size="sm"
          onClick={() => setToolsConfirmOpen(true)}
          disabled={!toolsDirty || save.isPending}
        >
          Save changes
        </Button>
      </div>
      {save.isError && <p className="text-xs text-red-600">{save.error?.message}</p>}
      <div className="flex flex-col gap-2 rounded-md border border-slate-200 p-2">
        <h3 className="text-xs font-semibold">Conversation limits</h3>
        {limitsConfig.map((l) => (
          <label key={l.key} className="flex items-center justify-between gap-3 text-xs">
            <span>{LIMIT_LABELS[l.key]}</span>
            <input
              type="number"
              aria-label={LIMIT_LABELS[l.key]}
              value={l.value}
              disabled={saveLimits.isPending}
              onChange={(e) => updateLimit(l.key, Number(e.target.value))}
              className="w-16 rounded border border-slate-200 px-1 py-0.5 text-right"
            />
          </label>
        ))}
        <div>
          <Button
            type="button"
            size="sm"
            onClick={() => setLimitsConfirmOpen(true)}
            disabled={!limitsDirty || saveLimits.isPending}
          >
            Save changes
          </Button>
        </div>
        {saveLimits.isError && (
          <p className="text-xs text-red-600">{saveLimits.error?.message}</p>
        )}
      </div>
      <ConfirmDialog
        open={toolsConfirmOpen}
        onOpenChange={setToolsConfirmOpen}
        title="Save tool changes?"
        description="This changes which tools the bot can use fleet-wide for this workspace."
        confirmLabel="Save"
        confirming={save.isPending}
        onConfirm={() => save.mutate(toolsConfig)}
      />
      <ConfirmDialog
        open={limitsConfirmOpen}
        onOpenChange={setLimitsConfirmOpen}
        title="Save limit changes?"
        description="This changes conversation limits fleet-wide for this workspace."
        confirmLabel="Save"
        confirming={saveLimits.isPending}
        onConfirm={() => saveLimits.mutate(limitsConfig)}
      />
    </div>
  );
}
