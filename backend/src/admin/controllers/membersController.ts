import type { RequestHandler } from 'express';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import { addMember, listMembers, updateMember } from '../services/membersService.ts';

export const listMembersHandler: RequestHandler = async (req, res) => {
  const members = await listMembers(req.params.id as string);
  res.status(200).json({ members });
};

const AddMemberBody = z.object({
  email: z.email(),
  role: z.enum(['agent', 'team_lead']),
});

export const addMemberHandler: RequestHandler = async (req, res) => {
  const body = AddMemberBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'email or role is missing or malformed.');
    return;
  }
  const member = await addMember({
    workspaceId: req.params.id as string,
    email: body.data.email,
    role: body.data.role,
  });
  res.status(201).json(member);
};

const UpdateMemberBody = z.object({
  role: z.enum(['agent', 'team_lead']).optional(),
  remove: z.boolean().optional(),
});

export const updateMemberHandler: RequestHandler = async (req, res) => {
  const body = UpdateMemberBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'role or remove is malformed.');
    return;
  }
  const result = await updateMember({
    workspaceId: req.params.id as string,
    agentId: req.params.agentId as string,
    role: body.data.role,
    remove: body.data.remove,
  });
  if (result === null && !body.data.remove) {
    sendError(res, 404, 'not_found', 'Member not found in this workspace.');
    return;
  }
  res.status(200).json(result ?? { removed: true });
};
