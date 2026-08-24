import { and, eq, isNull } from 'drizzle-orm';
import { agent as agentTable, workspace, workspaceMember } from '../../shared/db/schema/index.ts';
import { withoutWorkspace, withWorkspace } from '../../shared/db/withWorkspace.ts';
import { signAgentSession } from '../../shared/auth/agentSession.ts';

export type DevAgentOption = { id: string; email: string; display_name: string };

/**
 * `workspace_member` is RLS-scoped, so it can only be read inside
 * `withWorkspace(someWorkspaceId, ...)` — there is no query that answers "which
 * agents have any membership, across all workspaces" in one shot. This loops
 * over every workspace instead, which is fine for a handful of dev workspaces
 * and would need a different approach (e.g. a superuser reporting role) at real
 * scale — acceptable because this whole endpoint is a throwaway stand-in for
 * Google OAuth (docs/decisions/2026-08-04-agent-auth-google-oauth.md).
 *
 * A global admin (agent.is_admin) holds no workspace_member row at all under
 * the admin-dashboard model — see 2026-08-21-admin-dashboard-design.md — so the
 * per-workspace loop alone would never surface one. `agent` is one of the two
 * unscoped tables, so admins are fetched separately with a single
 * withoutWorkspace query and merged in.
 */
export async function listDevAgents(): Promise<DevAgentOption[]> {
  const workspaces = await withoutWorkspace(async (tx) =>
    tx.select({ id: workspace.id }).from(workspace),
  );

  const seen = new Map<string, DevAgentOption>();
  for (const ws of workspaces) {
    const rows = await withWorkspace(ws.id, async (tx) =>
      tx
        .select({ id: agentTable.id, email: agentTable.email, displayName: agentTable.displayName })
        .from(workspaceMember)
        .innerJoin(agentTable, eq(agentTable.id, workspaceMember.agentId))
        .where(isNull(workspaceMember.deactivatedAt)),
    );
    for (const row of rows) {
      seen.set(row.id, { id: row.id, email: row.email, display_name: row.displayName });
    }
  }

  const admins = await withoutWorkspace(async (tx) =>
    tx
      .select({ id: agentTable.id, email: agentTable.email, displayName: agentTable.displayName })
      .from(agentTable)
      .where(eq(agentTable.isAdmin, true)),
  );
  for (const row of admins) {
    seen.set(row.id, { id: row.id, email: row.email, display_name: row.displayName });
  }

  return [...seen.values()];
}

export type DevLoginResult = {
  token: string;
  agent: { id: string; display_name: string };
  workspace: { id: string; slug: string } | null;
} | null;

export async function devLogin(agentId: string): Promise<DevLoginResult> {
  const agentRow = await withoutWorkspace(async (tx) => {
    const [row] = await tx
      .select({
        id: agentTable.id,
        displayName: agentTable.displayName,
        isAdmin: agentTable.isAdmin,
      })
      .from(agentTable)
      .where(eq(agentTable.id, agentId))
      .limit(1);
    return row ?? null;
  });
  if (!agentRow) return null;

  const workspaces = await withoutWorkspace(async (tx) =>
    tx.select({ id: workspace.id, slug: workspace.slug }).from(workspace),
  );

  for (const ws of workspaces) {
    const membership = await withWorkspace(ws.id, async (tx) => {
      const [row] = await tx
        .select({ id: workspaceMember.id })
        .from(workspaceMember)
        .where(and(eq(workspaceMember.agentId, agentId), isNull(workspaceMember.deactivatedAt)))
        .limit(1);
      return row ?? null;
    });
    if (membership) {
      const token = await signAgentSession({ agent_id: agentRow.id, workspace_id: ws.id });
      return {
        token,
        agent: { id: agentRow.id, display_name: agentRow.displayName },
        workspace: { id: ws.id, slug: ws.slug },
      };
    }
  }

  // A global admin holds no workspace_member row at all — the loop above never
  // matches one, and unlike before there is no workspace to borrow: the token
  // carries no workspace_id claim (see
  // 2026-08-21-superadmin-workspace-console-access-design.md). Which workspace's
  // console an admin is looking at is resolved per request instead
  // (resolveConsoleWorkspace), not fixed at login. Falls through to `return
  // null` below if the agent isn't an admin either.
  if (agentRow.isAdmin) {
    const token = await signAgentSession({ agent_id: agentRow.id, is_admin: true });
    return {
      token,
      agent: { id: agentRow.id, display_name: agentRow.displayName },
      workspace: null,
    };
  }
  return null;
}
