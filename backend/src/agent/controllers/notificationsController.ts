import type { RequestHandler } from 'express';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import {
  listNotificationsForAgent,
  markAllNotificationsRead,
  markNotificationRead,
} from '../../domain/notifications/notificationsQueryService.ts';

export const listNotificationsHandler: RequestHandler = async (req, res) => {
  const result = await listNotificationsForAgent(req.agent!);
  res.status(200).json(result);
};

const NotificationIdParams = z.object({ id: z.uuid() });

export const markNotificationReadHandler: RequestHandler = async (req, res) => {
  const params = NotificationIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const ok = await markNotificationRead(req.agent!, params.data.id);
  if (!ok) {
    sendError(res, 404, 'not_found', 'Notification not found.');
    return;
  }
  res.status(200).json({ read: true });
};

export const markAllNotificationsReadHandler: RequestHandler = async (req, res) => {
  const updated = await markAllNotificationsRead(req.agent!);
  res.status(200).json({ updated });
};
