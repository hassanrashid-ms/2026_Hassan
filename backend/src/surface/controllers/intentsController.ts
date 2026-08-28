import type { RequestHandler } from 'express';
import { listPublicIntents } from '../services/intentsService.ts';

export const listPublicIntentsHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await listPublicIntents(req.player!));
};
