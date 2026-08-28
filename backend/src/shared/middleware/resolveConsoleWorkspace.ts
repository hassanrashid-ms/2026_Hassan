import type { RequestHandler } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import { workspace, workspaceMember } from '../db/schema/index.ts';
import { adminDb } from '../db/adminClient.ts';
import { withoutWorkspace } from '../db/withWorkspace.ts';
import { getCachedWsAuth, setCachedWsAuth, type WsAuthCacheEntry } from '../auth/wsAuthCache.ts';

const uuidSchema = z.uuid();

/**
 * Mounted on the agent router after requireAgentSession (and after
 * membershipsRouter/globalInboxRouter, which don't need a target workspace) —
 * everything after this middleware does. Generalizes what was previously an
 * admin-only check
 * (2026-08-21-superadmin-workspace-console-access-design.md) to every agent:
 * see 2026-08-25-global-inbox-workspace-decoupling-design.md section 1.
 * Neither an admin's nor a regular agent's JWT carries a workspace_id claim
 * any more (Task 1) — the target workspace always comes from X-Workspace-Id.
 * An admin is exempt only from the workspace_member membership check below (an
 * admin holds no workspace_member row anywhere by design), not from supplying
 * the header at all.
 */
export const resolveConsoleWorkspace: RequestHandler = async (req, res, next) => {
  const ctx = req.agent!;
  const header = req.header('x-workspace-id');
  const parsed = uuidSchema.safeParse(header);
  if (!parsed.success) {
    sendError(res, 404, 'not_found', 'Workspace not found.');
    return;
  }
  const workspaceId = parsed.data;

  const exists = await withoutWorkspace(async (tx) => {
    const [row] = await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    return row !== undefined;
  });
  if (!exists) {
    sendError(res, 404, 'not_found', 'Workspace not found.');
    return;
  }

  if (!ctx.isAdmin) {
    let cached = await getCachedWsAuth(ctx.agentId, workspaceId);
    if (cached === null) {
      const [row] = await adminDb
        .select({ role: workspaceMember.role, deactivatedAt: workspaceMember.deactivatedAt })
        .from(workspaceMember)
        .where(
          and(
            eq(workspaceMember.agentId, ctx.agentId),
            eq(workspaceMember.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      const fresh: WsAuthCacheEntry = row
        ? { active: row.deactivatedAt === null, role: row.role }
        : { active: false, role: null };
      await setCachedWsAuth(ctx.agentId, workspaceId, fresh);
      cached = fresh;
    }
    if (!cached.active) {
      sendError(res, 404, 'not_found', 'Workspace not found.');
      return;
    }
  }

  req.agent = { ...ctx, workspaceId };
  next();
};
