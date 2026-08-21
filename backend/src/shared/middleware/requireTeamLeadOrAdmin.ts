import type { RequestHandler } from 'express'
import { eq } from 'drizzle-orm'
import { sendError } from '../../errors.ts'
import { agent } from '../db/schema/index.ts'
import { withoutWorkspace } from '../db/withWorkspace.ts'
import { requireWorkspaceRole } from './requireWorkspaceRole.ts'

const isTeamLead = requireWorkspaceRole('team_lead')

/**
 * Replaces the old requireWorkspaceRole('team_lead', 'admin') now that admin is
 * global rather than a workspace_member role: a team lead check plus a global
 * is_admin check, either one sufficient. Used where the permission matrix reads
 * "Team Lead, Admin" — see botConfigRouter.ts and formsRouter.ts.
 */
export const requireTeamLeadOrAdmin: RequestHandler = async (req, res, next) => {
  const ctx = req.agent!
  const isAdmin = await withoutWorkspace(async (tx) => {
    const [row] = await tx.select({ isAdmin: agent.isAdmin }).from(agent).where(eq(agent.id, ctx.agentId)).limit(1)
    return row?.isAdmin ?? false
  })
  if (isAdmin) {
    next()
    return
  }
  isTeamLead(req, res, next)
}
