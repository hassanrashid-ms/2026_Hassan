import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BotConfigView, RuleEntryView } from '@support/types';
import { saveBotConfig } from '../../../api/agentApi.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { Input } from '../../../components/ui/input.tsx';
import { Switch } from '../../../components/ui/switch.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';

function stripView(rule: RuleEntryView) {
  const { enforcement, ...rest } = rule;
  return rest;
}

export function RulesTab({ token, config }: { token: string; config: BotConfigView | undefined }) {
  const queryClient = useQueryClient();
  const [newRuleText, setNewRuleText] = useState('');
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bot-config'] });

  const save = useMutation({
    mutationFn: (rules: ReturnType<typeof stripView>[]) => saveBotConfig(token, { rules }),
    onSuccess: () => {
      setNewRuleText('');
      void invalidate();
    },
  });

  if (!config) return null;

  const toggle = (key: string) => {
    const updated = config.rules.map((r) => (r.key === key ? { ...r, enabled: !r.enabled } : r));
    save.mutate(updated.map(stripView));
  };

  const addCustom = () => {
    if (!newRuleText.trim()) return;
    const updated: RuleEntryView[] = [
      ...config.rules,
      {
        key: `custom-${Date.now()}`,
        text: newRuleText.trim(),
        enabled: true,
        locked: false,
        source: 'custom',
        enforcement: 'prompt',
      },
    ];
    save.mutate(updated.map(stripView));
  };

  const activeCount = config.rules.filter((r) => r.enabled).length;
  const lockedCount = config.rules.filter((r) => r.locked).length;

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <p className="text-xs text-muted">
          {activeCount} active · {lockedCount} cannot be switched off
        </p>
        <ul className="flex flex-col gap-2">
          {config.rules.map((rule) => (
            <li
              key={rule.key}
              className="flex items-start gap-3 rounded-md border border-slate-200 p-2"
            >
              <Switch
                checked={rule.enabled}
                disabled={rule.locked || save.isPending}
                onCheckedChange={() => toggle(rule.key)}
              />
              <div className="flex flex-1 flex-col gap-1">
                <p className="text-xs">{rule.text}</p>
                <div className="flex items-center gap-1">
                  {rule.locked && <Badge variant="secondary">Locked</Badge>}
                  <Badge variant="outline">
                    {rule.enforcement === 'code' ? 'Enforced in code' : 'Prompt only'}
                  </Badge>
                  {rule.source === 'custom' && <Badge variant="outline">Custom</Badge>}
                </div>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Add a custom rule…"
            value={newRuleText}
            onChange={(e) => setNewRuleText(e.target.value)}
            className="h-8 flex-1"
          />
          <Button
            type="button"
            size="sm"
            onClick={addCustom}
            disabled={save.isPending || !newRuleText.trim()}
          >
            Add
          </Button>
        </div>
        {save.isError && <p className="text-xs text-red-600">{save.error?.message}</p>}
      </div>
      <HistoryPanel token={token} field="rules" onRestored={invalidate} />
    </div>
  );
}
