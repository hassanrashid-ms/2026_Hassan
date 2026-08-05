import { Router, type Router as RouterType } from 'express'
import { requirePlayerToken } from '../auth/requirePlayerToken.ts'
import { articleRead } from './articleRead.ts'
import { bootstrap } from './bootstrap.ts'

export const surfaceRouter: RouterType = Router()

// requirePlayerToken only. A browser page has no reason to know the workspace slug,
// so requireSdkHeaders is deliberately absent here.
surfaceRouter.use(requirePlayerToken)

surfaceRouter.get('/bootstrap', bootstrap)
surfaceRouter.post('/events/article_read', articleRead)
