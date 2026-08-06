import { Router } from 'express'
import { markAgentReadHandler, postAgentMessageHandler } from '../controllers/messagesController.ts'

export const messagesRouter = Router()
messagesRouter.post('/messages', postAgentMessageHandler)
messagesRouter.post('/messages/read', markAgentReadHandler)
