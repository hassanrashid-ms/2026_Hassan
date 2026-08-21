import type { RequestHandler } from 'express'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { sendError } from '../../errors.ts'
import { workspaceMember } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'

export type WorkspaceRole = 'agent' | 'team_lead'

/**
 * Gates a route on a SET of workspace roles, per the permission matrix in
 * docs/project-overview.md §Roles and permissions. A permission is never granted
 * to an individual, so the only input is the role.
 *
 * Runs after requireAgentSession, which puts the verified claims on req.agent.
 *
 * Role is NOT carried in the session JWT, so this re-reads workspace_member on
 * every request: a demoted agent loses a gated route on their very next request
 * rather than at token expiry. A deactivated member holds no role at all, hence
 * the deactivatedAt filter.
 *
 * The read is scoped to the session's workspace by RLS plus the agent predicate,
 * so being an admin of some OTHER workspace grants nothing here.
 */
export function requireWorkspaceRole(
  ...roles: readonly [WorkspaceRole, ...WorkspaceRole[]]
): RequestHandler {
  return async (req, res, next) => {
    const ctx = req.agent!
    const allowed = await withWorkspace(ctx.workspaceId, async (tx) => {
      const [row] = await tx
        .select({ role: workspaceMember.role })
        .from(workspaceMember)
        .where(
          and(
            eq(workspaceMember.agentId, ctx.agentId),
            isNull(workspaceMember.deactivatedAt),
            inArray(workspaceMember.role, [...roles]),
          ),
        )
        .limit(1)
      return row !== undefined
    })

    if (!allowed) {
      sendError(res, 403, 'forbidden', `Requires one of these roles: ${roles.join(', ')}.`)
      return
    }
    next()
  }
}
