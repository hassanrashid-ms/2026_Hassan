import { and, eq } from 'drizzle-orm';
import { agent, workspaceMember } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import { getPresenceStatus, type LivePresenceStatus } from '../../shared/realtime/presence.ts';

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
  | { ok: true; status: LivePresenceStatus | 'on_leave' }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_status' };

/**
 * Team lead/admin toggle of the on_leave account flag. Restricted to the
 * active <-> on_leave transition — deactivated/invited agents aren't valid
 * targets, since leave is a lead-managed subset of the account lifecycle,
 * not a general status editor.
 */
export async function setAgentLeaveStatus(
  workspaceId: string,
  targetAgentId: string,
  onLeave: boolean,
): Promise<SetAgentLeaveResult> {
  return withWorkspace(workspaceId, async (tx) => {
    const [member] = await tx
      .select({ status: agent.status })
      .from(workspaceMember)
      .innerJoin(agent, eq(agent.id, workspaceMember.agentId))
      .where(
        and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.agentId, targetAgentId)),
      )
      .limit(1);

    if (!member) return { ok: false, reason: 'not_found' };
    if (member.status !== 'active' && member.status !== 'on_leave') {
      return { ok: false, reason: 'invalid_status' };
    }

    await tx
      .update(agent)
      .set({ status: onLeave ? 'on_leave' : 'active' })
      .where(eq(agent.id, targetAgentId));

    if (onLeave) return { ok: true, status: 'on_leave' };
    const liveStatus = await getPresenceStatus(targetAgentId);
    return { ok: true, status: liveStatus };
  });
}
