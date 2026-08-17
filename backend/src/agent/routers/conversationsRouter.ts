import { Router } from 'express'
import {
  askResolvedHandler,
  claimConversationHandler,
  getConversationDetailHandler,
  getConversationMessagesHandler,
  listConversationsHandler,
} from '../controllers/conversationsController.ts'

export const conversationsRouter = Router()
conversationsRouter.get('/conversations', listConversationsHandler)
conversationsRouter.get('/conversations/:id', getConversationDetailHandler)
conversationsRouter.post('/conversations/:id/claim', claimConversationHandler)
conversationsRouter.get('/conversations/:id/messages', getConversationMessagesHandler)
conversationsRouter.post('/conversations/:id/ask-resolved', askResolvedHandler)
