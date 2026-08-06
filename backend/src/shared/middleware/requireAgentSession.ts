import type { RequestHandler } from 'express'
import { sendError } from '../../errors.ts'
import { InvalidAgentSession, verifyAgentSession } from '../auth/agentSession.ts'

export type AgentContext = { agentId: string; workspaceId: string }

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
    req.agent = { agentId: claims.agent_id, workspaceId: claims.workspace_id }
    next()
  } catch (error) {
    if (error instanceof InvalidAgentSession) {
      sendError(res, 401, 'unauthorized', 'Agent session is not valid.')
      return
    }
    next(error)
  }
}
