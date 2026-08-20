import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { BotConfigView, LimitToggleValue, ToolToggleValue } from '@support/types'
import { saveBotConfig } from '../../../api/agentApi.ts'
import { Badge } from '../../../components/ui/badge.tsx'
import { Switch } from '../../../components/ui/switch.tsx'
import { HistoryPanel } from './HistoryPanel.tsx'

// Mirrors backend/src/domain/bot/tools.ts TOOL_CATALOG — kept in sync by hand;
// this is display copy only, not enforcement (the API is the enforcement point).
const CONSEQUENCE_COPY: Record<string, string> = {
  search_articles: 'Bot can never look anything up; every turn ends in classify-only or handoff.',
  classify: 'Conversations stay unclassified from the bot; agents classify manually.',
  answer_from_article: 'Bot can search/classify but never answers itself — always hands off after searching.',
  confirm_resolution: 'Article answers are never confirmed by the player; bot_active exits only via handoff or the turn cap.',
}

const LIMIT_LABELS: Record<string, string> = {
  max_bot_messages: 'Max bot messages per conversation',
  max_tool_calls_per_turn: 'Max tool calls per turn',
  max_articles_per_turn: 'Max article searches per turn',
  max_unhelped_replies: 'Max unhelped replies before handoff',
}

export function ToolsTab({ token, config }: { token: string; config: BotConfigView | undefined }) {
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bot-config'] })

  const save = useMutation({
    mutationFn: (toolsConfig: ToolToggleValue[]) => saveBotConfig(token, { tools_config: toolsConfig }),
    onSuccess: () => void invalidate(),
  })

  const saveLimits = useMutation({
    mutationFn: (limitsConfig: LimitToggleValue[]) => saveBotConfig(token, { limits_config: limitsConfig }),
    onSuccess: () => void invalidate(),
  })

  if (!config) return null

  const toggle = (tool: string) => {
    const updated = config.tools_config.map((t) => (t.tool === tool ? { ...t, enabled: !t.enabled } : t))
    save.mutate(updated)
  }

  const updateLimit = (key: string, value: number) => {
    const updated = config.limits_config.map((l) => (l.key === key ? { ...l, value } : l))
    saveLimits.mutate(updated)
  }

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <ul className="flex flex-col gap-2">
          {config.tools_config.map((t) => (
            <li key={t.tool} className="flex flex-col gap-1 rounded-md border border-slate-200 p-2">
              <div className="flex items-center gap-3">
                <Switch checked={t.enabled} disabled={save.isPending} onCheckedChange={() => toggle(t.tool)} />
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
        <div className="flex flex-col gap-2 rounded-md border border-slate-200 p-2">
          <h3 className="text-xs font-semibold">Conversation limits</h3>
          {config.limits_config.map((l) => (
            <label key={l.key} className="flex items-center justify-between gap-3 text-xs">
              <span>{LIMIT_LABELS[l.key]}</span>
              <input
                type="number"
                aria-label={LIMIT_LABELS[l.key]}
                defaultValue={l.value}
                disabled={saveLimits.isPending}
                onBlur={(e) => updateLimit(l.key, Number(e.target.value))}
                className="w-16 rounded border border-slate-200 px-1 py-0.5 text-right"
              />
            </label>
          ))}
          {saveLimits.isError && <p className="text-xs text-red-600">{saveLimits.error?.message}</p>}
        </div>
        {save.isError && <p className="text-xs text-red-600">{save.error?.message}</p>}
      </div>
      <HistoryPanel token={token} field="tools_config" onRestored={invalidate} />
    </div>
  )
}
