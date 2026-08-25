import { Router } from 'express';
import { getGlobalInboxHandler } from '../controllers/globalInboxController.ts';

export const globalInboxRouter = Router();
globalInboxRouter.get('/global-inbox', getGlobalInboxHandler);
