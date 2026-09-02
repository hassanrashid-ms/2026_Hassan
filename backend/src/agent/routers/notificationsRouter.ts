import { Router } from 'express';
import {
  listNotificationsHandler,
  markAllNotificationsReadHandler,
  markNotificationReadHandler,
} from '../controllers/notificationsController.ts';

export const notificationsRouter = Router();
notificationsRouter.get('/notifications', listNotificationsHandler);
notificationsRouter.patch('/notifications/read-all', markAllNotificationsReadHandler);
notificationsRouter.patch('/notifications/:id/read', markNotificationReadHandler);
