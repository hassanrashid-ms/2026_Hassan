import { Router } from 'express';
import { requireTeamLeadOrAdmin } from '../../shared/middleware/requireTeamLeadOrAdmin.ts';
import { listAgentsHandler, setAgentLeaveHandler } from '../controllers/agentsController.ts';

export const agentsRouter = Router();

agentsRouter.get('/agents', listAgentsHandler);
agentsRouter.patch('/agents/:agentId/leave', requireTeamLeadOrAdmin, setAgentLeaveHandler);
