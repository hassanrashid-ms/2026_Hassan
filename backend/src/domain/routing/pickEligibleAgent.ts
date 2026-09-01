import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { agent, conversation, workspace, workspaceMember } from '../../shared/db/schema/index.ts';
import { getPresenceStatusBatch } from '../../shared/realtime/presence.ts';
import { logger } from '../../shared/logging/logger.ts';

const LIVE_STATUSES = ['open', 'awaiting_player', 'escalated'] as const;

/**
 * Deterministic least-loaded, not round-robin — see the deviation recorded in
 * docs/decisions/spec-contradictions.md. Ties break by agent.id ascending, which
 * is what makes this testable without controlling a rotation cursor's starting
 * position. Returns null when no eligible agent is currently `online`; that is
 * not an error — the caller leaves the conversation unassigned.
 *
 * Shared by assignOnHandoff (bot handoff, one conversation) and
 * assignNextTicket (queue sweep, called once per ticket in a loop) — both need
 * the same "who gets the next one" answer, and re-reading live counts on every
 * call is what makes the sweep interleave across online agents instead of
 * filling one agent to their cap before considering anyone else.
 *
 * `online` only, not `away`: an agent who set themselves away has signalled
 * they don't want new work right now, same intent as `on_leave` — both are
 * excluded here, just via different signals (one a live Redis status, the
 * other a persisted account flag already filtered by `agent.status`).
 *
 * A Redis failure degrades to "nobody online" (fail-closed) rather than
 * silently ignoring presence and assigning anyway — same fallback direction
 * `conversationsService.ts`'s workload roster uses for a Redis-down read.
 */
export async function pickEligibleAgent(tx: Tx, workspaceId: string): Promise<string | null> {
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
    .orderBy(liveCount, asc(agent.id));

  if (rows.length === 0) return null;

  let presenceByAgent: Map<string, 'online' | 'away' | 'offline'>;
  try {
    presenceByAgent = await getPresenceStatusBatch(rows.map((r) => r.agentId));
  } catch (error) {
    logger.error(
      'pick_eligible_agent',
      `presence batch read failed, treating every candidate as offline: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    presenceByAgent = new Map();
  }

  const online = rows.find((r) => presenceByAgent.get(r.agentId) === 'online');
  return online?.agentId ?? null;
}
