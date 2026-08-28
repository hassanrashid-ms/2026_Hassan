import { Router } from 'express';
import { unread } from '../controllers/unreadController.ts';

export const unreadRouter = Router();
unreadRouter.get('/unread', unread);
