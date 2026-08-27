import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BotConfigView, RuleEntryView } from '@support/types';
import { saveBotConfig } from '../../../api/agentApi.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { Input } from '../../../components/ui/input.tsx';
import { Switch } from '../../../components/ui/switch.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';

function stripView(rule: RuleEntryView) {
  const { enforcement, ...rest } = rule;
  return rest;
}

export function RulesTab({ token, config }: { token: string; config: BotConfigView | undefined }) {
  const queryClient = useQueryClient();
  const [newRuleText, setNewRuleText] = useState('');
  const [rules, setRules] = useState<RuleEntryView[]>(config?.rules ?? []);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bot-config'] });

  useEffect(() => {
    if (config) setRules(config.rules);
  }, [config?.rules]);

  const save = useMutation({
    mutationFn: (rules: ReturnType<typeof stripView>[]) => saveBotConfig(token, { rules }),
    onSuccess: () => {
      setNewRuleText('');
      setConfirmOpen(false);
      void invalidate();
    },
  });

  if (!config) return null;

  const toggle = (key: string) => {
    setRules((prev) => prev.map((r) => (r.key === key ? { ...r, enabled: !r.enabled } : r)));
  };

  const addCustom = () => {
    if (!newRuleText.trim()) return;
    setRules((prev) => [
      ...prev,
      {
        key: `custom-${Date.now()}`,
        text: newRuleText.trim(),
        enabled: true,
        locked: false,
        source: 'custom',
        enforcement: 'prompt',
      },
    ]);
    setNewRuleText('');
  };

  const dirty =
    JSON.stringify(rules.map(stripView)) !== JSON.stringify(config.rules.map(stripView));
  const changedCount = rules.filter((r, i) => {
    const orig = config.rules.find((o) => o.key === r.key);
    return !orig || JSON.stringify(stripView(orig)) !== JSON.stringify(stripView(r));
  }).length;

  const activeCount = rules.filter((r) => r.enabled).length;
  const lockedCount = rules.filter((r) => r.locked).length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <p className="text-xs text-muted">
        {activeCount} active · {lockedCount} cannot be switched off
      </p>
      <ul className="flex flex-col gap-2">
        {rules.map((rule) => (
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
      <div>
        <Button
          type="button"
          size="sm"
          onClick={() => setConfirmOpen(true)}
          disabled={!dirty || save.isPending}
        >
          Save changes
        </Button>
      </div>
      {save.isError && <p className="text-xs text-red-600">{save.error?.message}</p>}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Save rule changes?"
        description={`${changedCount} rule${changedCount === 1 ? '' : 's'} changed. This affects bot behavior fleet-wide for this workspace.`}
        confirmLabel="Save"
        confirming={save.isPending}
        onConfirm={() => save.mutate(rules.map(stripView))}
      />
    </div>
  );
}
