import type { RequestHandler } from 'express'
import { sendError } from '../../errors.ts'
import { InvalidAgentSession, verifyAgentSession } from '../auth/agentSession.ts'

/**
 * `workspaceId` is always a string by the time a handler sees it: for a
 * regular agent it comes straight off the JWT; for an admin (`isAdmin: true`)
 * it starts empty here and is filled in by `resolveConsoleWorkspace` (mounted
 * on the agent router only) before any /agent/* handler runs. /admin/* handlers
 * never read it — they use `adminDb` under `crm_admin`, not RLS.
 */
export type AgentContext = { agentId: string; workspaceId: string; isAdmin: boolean }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agent?: AgentContext
    }
  }
}

export const requireAgentSession: RequestHandler = async (req, res, next) => {
  const header = req.header('authorization') ?? ''
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) {
    sendError(res, 401, 'unauthorized', 'Expected an Authorization: Bearer <agent_session_token> header.')
    return
  }

  try {
    const claims = await verifyAgentSession(rest.join(' ').trim())
    req.agent =
      'is_admin' in claims && claims.is_admin
        ? { agentId: claims.agent_id, workspaceId: '', isAdmin: true }
        : { agentId: claims.agent_id, workspaceId: claims.workspace_id, isAdmin: false }
    next()
  } catch (error) {
    if (error instanceof InvalidAgentSession) {
      sendError(res, 401, 'unauthorized', 'Agent session is not valid.')
      return
    }
    next(error)
  }
}
