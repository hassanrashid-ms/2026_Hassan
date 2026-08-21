import { Router } from 'express'
import { createWorkspaceHandler, listWorkspacesHandler, renameWorkspaceHandler } from '../controllers/workspacesController.ts'

export const workspacesRouter = Router()
workspacesRouter.get('/workspaces', listWorkspacesHandler)
workspacesRouter.post('/workspaces', createWorkspaceHandler)
workspacesRouter.patch('/workspaces/:id', renameWorkspaceHandler)
