import { Router } from 'express';
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts';
import {
  createTemplateHandler,
  getTemplatesHandler,
  updateTemplateHandler,
} from '../controllers/templatesController.ts';

/** Read is any authenticated agent — canned replies are used from the chat composer by
 *  every agent, not just Team Lead/Admin. Writes stay Admin only, same as botConfigRouter
 *  and workspaceSettingsRouter. */
export const templatesRouter = Router();
templatesRouter.get('/templates', getTemplatesHandler);
templatesRouter.post('/templates', requireAdminRole, createTemplateHandler);
templatesRouter.patch('/templates/:id', requireAdminRole, updateTemplateHandler);
