import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { sendError } from '../../errors.ts';
import { adminDb } from '../db/adminClient.ts';
import { agent } from '../db/schema/index.ts';

/**
 * Gates every /admin/* route. Runs after requireAgentSession, which puts the
 * verified claims on req.agent. The read itself goes through crm_admin (agent
 * has no RLS policy regardless — it's one of the two unscoped tables — but every
 * /admin/* handler downstream of this gate uses adminDb, so this check does too,
 * to fail the same way the rest of the route would if crm_admin were misconfigured).
 */
export const requireAdminAccess: RequestHandler = async (req, res, next) => {
  const ctx = req.agent!;
  const [row] = await adminDb
    .select({ isAdmin: agent.isAdmin })
    .from(agent)
    .where(eq(agent.id, ctx.agentId))
    .limit(1);

  if (!row?.isAdmin) {
    sendError(res, 403, 'forbidden', 'Requires admin.');
    return;
  }
  next();
};
