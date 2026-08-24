import { eq } from 'drizzle-orm';
import { agent, workspaceMember } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';

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
