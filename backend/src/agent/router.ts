import { Router } from 'express'
import { requireAgentSession } from '../shared/middleware/requireAgentSession.ts'
import { authRouter } from './routers/authRouter.ts'
import { conversationsRouter } from './routers/conversationsRouter.ts'
import { messagesRouter } from './routers/messagesRouter.ts'
import { taxonomyRouter } from './routers/taxonomyRouter.ts'
import { articlesRouter } from './routers/articlesRouter.ts'
import { botConfigRouter } from './routers/botConfigRouter.ts'

export const agentRouter = Router()

// Public: this IS the login flow, so it cannot require the session it mints.
agentRouter.use(authRouter)

agentRouter.use(requireAgentSession)
agentRouter.use(taxonomyRouter)
agentRouter.use(articlesRouter)
agentRouter.use(botConfigRouter)
agentRouter.use(conversationsRouter)
agentRouter.use(messagesRouter)
