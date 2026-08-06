import { Router } from 'express'
import {
  claimConversationHandler,
  getConversationMessagesHandler,
  listConversationsHandler,
} from '../controllers/conversationsController.ts'

export const conversationsRouter = Router()
conversationsRouter.get('/conversations', listConversationsHandler)
conversationsRouter.post('/conversations/:id/claim', claimConversationHandler)
conversationsRouter.get('/conversations/:id/messages', getConversationMessagesHandler)
