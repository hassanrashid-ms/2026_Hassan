import type { RequestHandler } from 'express';
import { z } from 'zod';
import { CreateFormBody, SetFormSubintentsBody, UpdateFormBody } from '@support/types';
import { sendError } from '../../errors.ts';
import {
  archiveForm,
  createForm,
  getForm,
  listForms,
  publishForm,
  setFormSubintents,
  updateForm,
} from '../services/formsService.ts';

const FormIdParams = z.object({ id: z.uuid() });

export const listFormsHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await listForms(req.agent!));
};

export const getFormHandler: RequestHandler = async (req, res) => {
  const params = FormIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const found = await getForm(req.agent!, params.data.id);
  if (!found) {
    sendError(res, 404, 'not_found', 'Form not found.');
    return;
  }
  res.status(200).json(found);
};

export const createFormHandler: RequestHandler = async (req, res) => {
  const body = CreateFormBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'name is required.');
    return;
  }
  const result = await createForm(req.agent!, body.data.name);
  res.status(201).json({ id: result.id, draftVersionId: result.draftVersionId });
};

export const updateFormHandler: RequestHandler = async (req, res) => {
  const params = FormIdParams.safeParse(req.params);
  const body = UpdateFormBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'Invalid form update payload.');
    return;
  }
  const result = await updateForm(req.agent!, params.data.id, {
    name: body.data.name,
    fields: body.data.fields,
  });
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Form not found.');
      return;
    }
    sendError(res, 422, 'invalid_request', 'attachment and time fields are not permitted.');
    return;
  }
  res.status(200).json(result.form);
};

export const publishFormHandler: RequestHandler = async (req, res) => {
  const params = FormIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const result = await publishForm(req.agent!, params.data.id);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Form not found.');
      return;
    }
    const message =
      result.reason === 'empty_draft'
        ? 'A published form must have at least one field.'
        : 'Form has no draft to publish.';
    sendError(res, 409, 'invalid_request', message);
    return;
  }
  res.status(200).json(result.form);
};

export const archiveFormHandler: RequestHandler = async (req, res) => {
  const params = FormIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const result = await archiveForm(req.agent!, params.data.id);
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Form not found.');
    return;
  }
  res.status(200).json(result.form);
};

export const setFormSubintentsHandler: RequestHandler = async (req, res) => {
  const params = FormIdParams.safeParse(req.params);
  const body = SetFormSubintentsBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'subintentIds must be an array of uuids.');
    return;
  }
  const result = await setFormSubintents(req.agent!, params.data.id, body.data.subintentIds);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Form not found.');
      return;
    }
    sendError(
      res,
      422,
      'invalid_request',
      `Unknown or archived subintent id(s): ${result.invalidIds.join(', ')}.`,
    );
    return;
  }
  res.status(200).json(result.form);
};
