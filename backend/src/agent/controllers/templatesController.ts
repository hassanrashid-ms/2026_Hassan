import type { RequestHandler } from 'express';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import {
  createTemplate,
  getTemplatesForAdmin,
  updateTemplateForAdmin,
  SYSTEM_MESSAGE_KEYS,
} from '../services/templatesAdminService.ts';

export const getTemplatesHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await getTemplatesForAdmin(req.agent!));
};

const CreateTemplateBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('system'),
    key: z.enum(SYSTEM_MESSAGE_KEYS),
    body: z.string().min(1),
  }),
  z.object({ kind: z.literal('canned'), label: z.string().min(1), body: z.string().min(1) }),
]);

export const createTemplateHandler: RequestHandler = async (req, res) => {
  const body = CreateTemplateBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'kind, key/label, and a non-empty body are required.');
    return;
  }
  const created = await createTemplate(req.agent!, body.data as any);
  res.status(201).json(created);
};

const TemplateIdParams = z.object({ id: z.uuid() });

const UpdateTemplateBody = z.object({
  body: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

export const updateTemplateHandler: RequestHandler = async (req, res) => {
  const params = TemplateIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const body = UpdateTemplateBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'At least one of body, label, or isActive is required.');
    return;
  }
  const updated = await updateTemplateForAdmin(req.agent!, params.data.id, body.data);
  res.status(200).json(updated);
};
