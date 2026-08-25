import type { RequestHandler } from 'express';
import { listMyMemberships } from '../services/membershipsService.ts';

export const getMembershipsHandler: RequestHandler = async (req, res) => {
  const memberships = await listMyMemberships(req.agent!);
  res.status(200).json({ memberships });
};
