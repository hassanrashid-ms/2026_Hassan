import { Router } from 'express';
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts';
import { requireTeamLeadOrAdmin } from '../../shared/middleware/requireTeamLeadOrAdmin.ts';
import {
  archiveFormHandler,
  createFormHandler,
  getFormHandler,
  listFormsHandler,
  publishFormHandler,
  setFormSubintentsHandler,
  updateFormHandler,
} from '../controllers/formsController.ts';

const canBuildForms = requireTeamLeadOrAdmin;

export const formsRouter = Router();
formsRouter.get('/forms', canBuildForms, listFormsHandler);
formsRouter.post('/forms', canBuildForms, createFormHandler);
formsRouter.get('/forms/:id', canBuildForms, getFormHandler);
formsRouter.patch('/forms/:id', canBuildForms, updateFormHandler);
formsRouter.post('/forms/:id/publish', requireAdminRole, publishFormHandler);
formsRouter.post('/forms/:id/archive', requireAdminRole, archiveFormHandler);
formsRouter.patch('/forms/:id/subintents', canBuildForms, setFormSubintentsHandler);
