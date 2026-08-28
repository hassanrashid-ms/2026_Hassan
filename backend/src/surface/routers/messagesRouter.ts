import { Router } from 'express';
import {
  getMessagesHandler,
  markReadHandler,
  postMessageHandler,
} from '../controllers/messagesController.ts';

export const messagesRouter = Router();
messagesRouter.post('/messages', postMessageHandler);
messagesRouter.get('/messages', getMessagesHandler);
messagesRouter.post('/messages/read', markReadHandler);
