import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import { resolveSubintentForm } from '../forms/resolveSubintentForm.ts';
import type { BotTestResolutionDecision, TestResolutionAnswerBodyValue } from '@support/types';

/**
 * Mirrors domain/conversations/resolutionAnswer.ts's decision, without any of
 * its writes: no message, no event, no conversation row, because this
 * conversation is synthetic and non-persisted, same as botTestTurn.ts.
 *
 * `bot_article` is the only phase resolutionAnswer.ts routes through
 * applyBotTurn (`resolve` on Yes, `handoff('article_rejected')` on No) rather
 * than answering inline — both are pre-decided outcomes, not a fresh model
 * turn, so this reproduces them the same way: a straight `resolved`, and the
 * same resolveSubintentForm lookup applyBotTurn's handoff branch runs, so a
 * subintent with a published form shows one here exactly as it would for a
 * real player.
 */
export async function runTestResolutionAnswer(
  ctx: AgentContext,
  body: TestResolutionAnswerBodyValue,
): Promise<BotTestResolutionDecision> {
  if (body.confirm_phase === 'bot_article') {
    if (body.helped) return { kind: 'resolved' };

    const resolvedForm = body.subintent_id
      ? await withWorkspace(ctx.workspaceId, (tx) => resolveSubintentForm(tx, body.subintent_id!))
      : null;
    return {
      kind: 'handed_off',
      reason: 'article_rejected',
      form: resolvedForm
        ? {
            form_id: resolvedForm.formId,
            form_name: resolvedForm.formName,
            version: resolvedForm.version,
            fields: resolvedForm.fields,
          }
        : null,
    };
  }

  return body.helped ? { kind: 'resolved' } : { kind: 'reopened' };
}
