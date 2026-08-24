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

const LeaveParams = z.object({ agentId: z.uuid() });
const LeaveBody = z.object({ onLeave: z.boolean(), days: z.number().int().positive().optional() });

export const setAgentLeaveHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const params = LeaveParams.safeParse(req.params);
  const body = LeaveBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 400, 'invalid_request', 'onLeave must be a boolean; days must be a positive integer.');
    return;
  }

  const result = await setAgentLeaveStatus(
    ctx.workspaceId,
    params.data.agentId,
    body.data.onLeave,
    ctx.agentId,
    body.data.days,
  );
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'agent_not_found', 'Agent not found in this workspace.');
    } else {
      sendError(res, 409, 'invalid_status', 'Agent is deactivated or invited; leave status cannot be changed.');
    }
    return;
  }

  getIo().to(inboxRoom(ctx.workspaceId)).emit('presence_changed', {
    agentId: params.data.agentId,
    status: result.status,
    onLeaveSince: result.onLeaveSince,
    onLeaveUntil: result.onLeaveUntil,
  });
  res.status(200).json({
    status: result.status,
    onLeaveSince: result.onLeaveSince,
    onLeaveUntil: result.onLeaveUntil,
  });
};
