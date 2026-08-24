import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { agent, conversation, workspace, workspaceMember } from '../../shared/db/schema/index.ts';

const LIVE_STATUSES = ['open', 'awaiting_player', 'escalated'] as const;

/**
 * Deterministic least-loaded, not round-robin — see the deviation recorded in
 * docs/decisions/spec-contradictions.md. Ties break by agent.id ascending, which
 * is what makes this testable without controlling a rotation cursor's starting
 * position. Returns null when no active agent exists; that is not an error.
 */
export async function assignOnHandoff(tx: Tx, workspaceId: string): Promise<string | null> {
  const liveCount = sql<number>`count(${conversation.id}) filter (where ${inArray(conversation.status, [...LIVE_STATUSES])})`;

  const rows = await tx
    .select({
      agentId: agent.id,
      liveCount,
    })
    .from(workspaceMember)
    .innerJoin(agent, eq(agent.id, workspaceMember.agentId))
    .innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
    .leftJoin(
      conversation,
      and(eq(conversation.assignedAgentId, agent.id), eq(conversation.workspaceId, workspaceId)),
    )
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        isNull(workspaceMember.deactivatedAt),
        eq(agent.status, 'active'),
      ),
    )
    .groupBy(agent.id, workspace.maxAssignedTickets)
    // Excludes agents already at capacity — not just deprioritizes them.
    .having(lt(liveCount, workspace.maxAssignedTickets))
    .orderBy(liveCount, asc(agent.id))
    .limit(1);

  return rows[0]?.agentId ?? null;
}
