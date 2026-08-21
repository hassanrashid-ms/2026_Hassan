import { Router } from 'express'
import { createWorkspaceHandler, listWorkspacesHandler } from '../controllers/workspacesController.ts'

export const workspacesRouter = Router()
workspacesRouter.get('/workspaces', listWorkspacesHandler)
workspacesRouter.post('/workspaces', createWorkspaceHandler)
