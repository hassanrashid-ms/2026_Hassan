import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import { resolveBotConfig, resolved } from './botConfig.ts';
import { toolLoopDecider } from './toolLoop.ts';
import type { ChatRole } from './contextAssembly.ts';
import type { BotTurnDecision, BotTurnInput } from './botTurn.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import { resolveSubintentForm, type ResolvedForm } from '../forms/resolveSubintentForm.ts';
import type { BotTestTurnDecision, PlayerMessageView, TestBotTurnBodyValue } from '@support/types';

/**
 * A conversation id no real conversation ever has. buildMessages' DB reads
 * for it — transcript, player state — return nothing, which the pipeline
 * already treats as "no history"/"no known player state", not an error.
 */
const TEST_TURN_CONVERSATION_ID = '00000000-0000-0000-0000-000000000000';

function syntheticPlayerMessageView(
  authorType: 'player' | 'bot',
  body: string,
  seq: number,
): PlayerMessageView {
  return {
    id: `test-${seq}`,
    seq,
    author_type: authorType,
    body,
    delivery_state: 'read',
    read_at: null,
    created_at: new Date().toISOString(),
    article_id: null,
    attachment: null,
    form_field_key: null,
  };
}

export async function runTestBotTurn(
  ctx: AgentContext,
  body: TestBotTurnBodyValue,
): Promise<BotTestTurnDecision> {
  // Admins may test unsaved draft prompt/rules text; a team lead (not
  // permitted to edit bot config at all) always runs against the persisted,
  // already-vetted config, regardless of what the request body claims —
  // otherwise this endpoint would let a non-editor execute arbitrary prompt
  // text through a real model call, the exact capability edit/save is
  // restricted to admins to prevent.
  const config = ctx.isAdmin
    ? resolved(
        true,
        body.config.prompt,
        body.config.rules,
        body.config.tools_config,
        body.config.limits_config,
      )
    : await withWorkspace(ctx.workspaceId, (tx) => resolveBotConfig(tx, ctx.workspaceId));

  const transcript: { role: ChatRole; body: string }[] = [
    ...body.history.map((m) => ({
      role: (m.author_type === 'player' ? 'user' : 'assistant') as ChatRole,
      body: m.body,
    })),
    { role: 'user' as ChatRole, body: body.player_message },
  ];

  const history: PlayerMessageView[] = [
    ...body.history.map((m, i) => syntheticPlayerMessageView(m.author_type, m.body, i)),
    syntheticPlayerMessageView('player', body.player_message, body.history.length),
  ];

  const botMessageCount = body.history.filter((m) => m.author_type === 'bot').length;

  const input: BotTurnInput = {
    workspaceId: ctx.workspaceId,
    conversationId: TEST_TURN_CONVERSATION_ID,
    subintentId: body.subintent_id,
    confirmPhase: body.confirm_phase,
    botMessageCount,
    // No conversation_resolved event can exist for a conversation that was
    // never created, so every bot message this turn counts toward the
    // unhelped cap the same way it counts toward the message cap.
    unhelpedReplyCount: botMessageCount,
    lastPlayerMessageAt: new Date(),
    history,
  };

  const decision = await toolLoopDecider(input, { config, transcript });

  const resolvedForm =
    decision.kind === 'handoff' &&
    decision.subintentId !== null &&
    decision.reason !== 'asked_for_person'
      ? await withWorkspace(ctx.workspaceId, (tx) =>
          resolveSubintentForm(tx, decision.subintentId!),
        )
      : null;

  return toWireDecision(decision, resolvedForm);
}

function toWireDecision(
  decision: BotTurnDecision,
  resolvedForm: ResolvedForm | null,
): BotTestTurnDecision {
  const base: Omit<BotTestTurnDecision, 'searches'> = (() => {
    switch (decision.kind) {
      case 'noop':
        return { kind: 'noop' };
      case 'answer':
        return {
          kind: 'answer',
          reply: decision.reply,
          subintent_id: decision.subintentId,
          ...(decision.articleId !== undefined ? { article_id: decision.articleId } : {}),
          ...(decision.grounding !== undefined ? { grounding: decision.grounding } : {}),
        };
      case 'resolve':
        return { kind: 'resolve', subintent_id: decision.subintentId };
      case 'handoff':
        return {
          kind: 'handoff',
          reason: decision.reason,
          subintent_id: decision.subintentId,
          form: resolvedForm
            ? {
                form_id: resolvedForm.formId,
                form_name: resolvedForm.formName,
                version: resolvedForm.version,
                fields: resolvedForm.fields,
              }
            : null,
        };
      case 'unavailable':
        return { kind: 'unavailable', reason: decision.reason };
      case 'confirm_player_resolution':
        return {
          kind: 'confirm_player_resolution',
          subintent_id: decision.subintentId,
          quoted_text: decision.quotedText,
        };
    }
  })();
  return (
    decision.searches
      ? {
          ...base,
          searches: decision.searches.map((s) => ({ query: s.query, results: s.results })),
        }
      : base
  ) as BotTestTurnDecision;
}
