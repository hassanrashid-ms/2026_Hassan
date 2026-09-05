import { Router } from 'express';
import {
  createWorkspaceHandler,
  listWorkspacesHandler,
  renameWorkspaceHandler,
} from '../controllers/workspacesController.ts';
import {
  addMemberHandler,
  listMembersHandler,
  updateMemberHandler,
} from '../controllers/membersController.ts';
import { getSecretHandler, rotateSecretHandler } from '../controllers/secretController.ts';
import {
  archiveDeclaredFieldHandler,
  createDeclaredFieldHandler,
  deactivateDeclaredFieldHandler,
  listDeclaredFieldsHandler,
  reactivateDeclaredFieldHandler,
  updateDeclaredFieldHandler,
} from '../controllers/declaredFieldsController.ts';

export const workspacesRouter = Router();
workspacesRouter.get('/workspaces', listWorkspacesHandler);
workspacesRouter.post('/workspaces', createWorkspaceHandler);
workspacesRouter.patch('/workspaces/:id', renameWorkspaceHandler);

workspacesRouter.get('/workspaces/:id/members', listMembersHandler);
workspacesRouter.post('/workspaces/:id/members', addMemberHandler);
workspacesRouter.patch('/workspaces/:id/members/:agentId', updateMemberHandler);

workspacesRouter.get('/workspaces/:id/secret', getSecretHandler);
workspacesRouter.post('/workspaces/:id/secret/rotate', rotateSecretHandler);

workspacesRouter.get('/workspaces/:id/declared-fields', listDeclaredFieldsHandler);
workspacesRouter.post('/workspaces/:id/declared-fields', createDeclaredFieldHandler);
workspacesRouter.patch('/workspaces/:id/declared-fields/:fieldId', updateDeclaredFieldHandler);
workspacesRouter.post(
  '/workspaces/:id/declared-fields/:fieldId/deactivate',
  deactivateDeclaredFieldHandler,
);
workspacesRouter.post(
  '/workspaces/:id/declared-fields/:fieldId/reactivate',
  reactivateDeclaredFieldHandler,
);
workspacesRouter.post(
  '/workspaces/:id/declared-fields/:fieldId/archive',
  archiveDeclaredFieldHandler,
);
