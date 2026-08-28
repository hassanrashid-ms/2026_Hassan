import type { RequestHandler } from 'express';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import {
  createWorkspace,
  listWorkspaces,
  renameWorkspace,
  SlugTaken,
} from '../services/workspacesService.ts';

export const listWorkspacesHandler: RequestHandler = async (_req, res) => {
  const workspaces = await listWorkspaces();
  res.status(200).json({ workspaces });
};

const CreateWorkspaceBody = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, numbers, and hyphens'),
});

export const createWorkspaceHandler: RequestHandler = async (req, res) => {
  const body = CreateWorkspaceBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'name or slug is missing or malformed.');
    return;
  }
  try {
    const created = await createWorkspace(body.data);
    res.status(201).json(created);
  } catch (error) {
    if (error instanceof SlugTaken) {
      sendError(res, 422, 'name_taken', 'That slug is already in use.');
      return;
    }
    throw error;
  }
};

const RenameWorkspaceBody = z.object({ name: z.string().min(1).max(200) });

export const renameWorkspaceHandler: RequestHandler = async (req, res) => {
  const body = RenameWorkspaceBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'name is missing or malformed.');
    return;
  }
  const updated = await renameWorkspace(req.params.id as string, body.data.name);
  if (!updated) {
    sendError(res, 404, 'not_found', 'Workspace not found.');
    return;
  }
  res.status(200).json(updated);
};
