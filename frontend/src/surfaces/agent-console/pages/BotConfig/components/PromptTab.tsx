import { useEffect, useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BotConfigView } from '@support/types';
import { saveBotConfig } from '../../../api/agentApi.ts';
import { Button } from '../../../components/ui/button.tsx';
import { Textarea } from '../../../components/ui/textarea.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';

export function PromptTab({ token, config }: { token: string; config: BotConfigView | undefined }) {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState(config?.prompt ?? '');
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (config) setPrompt(config.prompt);
  }, [config?.prompt]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bot-config'] });

  const save = useMutation({
    mutationFn: (value: string | null) => saveBotConfig(token, { prompt: value }),
    onSuccess: () => {
      setSaveConfirmOpen(false);
      setResetConfirmOpen(false);
      void invalidate();
    },
  });

  const insertPlaceholder = (placeholder: string) => {
    if (!textareaRef.current) {
      setPrompt((p) => p + placeholder);
      return;
    }
    const start = textareaRef.current.selectionStart;
    const end = textareaRef.current.selectionEnd;
    const newPrompt = prompt.substring(0, start) + placeholder + prompt.substring(end);
    setPrompt(newPrompt);
    
    // Set cursor position after React re-renders
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const newCursorPos = start + placeholder.length;
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
      }
    }, 0);
  };

  const placeholders = [
    { tag: '{{subintents}}', desc: 'the current subintent list' },
    { tag: '{{articles}}', desc: 'the published article titles and summaries' },
    { tag: '{{player_level}}', desc: 'from the player state snapshot' },
    { tag: '{{spend_tier}}', desc: 'from the player state snapshot' },
  ];

  if (!config) return null;

  const isDirty = prompt !== config.prompt;

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <label htmlFor="bot-config-prompt" className="text-xs font-medium text-muted">
          Prompt
        </label>
        
        <div className="mb-2 text-xs text-muted-foreground">
          <p className="mb-1 font-semibold text-slate-800">Available placeholders</p>
          <ul className="mb-2 space-y-1">
            {placeholders.map((p) => (
              <li key={p.tag} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => insertPlaceholder(p.tag)}
                  className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-700 hover:bg-slate-200"
                >
                  {p.tag}
                </button>
                <span>{p.desc}</span>
              </li>
            ))}
          </ul>
          <p>
            Placeholders are filled at run time. The prompt never contains a hard-coded subintent or article. Editing the list of subintents therefore changes the bot&apos;s behaviour without touching the prompt.
          </p>
        </div>

        <Textarea
          ref={textareaRef}
          id="bot-config-prompt"
          aria-label="Prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="min-h-64 flex-1 font-mono text-xs"
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => setSaveConfirmOpen(true)}
            disabled={save.isPending || !prompt.trim() || !isDirty}
          >
            Save
          </Button>
          {config.is_prompt_customized && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setResetConfirmOpen(true)}
              disabled={save.isPending}
            >
              Reset to default
            </Button>
          )}
        </div>
        {save.isError && <p className="text-xs text-red-600">{save.error?.message}</p>}
      </div>
      <HistoryPanel token={token} field="prompt" onRestored={invalidate} />
      <ConfirmDialog
        open={saveConfirmOpen}
        onOpenChange={setSaveConfirmOpen}
        title="Save this prompt?"
        description="This changes the bot's system prompt fleet-wide for this workspace."
        confirmLabel="Save"
        confirming={save.isPending}
        onConfirm={() => save.mutate(prompt)}
      />
      <ConfirmDialog
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        title="Reset prompt to default?"
        description="This discards your customization."
        confirmLabel="Reset"
        variant="destructive"
        confirming={save.isPending}
        onConfirm={() => save.mutate(null)}
      />
    </div>
  );
}
