import type { RequestHandler } from 'express';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import { devLogin as devLoginService, listDevAgents } from '../services/authService.ts';

// Kept local rather than in @support/types: this endpoint is a throwaway
// dev-picker stand-in for Google OAuth, not a contract any other audience shares.
const DevLoginBody = z.object({ agent_id: z.uuid() });

export const devAgents: RequestHandler = async (_req, res) => {
  const agents = await listDevAgents();
  res.status(200).json({ agents });
};

export const devLogin: RequestHandler = async (req, res) => {
  const body = DevLoginBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'agent_id must be a uuid.');
    return;
  }
  const result = await devLoginService(body.data.agent_id);
  if (!result) {
    sendError(res, 404, 'not_found', 'Agent not found.');
    return;
  }
  res.status(200).json(result);
};
