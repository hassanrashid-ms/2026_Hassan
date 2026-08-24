import { Router } from 'express';
import { requireSuperAdminAccess } from '../../shared/middleware/requireSuperAdminAccess.ts';
import {
  listAgentsHandler,
  setAdminHandler,
  setSuperAdminHandler,
} from '../controllers/agentsController.ts';

export const agentsRouter = Router();
agentsRouter.get('/agents', listAgentsHandler);
agentsRouter.patch('/agents/:id/admin', requireSuperAdminAccess, setAdminHandler);
agentsRouter.patch('/agents/:id/super-admin', requireSuperAdminAccess, setSuperAdminHandler);
