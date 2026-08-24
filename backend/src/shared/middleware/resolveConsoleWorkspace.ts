import type { RequestHandler } from 'express'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { sendError } from '../../errors.ts'
import { workspace } from '../db/schema/index.ts'
import { withoutWorkspace } from '../db/withWorkspace.ts'

const uuidSchema = z.uuid()

/**
 * Mounted on the agent router only, right after `requireAgentSession` — see
 * 2026-08-21-superadmin-workspace-console-access-design.md. A regular agent's
 * `req.agent.workspaceId` is already set correctly from their JWT and is left
 * untouched: the header is never consulted for them, so it can't be used to
 * escalate into another tenant.
 *
 * An admin's JWT carries no workspace_id claim at all, so their target
 * workspace is supplied per request via X-Workspace-Id. It's checked against
 * a real, non-deleted workspace with an explicit SELECT before it's trusted —
 * an unknown or malformed id is a 404, matching the existing "not yours and
 * not there are indistinguishable" RLS convention, never a silent empty page.
 */
export const resolveConsoleWorkspace: RequestHandler = async (req, res, next) => {
  const ctx = req.agent!
  if (!ctx.isAdmin) {
    next()
    return
  }

  const header = req.header('x-workspace-id')
  const parsed = uuidSchema.safeParse(header)
  if (!parsed.success) {
    sendError(res, 404, 'not_found', 'Workspace not found.')
    return
  }

  const exists = await withoutWorkspace(async (tx) => {
    const [row] = await tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, parsed.data)).limit(1)
    return row !== undefined
  })
  if (!exists) {
    sendError(res, 404, 'not_found', 'Workspace not found.')
    return
  }

  req.agent = { ...ctx, workspaceId: parsed.data }
  next()
}
