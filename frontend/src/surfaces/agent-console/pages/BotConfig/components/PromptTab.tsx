import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { BotConfigView } from '@support/types'
import { saveBotConfig } from '../../../api/agentApi.ts'
import { Button } from '../../../components/ui/button.tsx'
import { Textarea } from '../../../components/ui/textarea.tsx'
import { HistoryPanel } from './HistoryPanel.tsx'

export function PromptTab({ token, config }: { token: string; config: BotConfigView | undefined }) {
  const queryClient = useQueryClient()
  const [prompt, setPrompt] = useState(config?.prompt ?? '')

  useEffect(() => {
    if (config) setPrompt(config.prompt)
  }, [config?.prompt])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bot-config'] })

  const save = useMutation({
    mutationFn: (value: string | null) => saveBotConfig(token, { prompt: value }),
    onSuccess: () => void invalidate(),
  })

  if (!config) return null

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <label htmlFor="bot-config-prompt" className="text-xs font-medium text-muted">
          Prompt
        </label>
        <Textarea
          id="bot-config-prompt"
          aria-label="Prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="min-h-64 flex-1 font-mono text-xs"
        />
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" onClick={() => save.mutate(prompt)} disabled={save.isPending || !prompt.trim()}>
            Save
          </Button>
          {config.is_prompt_customized && (
            <Button type="button" size="sm" variant="outline" onClick={() => save.mutate(null)} disabled={save.isPending}>
              Reset to default
            </Button>
          )}
        </div>
        {save.isError && <p className="text-xs text-red-600">{save.error?.message}</p>}
      </div>
      <HistoryPanel token={token} field="prompt" onRestored={invalidate} />
    </div>
  )
}
