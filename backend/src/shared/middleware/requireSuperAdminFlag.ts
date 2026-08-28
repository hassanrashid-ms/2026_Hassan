import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { sendError } from '../../errors.ts';
import { agent } from '../db/schema/index.ts';
import { withoutWorkspace } from '../db/withWorkspace.ts';

/** Gates grant/revoke of the is_admin and is_super_admin flags themselves. */
export const requireSuperAdminFlag: RequestHandler = async (req, res, next) => {
  const ctx = req.agent!;
  const isSuperAdmin = await withoutWorkspace(async (tx) => {
    const [row] = await tx
      .select({ isSuperAdmin: agent.isSuperAdmin })
      .from(agent)
      .where(eq(agent.id, ctx.agentId))
      .limit(1);
    return row?.isSuperAdmin ?? false;
  });

  if (!isSuperAdmin) {
    sendError(res, 403, 'forbidden', 'Requires super admin.');
    return;
  }
  next();
};
