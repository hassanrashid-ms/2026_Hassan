import { and, eq, sql } from 'drizzle-orm';
import { agent, workspaceMember } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import { getPresenceStatus, type LivePresenceStatus } from '../../shared/realtime/presence.ts';
import { appendChangeLog } from '../../shared/changeLog/appendChangeLog.ts';

export type WorkspaceAgentSummary = {
  id: string;
  display_name: string;
  email: string;
  role: string;
};

export async function listWorkspaceAgents(workspaceId: string): Promise<WorkspaceAgentSummary[]> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx
      .select({
        id: agent.id,
        display_name: agent.displayName,
        email: agent.email,
        role: workspaceMember.role,
      })
      .from(workspaceMember)
      .innerJoin(agent, eq(agent.id, workspaceMember.agentId))
      .where(eq(workspaceMember.workspaceId, workspaceId))
      .orderBy(agent.displayName);

    return rows;
  });
}

export type SetAgentLeaveResult =
  | {
      ok: true;
      status: LivePresenceStatus | 'on_leave';
      onLeaveSince: Date | null;
      onLeaveUntil: Date | null;
    }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_status' };

/**
 * Team lead/admin toggle of the on_leave account flag. Restricted to the
 * active <-> on_leave transition — deactivated/invited agents aren't valid
 * targets, since leave is a lead-managed subset of the account lifecycle,
 * not a general status editor.
 *
 * `days` (only meaningful when onLeave is true) sets a planned return date
 * (on_leave_until); omitted/undefined means indefinite. Nothing currently
 * auto-clears status at that date — it's informational until a lead clears
 * leave manually.
 */
export async function setAgentLeaveStatus(
  workspaceId: string,
  targetAgentId: string,
  onLeave: boolean,
  actorId: string,
  days?: number,
): Promise<SetAgentLeaveResult> {
  return withWorkspace(workspaceId, async (tx) => {
    const [member] = await tx
      .select({
        status: agent.status,
        onLeaveSince: agent.onLeaveSince,
        onLeaveUntil: agent.onLeaveUntil,
      })
      .from(workspaceMember)
      .innerJoin(agent, eq(agent.id, workspaceMember.agentId))
      .where(
        and(
          eq(workspaceMember.workspaceId, workspaceId),
          eq(workspaceMember.agentId, targetAgentId),
        ),
      )
      .limit(1);

    if (!member) return { ok: false, reason: 'not_found' };
    if (member.status !== 'active' && member.status !== 'on_leave') {
      return { ok: false, reason: 'invalid_status' };
    }

    const [updated] = await tx
      .update(agent)
      .set({
        status: onLeave ? 'on_leave' : 'active',
        onLeaveSince: onLeave ? sql`now()` : null,
        onLeaveUntil: onLeave && days ? sql`now() + (${days} * interval '1 day')` : null,
      })
      .where(eq(agent.id, targetAgentId))
      .returning({
        status: agent.status,
        onLeaveSince: agent.onLeaveSince,
        onLeaveUntil: agent.onLeaveUntil,
      });

    await appendChangeLog(tx, {
      workspaceId,
      entityType: 'agent',
      entityId: targetAgentId,
      actorId,
      changes: [
        { field: 'status', before: member.status, after: updated!.status },
        { field: 'on_leave_since', before: member.onLeaveSince, after: updated!.onLeaveSince },
        { field: 'on_leave_until', before: member.onLeaveUntil, after: updated!.onLeaveUntil },
      ],
    });

    if (onLeave) {
      return {
        ok: true,
        status: 'on_leave',
        onLeaveSince: updated!.onLeaveSince,
        onLeaveUntil: updated!.onLeaveUntil,
      };
    }
    const liveStatus = await getPresenceStatus(targetAgentId);
    return { ok: true, status: liveStatus, onLeaveSince: null, onLeaveUntil: null };
  });
}
