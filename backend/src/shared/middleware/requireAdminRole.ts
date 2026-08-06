import type { RequestHandler } from 'express'
import { and, eq, isNull } from 'drizzle-orm'
import { sendError } from '../../errors.ts'
import { workspaceMember } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'

/**
 * Runs after requireAgentSession. Role is not carried in the session JWT (see
 * Task 2's plan note), so this re-reads workspace_member on every request — a
 * demoted admin loses the ability to hit an admin-gated route on their very
 * next request, not at token expiry.
 */
export const requireAdminRole: RequestHandler = async (req, res, next) => {
  const ctx = req.agent!
  const isAdmin = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .select({ role: workspaceMember.role })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.agentId, ctx.agentId), isNull(workspaceMember.deactivatedAt)))
      .limit(1)
    return row?.role === 'admin'
  })
  if (!isAdmin) {
    sendError(res, 403, 'forbidden', 'Admin role required.')
    return
  }
  next()
}
