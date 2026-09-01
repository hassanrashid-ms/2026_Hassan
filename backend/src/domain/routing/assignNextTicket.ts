// backend/src/domain/routing/assignNextTicket.ts
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { conversation } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import { appendEvent } from '../../shared/events/appendEvent.ts';
import { pickEligibleAgent } from './pickEligibleAgent.ts';

// Same as conversationsService.ts's UNASSIGNED_STATUSES — 'awaiting_player'
// always carries an assignee already, so it never appears in this queue.
const UNASSIGNED_STATUSES = ['open', 'escalated'] as const;

export type AssignNextTicketResult = {
  conversationId: string;
  agentId: string;
  status: (typeof UNASSIGNED_STATUSES)[number];
};

/**
 * Assigns at most one conversation: the highest-priority, oldest unassigned
 * ticket in the workspace, to the least-loaded eligible online agent. Returns
 * null (no-op) when either side of that pair doesn't exist — an empty queue
 * or no eligible agent are both normal stop conditions for the caller's loop,
 * never errors. See docs/specs/2026-09-01-ticket-assignment-sweep-design.md.
 */
export async function assignNextTicket(
  workspaceId: string,
): Promise<AssignNextTicketResult | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const [next] = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
      })
      .from(conversation)
      .where(
        and(isNull(conversation.assignedAgentId), inArray(conversation.status, UNASSIGNED_STATUSES)),
      )
      .orderBy(asc(conversation.priority), asc(conversation.createdAt), asc(conversation.id))
      .limit(1);

    if (!next) return null;

    const agentId = await pickEligibleAgent(tx, workspaceId);
    if (!agentId) return null;

    await tx
      .update(conversation)
      .set({ assignedAgentId: agentId })
      .where(eq(conversation.id, next.id));

    await appendEvent(tx, {
      workspaceId,
      type: 'conversation_assigned',
      conversationId: next.id,
      actorId: null,
      actorType: 'system',
      payload: { agent_id: agentId, via: 'sweep' },
    });

    return {
      conversationId: next.id,
      agentId,
      status: next.status as AssignNextTicketResult['status'],
    };
  });
}
