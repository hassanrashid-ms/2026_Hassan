import type { RequestHandler } from 'express';
import { getGlobalInbox } from '../services/globalInboxService.ts';

export const getGlobalInboxHandler: RequestHandler = async (req, res) => {
  const result = await getGlobalInbox(req.agent!);
  res.status(200).json(result);
};
