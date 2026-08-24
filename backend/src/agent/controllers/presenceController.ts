import type { RequestHandler } from 'express';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import { getIo } from '../../shared/realtime/socketServer.ts';
import { inboxRoom } from '../../shared/realtime/rooms.ts';
import { getAgentPresence, setAgentPresence } from '../services/presenceService.ts';

const PresenceBody = z.object({ status: z.enum(['online', 'away']) });

export const setPresenceHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const body = PresenceBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 400, 'invalid_request', "status must be 'online' or 'away'.");
    return;
  }

  const result = await setAgentPresence(ctx.agentId, body.data.status);
  if (!result.ok) {
    sendError(
      res,
      409,
      'not_connected',
      'Cannot set presence while fully disconnected — no open socket.',
    );
    return;
  }

  getIo()
    .to(inboxRoom(ctx.workspaceId))
    .emit('presence_changed', { agentId: ctx.agentId, status: body.data.status });

  res.status(200).json({ status: body.data.status });
};

export const getPresenceHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const status = await getAgentPresence(ctx.agentId);
  res.status(200).json({ status });
};
