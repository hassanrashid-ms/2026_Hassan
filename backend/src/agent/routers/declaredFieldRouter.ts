import { Router } from 'express';
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts';
import {
  archiveDeclaredFieldHandler,
  createDeclaredFieldHandler,
  deactivateDeclaredFieldHandler,
  listDeclaredFieldsHandler,
  reactivateDeclaredFieldHandler,
  updateDeclaredFieldHandler,
} from '../controllers/declaredFieldController.ts';

/**
 * Every operation is admin-only (global agent.isAdmin) — unlike
 * workspaceSettingsRouter's team-lead-can-read split, this tab has no
 * lesser-role read access at all.
 */
export const declaredFieldRouter = Router();
declaredFieldRouter.get('/declared-fields', requireAdminRole, listDeclaredFieldsHandler);
declaredFieldRouter.post('/declared-fields', requireAdminRole, createDeclaredFieldHandler);
declaredFieldRouter.patch('/declared-fields/:id', requireAdminRole, updateDeclaredFieldHandler);
declaredFieldRouter.post(
  '/declared-fields/:id/deactivate',
  requireAdminRole,
  deactivateDeclaredFieldHandler,
);
declaredFieldRouter.post(
  '/declared-fields/:id/reactivate',
  requireAdminRole,
  reactivateDeclaredFieldHandler,
);
declaredFieldRouter.post(
  '/declared-fields/:id/archive',
  requireAdminRole,
  archiveDeclaredFieldHandler,
);
