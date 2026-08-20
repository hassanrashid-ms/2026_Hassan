import { Router } from 'express'
import {
  askResolvedHandler,
  claimConversationHandler,
  escalateConversationHandler,
  getConversationContextHandler,
  getConversationDetailHandler,
  getConversationMessagesHandler,
  listConversationsHandler,
  takeOverConversationHandler,
  unescalateConversationHandler,
} from '../controllers/conversationsController.ts'

export const conversationsRouter = Router()
conversationsRouter.get('/conversations', listConversationsHandler)
conversationsRouter.get('/conversations/:id', getConversationDetailHandler)
conversationsRouter.get('/conversations/:id/context', getConversationContextHandler)
conversationsRouter.post('/conversations/:id/claim', claimConversationHandler)
conversationsRouter.post('/conversations/:id/take-over', takeOverConversationHandler)
conversationsRouter.get('/conversations/:id/messages', getConversationMessagesHandler)
conversationsRouter.post('/conversations/:id/ask-resolved', askResolvedHandler)
conversationsRouter.post('/conversations/:id/escalate', escalateConversationHandler)
conversationsRouter.post('/conversations/:id/unescalate', unescalateConversationHandler)
