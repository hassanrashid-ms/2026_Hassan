import { Router } from 'express'
import { requireAgentSession } from '../shared/middleware/requireAgentSession.ts'
import { requireAdminAccess } from '../shared/middleware/requireAdminAccess.ts'
import { workspacesRouter } from './routers/workspacesRouter.ts'

export const adminRouter = Router()

adminRouter.use(requireAgentSession)
adminRouter.use(requireAdminAccess)
adminRouter.use(workspacesRouter)
