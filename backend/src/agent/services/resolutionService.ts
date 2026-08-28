import { eq } from 'drizzle-orm';
import {
  postMessage,
  RESOLUTION_CHECK_MESSAGE,
  type PostedMessageRow,
} from '../../domain/conversations/index.ts';
import { appendEvent } from '../../shared/events/appendEvent.ts';
import { conversation } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';

// 'escalated' is included so a ticket that's gone to engineering still has a path to
// resolved: there is no agent-side "mark resolved" anywhere in this product (see docstring
// below), so this ask is the only way out of escalated other than staying escalated forever.
const ASKABLE_STATUSES = new Set(['open', 'awaiting_player', 'escalated']);

export type AskResolvedOutcome =
  | { ok: true; posted: PostedMessageRow }
  | { ok: false; reason: 'not_found' | 'wrong_status' | 'not_owner' | 'already_pending' };

/**
 * The agent-side twin of the bot's answer_from_article: it puts the conversation into
 * a pending yes/no and nothing more. It never resolves anything — there is no
 * agent-side "mark resolved" in this product, by design. Only the player's
 * answer moves the status.
 *
 * `for('update')` is load-bearing, not defensive: without it two taps racing on
 * the same row both read 'none' and both post the question.
 */
export async function askResolved(
  ctx: AgentContext,
  conversationId: string,
): Promise<AskResolvedOutcome> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx
      .select({
        status: conversation.status,
        confirmPhase: conversation.confirmPhase,
        assignedAgentId: conversation.assignedAgentId,
      })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1)
      .for('update');

    // RLS makes "another workspace's" and "nonexistent" the same answer.
    if (!found) return { ok: false, reason: 'not_found' };
    if (!ASKABLE_STATUSES.has(found.status)) return { ok: false, reason: 'wrong_status' };
    // Unassigned is allowed: assignOnHandoff returns null when no agent is
    // active, and an open-but-unowned conversation must not be a dead end.
    if (found.assignedAgentId !== null && found.assignedAgentId !== ctx.agentId) {
      return { ok: false, reason: 'not_owner' };
    }
    // Rejects a double-ask and a replayed request in one check — the same job
    // the bot's phase guard does on its side.
    if (found.confirmPhase !== 'none') return { ok: false, reason: 'already_pending' };

    const posted = await postMessage(tx, {
      workspaceId: ctx.workspaceId,
      conversationId,
      authorType: 'system',
      actorId: null,
      body: RESOLUTION_CHECK_MESSAGE,
      visibility: 'public',
    });

    await tx
      .update(conversation)
      .set({ confirmPhase: 'agent_ask' })
      .where(eq(conversation.id, conversationId));

    // No session_id: an agent-console request has no player session behind it.
    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'resolution_check_requested',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { source: 'agent', agent_id: ctx.agentId },
    });

    return { ok: true, posted };
  });
}
