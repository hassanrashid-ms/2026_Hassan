import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import { listActiveMembershipsForAgent, listAllWorkspaces } from '../../shared/db/workspaceMembership.ts';

export type MembershipView = {
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  role: 'agent' | 'team_lead' | 'admin';
};

export async function listMyMemberships(ctx: AgentContext): Promise<MembershipView[]> {
  if (ctx.isAdmin) {
    const workspaces = await listAllWorkspaces();
    return workspaces.map((w) => ({
      workspace_id: w.workspaceId,
      workspace_slug: w.workspaceSlug,
      workspace_name: w.workspaceName,
      role: 'admin' as const,
    }));
  }
  const memberships = await listActiveMembershipsForAgent(ctx.agentId);
  return memberships.map((m) => ({
    workspace_id: m.workspaceId,
    workspace_slug: m.workspaceSlug,
    workspace_name: m.workspaceName,
    role: m.role,
  }));
}
