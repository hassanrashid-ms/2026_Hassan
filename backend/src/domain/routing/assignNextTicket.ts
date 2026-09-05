// backend/src/domain/routing/assignNextTicket.ts
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { NotificationView } from '@support/types';
import { conversation } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import { appendEvent } from '../../shared/events/appendEvent.ts';
import { notifyAgent } from '../notifications/notifyAgent.ts';
import { pickEligibleAgent, type PickEligibleAgentStopReason } from './pickEligibleAgent.ts';

// Same as conversationsService.ts's UNASSIGNED_STATUSES — 'awaiting_player'
// always carries an assignee already, so it never appears in this queue.
const UNASSIGNED_STATUSES = ['open', 'escalated'] as const;

export type AssignNextTicketResult = {
  conversationId: string;
  agentId: string;
  status: (typeof UNASSIGNED_STATUSES)[number];
  notification: NotificationView;
};

export type AssignNextTicketStopReason = 'queue_empty' | PickEligibleAgentStopReason;

export type AssignNextTicketOutcome =
  | { assigned: true; result: AssignNextTicketResult }
  | { assigned: false; reason: AssignNextTicketStopReason };

/**
 * Assigns at most one conversation: the highest-priority, oldest unassigned
 * ticket in the workspace, to the least-loaded eligible online agent. Reports
 * `assigned: false` (no-op) when either side of that pair doesn't exist — an
 * empty queue or no eligible agent are both normal stop conditions for the
 * caller's loop, never errors. See
 * docs/specs/2026-09-01-ticket-assignment-sweep-design.md and
 * docs/specs/2026-09-02-bulk-assign-toast-detail-design.md.
 */
export async function assignNextTicket(workspaceId: string): Promise<AssignNextTicketOutcome> {
  return withWorkspace(workspaceId, async (tx) => {
    const [next] = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
      })
      .from(conversation)
      .where(
        and(
          isNull(conversation.assignedAgentId),
          inArray(conversation.status, UNASSIGNED_STATUSES),
        ),
      )
      .orderBy(asc(conversation.priority), asc(conversation.createdAt), asc(conversation.id))
      .limit(1);

    if (!next) return { assigned: false, reason: 'queue_empty' };

    const picked = await pickEligibleAgent(tx, workspaceId);
    if (picked.agentId === null) return { assigned: false, reason: picked.reason };
    const agentId = picked.agentId;

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

    const notification = await notifyAgent(tx, {
      workspaceId,
      agentId,
      conversationId: next.id,
      via: 'sweep',
    });

    return {
      assigned: true,
      result: {
        conversationId: next.id,
        agentId,
        status: next.status as AssignNextTicketResult['status'],
        notification,
      },
    };
  });
}
