import { Router } from 'express';
import { requireTeamLeadOrAdmin } from '../../shared/middleware/requireTeamLeadOrAdmin.ts';
import {
  askResolvedHandler,
  claimConversationHandler,
  escalateConversationHandler,
  getConversationContextHandler,
  getConversationDetailHandler,
  getConversationMessagesHandler,
  getWorkspaceWorkloadHandler,
  listConversationsHandler,
  reclassifyConversationHandler,
  reassignConversationHandler,
  setConversationPriorityHandler,
  takeOverConversationHandler,
  unescalateConversationHandler,
} from '../controllers/conversationsController.ts';

export const conversationsRouter = Router();
conversationsRouter.get('/conversations', listConversationsHandler);
conversationsRouter.get('/workload', requireTeamLeadOrAdmin, getWorkspaceWorkloadHandler);
conversationsRouter.get('/conversations/:id', getConversationDetailHandler);
conversationsRouter.get('/conversations/:id/context', getConversationContextHandler);
conversationsRouter.post('/conversations/:id/claim', claimConversationHandler);
conversationsRouter.post('/conversations/:id/take-over', takeOverConversationHandler);
conversationsRouter.get('/conversations/:id/messages', getConversationMessagesHandler);
conversationsRouter.post('/conversations/:id/ask-resolved', askResolvedHandler);
conversationsRouter.post('/conversations/:id/escalate', escalateConversationHandler);
conversationsRouter.post('/conversations/:id/unescalate', unescalateConversationHandler);
conversationsRouter.patch(
  '/conversations/:id/assign',
  requireTeamLeadOrAdmin,
  reassignConversationHandler,
);
conversationsRouter.patch('/conversations/:id/subintent', reclassifyConversationHandler);
conversationsRouter.patch('/conversations/:id/priority', setConversationPriorityHandler);
