import { Router } from 'express'
import { requireAgentSession } from '../shared/middleware/requireAgentSession.ts'
import { authRouter } from './routers/authRouter.ts'

export const agentRouter = Router()

// Public: this IS the login flow, so it cannot require the session it mints.
agentRouter.use(authRouter)

// Everything mounted after this line requires a valid agent session. Later
// tasks in this plan add their routers below this line, not above it.
agentRouter.use(requireAgentSession)
