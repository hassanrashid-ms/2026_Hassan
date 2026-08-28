import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { sendError } from '../../errors.ts';
import { adminDb } from '../db/adminClient.ts';
import { agent } from '../db/schema/index.ts';

/** Gates grant/revoke of is_admin and is_super_admin themselves. Run after requireAdminAccess. */
export const requireSuperAdminAccess: RequestHandler = async (req, res, next) => {
  const ctx = req.agent!;
  const [row] = await adminDb
    .select({ isSuperAdmin: agent.isSuperAdmin })
    .from(agent)
    .where(eq(agent.id, ctx.agentId))
    .limit(1);

  if (!row?.isSuperAdmin) {
    sendError(res, 403, 'forbidden', 'Requires super admin.');
    return;
  }
  next();
};
