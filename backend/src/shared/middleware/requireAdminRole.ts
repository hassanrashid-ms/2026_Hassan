import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { sendError } from '../../errors.ts';
import { agent } from '../db/schema/index.ts';
import { withoutWorkspace } from '../db/withWorkspace.ts';

/**
 * Global, not workspace-scoped: an admin manages every workspace, so this reads
 * agent.is_admin directly rather than a workspace_member role. Kept as the same
 * export name it always had — POST /agent/intents and the other 10 existing call
 * sites need no edit; only what "admin" means underneath changed.
 *
 * agent is one of the two unscoped tables, so this reads it with
 * withoutWorkspace rather than withWorkspace.
 */
export const requireAdminRole: RequestHandler = async (req, res, next) => {
  const ctx = req.agent!;
  const isAdmin = await withoutWorkspace(async (tx) => {
    const [row] = await tx
      .select({ isAdmin: agent.isAdmin })
      .from(agent)
      .where(eq(agent.id, ctx.agentId))
      .limit(1);
    return row?.isAdmin ?? false;
  });

  if (!isAdmin) {
    sendError(res, 403, 'forbidden', 'Requires admin.');
    return;
  }
  next();
};
