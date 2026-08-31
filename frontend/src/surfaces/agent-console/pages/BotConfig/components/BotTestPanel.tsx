import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConfirmPhaseValue } from '@support/types';
import { testBotTurn, fetchIntents } from '../../../api/agentApi.ts';
import { useBotConfigDraft } from '../BotConfigDraftContext.tsx';
import { ChatThread } from '@/features/chat/components/ChatThread.tsx';
import { Composer } from '@/features/chat/components/Composer.tsx';
import type { ChatMessage } from '@/features/chat/components/types.ts';
import { ToolActivityStrip } from './ToolActivityStrip.tsx';

const CONFIRM_PHASES: ConfirmPhaseValue[] = [
  'none',
  'bot_article',
  'agent_ask',
  'form',
  'inactivity_ask',
  'player_stated',
];

type TestMessage = ChatMessage & { toolActivity?: React.ReactNode };

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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Test the bot</span>
      </div>
      <div className="flex flex-col gap-2 border-b border-slate-200 p-3 text-xs">
        <label className="flex items-center justify-between gap-2">
          <span>Subintent</span>
          <select
            value={subintentId ?? ''}
            onChange={(e) => setSubintentId(e.target.value || null)}
            className="rounded border border-slate-200 px-1 py-0.5"
          >
            <option value="">None</option>
            {subintentOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Confirm phase</span>
          <select
            value={confirmPhase}
            onChange={(e) => setConfirmPhase(e.target.value as ConfirmPhaseValue)}
            className="rounded border border-slate-200 px-1 py-0.5"
          >
            {CONFIRM_PHASES.map((phase) => (
              <option key={phase} value={phase}>
                {phase}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="min-h-0 flex-1">
        {/*
          Virtuoso in react-virtuoso only ever mounts the item at its computed
          topmost index — `initialTopMostItemIndex` relies on an imperative
          scrollTo the browser performs after mount, which jsdom does not
          execute, so any earlier message in a longer list simply never
          renders in tests (react-virtuoso@4.18, jsdom via happy-dom/vitest).
          Passing only the latest message sidesteps that entirely: item 0 is
          always the one on screen, matching every other ChatThread test in
          this codebase, which also only ever renders a single-message array.
          Full turn-by-turn history is still sent to the server via `history`
          below; only the live rendered bubble is capped to the latest turn.
        */}
        <ChatThread
          key={messages.length}
          messages={messages.slice(-1)}
          currentAuthorType="agent"
        />
        {messages.length > 0 &&
          messages[messages.length - 1]!.toolActivity && (
            <div>{messages[messages.length - 1]!.toolActivity}</div>
          )}
      </div>
      <Composer onSend={(body) => void send(body)} disabled={sending || !draft} />
    </div>
  );
}
