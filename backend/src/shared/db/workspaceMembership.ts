import { and, eq, isNull } from 'drizzle-orm';
import { adminDb } from './adminClient.ts';
import { withoutWorkspace } from './withWorkspace.ts';
import { workspace, workspaceMember } from './schema/index.ts';

/**
 * `workspace_member` is RLS-scoped per table, so answering "which workspaces
 * is agent X in" needs a query outside any single workspace's transaction —
 * uses adminDb (bypasses RLS) filtered by agentId, the same pattern
 * membersService.ts already uses for admin-side membership queries.
 */
export type MembershipRow = {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  role: 'agent' | 'team_lead';
};

export async function listActiveMembershipsForAgent(agentId: string): Promise<MembershipRow[]> {
  return adminDb
    .select({
      workspaceId: workspaceMember.workspaceId,
      workspaceSlug: workspace.slug,
      workspaceName: workspace.name,
      role: workspaceMember.role,
    })
    .from(workspaceMember)
    .innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
    .where(and(eq(workspaceMember.agentId, agentId), isNull(workspaceMember.deactivatedAt)));
}

export type WorkspaceRow = { workspaceId: string; workspaceSlug: string; workspaceName: string };

/** A global admin has blanket access — this is their equivalent of the list above. */
export async function listAllWorkspaces(): Promise<WorkspaceRow[]> {
  return withoutWorkspace(async (tx) =>
    tx
      .select({
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        workspaceName: workspace.name,
      })
      .from(workspace),
  );
}
