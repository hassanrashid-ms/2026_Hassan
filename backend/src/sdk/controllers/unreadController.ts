import type { RequestHandler } from 'express';
import type { UnreadResponse } from '@support/types';
import { getUnreadCount } from '../services/unreadService.ts';

export const unread: RequestHandler = async (req, res) => {
  const player = req.player!;

  const count = await getUnreadCount(player);

  const payload: UnreadResponse = { unread_count: count };
  res.status(200).json(payload);
};
