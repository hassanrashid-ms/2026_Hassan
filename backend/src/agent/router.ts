import { Router } from 'express'
import { requireAgentSession } from '../shared/middleware/requireAgentSession.ts'
import { authRouter } from './routers/authRouter.ts'
import { conversationsRouter } from './routers/conversationsRouter.ts'
import { messagesRouter } from './routers/messagesRouter.ts'
import { taxonomyRouter } from './routers/taxonomyRouter.ts'
import { tagsRouter } from './routers/tagsRouter.ts'
import { articlesRouter } from './routers/articlesRouter.ts'
import { botConfigRouter } from './routers/botConfigRouter.ts'
import { formsRouter } from './routers/formsRouter.ts'
import { agentsRouter } from './routers/agentsRouter.ts'

export const agentRouter = Router()

// Public: this IS the login flow, so it cannot require the session it mints.
agentRouter.use(authRouter)

agentRouter.use(requireAgentSession)
agentRouter.use(taxonomyRouter)
agentRouter.use(tagsRouter)
agentRouter.use(articlesRouter)
agentRouter.use(botConfigRouter)
agentRouter.use(formsRouter)
agentRouter.use(conversationsRouter)
agentRouter.use(messagesRouter)
agentRouter.use(agentsRouter)
