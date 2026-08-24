import { Router } from 'express';
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts';
import { requireTeamLeadOrAdmin } from '../../shared/middleware/requireTeamLeadOrAdmin.ts';
import {
  getWorkspaceSettingsHandler,
  saveWorkspaceSettingsHandler,
} from '../controllers/workspaceSettingsController.ts';

/** Same read/write role split as botConfigRouter: Team Lead + Admin read, Admin only writes. */
export const workspaceSettingsRouter = Router();
workspaceSettingsRouter.get('/workspace-settings', requireTeamLeadOrAdmin, getWorkspaceSettingsHandler);
workspaceSettingsRouter.post('/workspace-settings', requireAdminRole, saveWorkspaceSettingsHandler);
