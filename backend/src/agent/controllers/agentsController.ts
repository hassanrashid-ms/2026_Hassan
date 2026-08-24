import type { RequestHandler } from 'express';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import { getIo } from '../../shared/realtime/socketServer.ts';
import { inboxRoom } from '../../shared/realtime/rooms.ts';
import { listWorkspaceAgents, setAgentLeaveStatus } from '../services/agentsService.ts';

export const listAgentsHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const agents = await listWorkspaceAgents(ctx.workspaceId);
  res.status(200).json({ agents });
};

const LeaveBody = z.object({ onLeave: z.boolean() });

export const setAgentLeaveHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const body = LeaveBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 400, 'invalid_request', 'onLeave must be a boolean.');
    return;
  }

  const result = await setAgentLeaveStatus(ctx.workspaceId, req.params.agentId, body.data.onLeave);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'agent_not_found', 'Agent not found in this workspace.');
    } else {
      sendError(res, 409, 'invalid_status', 'Agent is deactivated or invited; leave status cannot be changed.');
    }
    return;
  }

  getIo()
    .to(inboxRoom(ctx.workspaceId))
    .emit('presence_changed', { agentId: req.params.agentId, status: result.status });
  res.status(200).json({ status: result.status });
};
