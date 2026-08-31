import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import type { BotTestTurnDecision, ConfirmPhaseValue } from '@support/types';
import { testBotTurn, fetchIntents } from '../../../api/agentApi.ts';
import { useBotConfigDraft } from '../BotConfigDraftContext.tsx';
import { ChatThread } from '@/features/chat/components/ChatThread.tsx';
import { Composer } from '@/features/chat/components/Composer.tsx';
import type { ChatMessage } from '@/features/chat/components/types.ts';
import { ToolActivityStrip } from './ToolActivityStrip.tsx';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.tsx';

const CONFIRM_PHASES: ConfirmPhaseValue[] = [
  'none',
  'bot_article',
  'agent_ask',
  'form',
  'inactivity_ask',
  'player_stated',
];

const NO_SUBINTENT = '__none__';

type TestMessage = ChatMessage & { toolActivity?: React.ReactNode };

/**
 * Mirrors applyBotTurn.ts's confirm_phase transitions closely enough to keep
 * the simulated conversation state moving turn to turn — but it's an
 * approximation, not a copy: the `handoff` → `confirm_phase: 'form'` branch
 * depends on a real subintent's published form (resolveSubintentForm, a DB
 * lookup applyBotTurn does that this wire decision never carries), so a
 * handoff here always resolves to 'none' even when the real path would have
 * offered a form. Every other branch matches applyBotTurn.ts exactly.
 */
function nextConfirmPhase(
  decision: BotTestTurnDecision,
  current: ConfirmPhaseValue,
): ConfirmPhaseValue {
  switch (decision.kind) {
    case 'answer':
      return decision.article_id ? 'bot_article' : current;
    case 'confirm_player_resolution':
      return 'player_stated';
    case 'resolve':
    case 'handoff':
    case 'unavailable':
      return 'none';
    case 'noop':
      return current;
  }
}

/** Mirrors classifyIfUnset — write-once, same as the real conversation's subintent_id column. */
function nextSubintentId(decision: BotTestTurnDecision, current: string | null): string | null {
  if (current !== null) return current;
  return 'subintent_id' in decision ? decision.subintent_id : current;
}

export function BotTestPanel({ token }: { token: string }) {
  const { draft } = useBotConfigDraft();
  const [messages, setMessages] = useState<TestMessage[]>([]);
  const [subintentId, setSubintentId] = useState<string | null>(null);
  const [confirmPhase, setConfirmPhase] = useState<ConfirmPhaseValue>('none');
  const [sending, setSending] = useState(false);

  const intentsQuery = useQuery({ queryKey: ['intents'], queryFn: () => fetchIntents(token) });
  const subintentOptions = (intentsQuery.data?.intents ?? []).flatMap((intent) =>
    intent.subintents.map((sub) => ({ value: sub.id, label: `${intent.name} / ${sub.name}` })),
  );
  const selectedSubintentLabel = subintentOptions.find((o) => o.value === subintentId)?.label;

  const reset = () => {
    setMessages([]);
    setSubintentId(null);
    setConfirmPhase('none');
  };

  const send = async (body: string) => {
    if (!draft) return;
    const playerMessage: TestMessage = {
      id: `test-player-${messages.length}`,
      authorType: 'player',
      body,
      createdAt: new Date().toISOString(),
    };
    const history = messages.map((m) => ({
      author_type: m.authorType === 'player' ? ('player' as const) : ('bot' as const),
      body: m.body,
    }));
    setMessages((prev) => [...prev, playerMessage]);
    setSending(true);
    try {
      const { decision } = await testBotTurn(token, {
        config: {
          prompt: draft.prompt,
          rules: draft.rules,
          tools_config: draft.toolsConfig,
          limits_config: draft.limitsConfig,
        },
        subintent_id: subintentId,
        confirm_phase: confirmPhase,
        history,
        player_message: body,
      });
      const botMessage: TestMessage = {
        id: `test-bot-${messages.length}`,
        authorType: 'bot',
        body: decision.kind === 'answer' ? decision.reply : `[${decision.kind}]`,
        createdAt: new Date().toISOString(),
        toolActivity: <ToolActivityStrip decision={decision} />,
      };
      setMessages((prev) => [...prev, botMessage]);
      setSubintentId((prev) => nextSubintentId(decision, prev));
      setConfirmPhase((prev) => nextConfirmPhase(decision, prev));
    } catch {
      const errorMessage: TestMessage = {
        id: `test-error-${messages.length}`,
        authorType: 'system',
        body: 'Test turn failed — check server logs.',
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Test the bot</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={reset}
          disabled={messages.length === 0}
        >
          <RotateCcw className="size-3.5" />
          Reset
        </Button>
      </div>
      <div className="flex flex-col gap-3 border-b border-slate-200 bg-accent-soft/40 p-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Subintent</span>
          <Select value={subintentId ?? NO_SUBINTENT} disabled>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SUBINTENT}>None</SelectItem>
              {subintentOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Confirm phase</span>
          <Select value={confirmPhase} disabled>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONFIRM_PHASES.map((phase) => (
                <SelectItem key={phase} value={phase}>
                  {phase}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-[11px] leading-snug text-muted">
          Read-only — reflects the simulated conversation's state as the bot classifies and
          replies, same as a real conversation's columns. Not settable by hand.
        </p>
        {(subintentId || confirmPhase !== 'none') && (
          <div className="flex flex-wrap gap-1.5">
            {selectedSubintentLabel && <Badge variant="secondary">{selectedSubintentLabel}</Badge>}
            {confirmPhase !== 'none' && <Badge variant="outline">{confirmPhase}</Badge>}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <ChatThread messages={messages} currentAuthorType="agent" />
        {messages.map(
          (m) =>
            m.toolActivity && (
              <div key={`activity-${m.id}`} className="px-3">
                {m.toolActivity}
              </div>
            ),
        )}
      </div>
      <Composer onSend={(body) => void send(body)} disabled={sending || !draft} />
    </div>
  );
}
