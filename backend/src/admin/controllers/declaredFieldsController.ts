import type { RequestHandler } from 'express';
import { z } from 'zod';
import { CreateDeclaredFieldBody, UpdateDeclaredFieldBody } from '@support/types';
import { sendError } from '../../errors.ts';
import {
  archiveDeclaredField,
  createDeclaredField,
  deactivateDeclaredField,
  listDeclaredFields,
  reactivateDeclaredField,
  updateDeclaredField,
} from '../services/declaredFieldsService.ts';

const DeclaredFieldParams = z.object({ id: z.uuid(), fieldId: z.uuid() });

export const listDeclaredFieldsHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await listDeclaredFields(req.params.id as string));
};

export const createDeclaredFieldHandler: RequestHandler = async (req, res) => {
  const body = CreateDeclaredFieldBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'key, label and a valid type are required.');
    return;
  }
  const result = await createDeclaredField(
    req.params.id as string,
    req.agent!.agentId,
    body.data,
  );
  if (!result.ok) {
    sendError(res, 409, 'key_taken', 'A declared field with this key already exists.');
    return;
  }
  res.status(201).json(result.field);
};

export const updateDeclaredFieldHandler: RequestHandler = async (req, res) => {
  const params = DeclaredFieldParams.safeParse(req.params);
  const body = UpdateDeclaredFieldBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'A valid id and at least one of label/type are required.',
    );
    return;
  }
  const result = await updateDeclaredField(
    params.data.id,
    params.data.fieldId,
    req.agent!.agentId,
    body.data,
  );
  if (!result.ok) {
    if (result.reason === 'seeded_type_locked') {
      sendError(
        res,
        409,
        'seeded_field_locked',
        'This field is built in — only its label can be changed.',
      );
      return;
    }
    sendError(res, 404, 'not_found', 'Declared field not found.');
    return;
  }
  res.status(200).json(result.field);
};

export const deactivateDeclaredFieldHandler: RequestHandler = async (req, res) => {
  const params = DeclaredFieldParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid id is required.');
    return;
  }
  const result = await deactivateDeclaredField(
    params.data.id,
    params.data.fieldId,
    req.agent!.agentId,
  );
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Declared field not found or not currently active.');
    return;
  }
  res.status(200).json(result.field);
};

export const reactivateDeclaredFieldHandler: RequestHandler = async (req, res) => {
  const params = DeclaredFieldParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid id is required.');
    return;
  }
  const result = await reactivateDeclaredField(
    params.data.id,
    params.data.fieldId,
    req.agent!.agentId,
  );
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Declared field not found or not currently inactive.');
    return;
  }
  res.status(200).json(result.field);
};

export const archiveDeclaredFieldHandler: RequestHandler = async (req, res) => {
  const params = DeclaredFieldParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid id is required.');
    return;
  }
  const result = await archiveDeclaredField(
    params.data.id,
    params.data.fieldId,
    req.agent!.agentId,
  );
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Declared field not found.');
    return;
  }
  res.status(200).json(result.field);
};
