import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import type {
  BotTestResolutionDecision,
  BotTestTurnDecision,
  ConfirmPhaseValue,
  FormField,
} from '@support/types';
import { testBotTurn, testResolutionAnswer, fetchIntents } from '../../../api/agentApi.ts';
import { useBotConfigDraft } from '../BotConfigDraftContext.tsx';
import { ChatThread } from '@/features/chat/components/ChatThread.tsx';
import { Composer } from '@/features/chat/components/Composer.tsx';
import type { ChatMessage } from '@/features/chat/components/types.ts';
import { ToolActivityStrip } from './ToolActivityStrip.tsx';
import { FormLivePreview } from '../../../components/FormLivePreview.tsx';
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

// Mirrors SupportChat.tsx's confirmPending, plus 'player_stated' — the phase
// the confirm_player_resolution tool drives here — so testing that tool shows
// the same yes/no prompt a real player would see.
const CONFIRM_PENDING_PHASES: ConfirmPhaseValue[] = [
  'bot_article',
  'agent_ask',
  'inactivity_ask',
  'player_stated',
];

const NO_SUBINTENT = '__none__';

// Mirrors backend/src/domain/conversations/resolutionMessages.ts. Duplicated
// rather than imported — the frontend doesn't import backend code — because
// the point here is the same as there: the player's Yes/No is an answer to a
// fixed question, posted as fixed text, never phrased by the model.
const RESOLUTION_CONFIRM_TEXT = 'Yes, my issue is resolved.';
const RESOLUTION_DECLINE_TEXT = "No, I'm still having issues.";

type TestMessage = ChatMessage & { toolActivity?: React.ReactNode };

/**
 * Mirrors applyBotTurn.ts's confirm_phase transitions. The `handoff` branch now
 * matches the real path exactly: a handoff whose subintent resolved to a
 * published form maps to 'form', same as a real conversation's column: any
 * other handoff maps to 'none'.
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
    case 'handoff':
      return decision.form ? 'form' : 'none';
    case 'resolve':
    case 'unavailable':
      return 'none';
    case 'noop':
      return current;
  }
}

function outcomeLabel(decision: BotTestResolutionDecision): string {
  switch (decision.kind) {
    case 'resolved':
      return '[resolved]';
    case 'reopened':
      return '[reopened]';
    case 'handed_off':
      return decision.form
        ? `[handoff: article_rejected → form: ${decision.form.form_name}]`
        : '[handoff: article_rejected]';
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
  const [activeTestForm, setActiveTestForm] = useState<{
    formName: string;
    fields: FormField[];
  } | null>(null);
  const [testResolved, setTestResolved] = useState(false);

  const intentsQuery = useQuery({ queryKey: ['intents'], queryFn: () => fetchIntents(token) });
  const subintentOptions = (intentsQuery.data?.intents ?? []).flatMap((intent) =>
    intent.subintents.map((sub) => ({ value: sub.id, label: `${intent.name} / ${sub.name}` })),
  );
  const selectedSubintentLabel = subintentOptions.find((o) => o.value === subintentId)?.label;
  const confirmPending = CONFIRM_PENDING_PHASES.includes(confirmPhase);

  const reset = () => {
    setMessages([]);
    setSubintentId(null);
    setConfirmPhase('none');
    setActiveTestForm(null);
    setTestResolved(false);
  };

  /**
   * Mirrors resolutionAnswer.ts: a resolution tap is answered deterministically,
   * never by handing the reply back to the model — the backend endpoint runs
   * the same pre-decided `resolve` / `handoff('article_rejected')` outcomes
   * applyBotTurn does, including the resolveSubintentForm lookup, so a
   * subintent with a published form opens here exactly as it would for a real
   * player declining a bot_article answer.
   */
  const answerResolution = async (helped: boolean) => {
    if (!confirmPending || sending) return;
    const phase = confirmPhase as 'bot_article' | 'agent_ask' | 'inactivity_ask' | 'player_stated';
    setSending(true);
    try {
      const { decision } = await testResolutionAnswer(token, {
        subintent_id: subintentId,
        confirm_phase: phase,
        helped,
      });
      const reply: TestMessage = {
        id: `test-player-${messages.length}`,
        authorType: 'player',
        body: helped ? RESOLUTION_CONFIRM_TEXT : RESOLUTION_DECLINE_TEXT,
        createdAt: new Date().toISOString(),
      };
      const outcome: TestMessage = {
        id: `test-outcome-${messages.length}`,
        authorType: 'system',
        body: outcomeLabel(decision),
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, reply, outcome]);
      setConfirmPhase('none');
      setActiveTestForm(
        decision.kind === 'handed_off' && decision.form
          ? { formName: decision.form.form_name, fields: decision.form.fields }
          : null,
      );
      setTestResolved(decision.kind !== 'reopened');
    } catch {
      const errorMessage: TestMessage = {
        id: `test-error-${messages.length}`,
        authorType: 'system',
        body: 'Resolution answer failed — check server logs.',
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setSending(false);
    }
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
      setActiveTestForm(
        decision.kind === 'handoff' && decision.form
          ? { formName: decision.form.form_name, fields: decision.form.fields }
          : null,
      );
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
          <Select value={subintentId ?? NO_SUBINTENT}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SUBINTENT} disabled>
                None
              </SelectItem>
              {subintentOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} disabled>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Confirm phase</span>
          <Select value={confirmPhase}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONFIRM_PHASES.map((phase) => (
                <SelectItem key={phase} value={phase} disabled>
                  {phase}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-[11px] leading-snug text-muted">
          Read-only — reflects the simulated conversation's state as the bot classifies and replies,
          same as a real conversation's columns. Not settable by hand.
        </p>
        {(subintentId || confirmPhase !== 'none') && (
          <div className="flex flex-wrap gap-1.5">
            {selectedSubintentLabel && <Badge variant="secondary">{selectedSubintentLabel}</Badge>}
            {confirmPhase !== 'none' && <Badge variant="outline">{confirmPhase}</Badge>}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ChatThread messages={messages} currentAuthorType="agent" isTyping={sending} />
        {messages.map(
          (m) =>
            m.toolActivity && (
              <div key={`activity-${m.id}`} className="px-3">
                {m.toolActivity}
              </div>
            ),
        )}
      </div>
      {activeTestForm && (
        <div className="relative shrink-0 border-t border-slate-200 bg-bg p-4">
          <FormLivePreview formName={activeTestForm.formName} fields={activeTestForm.fields} />
        </div>
      )}
      {confirmPending && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Is your issue resolved?"
          className="shrink-0 border-t border-slate-200 bg-accent-soft/40 p-4"
        >
          <p className="text-sm font-semibold text-text">Is your issue resolved?</p>
          <p className="mt-1 text-xs text-muted">
            Answered deterministically, same as a real tap — not sent to the model.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={sending}
              onClick={() => void answerResolution(true)}
            >
              Yes
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={sending}
              onClick={() => void answerResolution(false)}
            >
              No
            </Button>
          </div>
        </div>
      )}
      <Composer
        onSend={(body) => void send(body)}
        disabled={sending || !draft || confirmPending || testResolved}
        placeholder={testResolved ? 'Conversation ended — Reset to test again' : undefined}
      />
    </div>
  );
}
