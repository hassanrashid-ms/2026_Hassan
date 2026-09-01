import { Router } from 'express';
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts';
import { requireTeamLeadOrAdmin } from '../../shared/middleware/requireTeamLeadOrAdmin.ts';
import {
  createTemplateHandler,
  getTemplatesHandler,
  updateTemplateHandler,
} from '../controllers/templatesController.ts';

/** Same read/write role split as botConfigRouter and workspaceSettingsRouter: Team Lead + Admin read, Admin only writes. */
export const templatesRouter = Router();
templatesRouter.get('/templates', requireTeamLeadOrAdmin, getTemplatesHandler);
templatesRouter.post('/templates', requireAdminRole, createTemplateHandler);
templatesRouter.patch('/templates/:id', requireAdminRole, updateTemplateHandler);
