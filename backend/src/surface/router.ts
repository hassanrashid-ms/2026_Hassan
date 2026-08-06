import { Router } from 'express'
import { requirePlayerToken } from '../shared/middleware/requirePlayerToken.ts'
import { articleReadRouter } from './routers/articleReadRouter.ts'
import { bootstrapRouter } from './routers/bootstrapRouter.ts'
import { messagesRouter } from './routers/messagesRouter.ts'

export const surfaceRouter = Router()

// requirePlayerToken only. A browser page has no reason to know the workspace slug,
// so requireSdkHeaders is deliberately absent here.
surfaceRouter.use(requirePlayerToken)

surfaceRouter.use(bootstrapRouter)
surfaceRouter.use(articleReadRouter)
surfaceRouter.use(messagesRouter)
