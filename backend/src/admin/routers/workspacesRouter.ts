import { Router } from 'express'
import { createWorkspaceHandler, listWorkspacesHandler, renameWorkspaceHandler } from '../controllers/workspacesController.ts'
import { addMemberHandler, listMembersHandler, updateMemberHandler } from '../controllers/membersController.ts'

export const workspacesRouter = Router()
workspacesRouter.get('/workspaces', listWorkspacesHandler)
workspacesRouter.post('/workspaces', createWorkspaceHandler)
workspacesRouter.patch('/workspaces/:id', renameWorkspaceHandler)

workspacesRouter.get('/workspaces/:id/members', listMembersHandler)
workspacesRouter.post('/workspaces/:id/members', addMemberHandler)
workspacesRouter.patch('/workspaces/:id/members/:agentId', updateMemberHandler)
