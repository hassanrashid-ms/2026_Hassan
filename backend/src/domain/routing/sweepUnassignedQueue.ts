import { and, inArray, isNull, sql } from 'drizzle-orm';
import { conversation } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import {
  assignNextTicket,
  type AssignNextTicketResult,
  type AssignNextTicketStopReason,
} from './assignNextTicket.ts';

const UNASSIGNED_STATUSES = ['open', 'escalated'] as const;

export type SweepResult = {
  assignedCount: number;
  assignments: AssignNextTicketResult[];
  remainingCount: number;
  stopReason: AssignNextTicketStopReason;
};

async function countUnassigned(workspaceId: string): Promise<number> {
  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(conversation)
      .where(
        and(isNull(conversation.assignedAgentId), inArray(conversation.status, UNASSIGNED_STATUSES)),
      );
    return Number(row?.count ?? 0);
  });
}

/**
 * Drains the unassigned queue one ticket at a time via assignNextTicket,
 * stopping as soon as a call returns null (queue empty or no eligible agent
 * left — the same "normal stop condition" assignNextTicket documents). Each
 * iteration is its own transaction, so a failure partway through only loses
 * the one in-flight assignment, not the whole sweep.
 *
 * The iteration cap (queue size at sweep start, +1) exists only to guarantee
 * termination if conversations are being inserted into the queue faster than
 * the sweep drains it — it is not expected to bind in normal operation, since
 * assignNextTicket's own null return is what actually stops the loop.
 */
export async function sweepUnassignedQueue(workspaceId: string): Promise<SweepResult> {
  const maxIterations = (await countUnassigned(workspaceId)) + 1;
  const assignments: AssignNextTicketResult[] = [];
  let stopReason: AssignNextTicketStopReason = 'queue_empty';

  for (let i = 0; i < maxIterations; i++) {
    const outcome = await assignNextTicket(workspaceId);
    if (!outcome.assigned) {
      stopReason = outcome.reason;
      break;
    }
    assignments.push(outcome.result);
  }

  const remainingCount = await countUnassigned(workspaceId);

  return { assignedCount: assignments.length, assignments, remainingCount, stopReason };
}
