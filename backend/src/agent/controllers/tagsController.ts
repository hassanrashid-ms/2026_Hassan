import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AttachTagBody, CreateTagBody, RenameTagBody } from '@support/types';
import { sendError } from '../../errors.ts';
import {
  archiveTag,
  attachTag,
  createTag,
  detachTag,
  listTags,
  renameTag,
} from '../services/tagsService.ts';

const TagIdParams = z.object({ id: z.uuid() });
const ConversationIdParams = z.object({ id: z.uuid() });
const ConversationTagParams = z.object({ id: z.uuid(), tagId: z.uuid() });
const ListTagsQuery = z.object({ query: z.string().optional() });

export const listTagsHandler: RequestHandler = async (req, res) => {
  const query = ListTagsQuery.safeParse(req.query);
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'query must be a string.');
    return;
  }
  const tags = await listTags(req.agent!, query.data.query);
  res.status(200).json(tags);
};

export const createTagHandler: RequestHandler = async (req, res) => {
  const body = CreateTagBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'name is required.');
    return;
  }
  const result = await createTag(req.agent!, body.data.name);
  res.status(result.created ? 201 : 200).json(result.tag);
};

export const renameTagHandler: RequestHandler = async (req, res) => {
  const params = TagIdParams.safeParse(req.params);
  const body = RenameTagBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'A valid tag id and name are required.');
    return;
  }
  const result = await renameTag(req.agent!, params.data.id, body.data.name);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Tag not found.');
      return;
    }
    sendError(res, 409, 'name_taken', 'Another tag already has this name.');
    return;
  }
  res.status(200).json(result.tag);
};

export const archiveTagHandler: RequestHandler = async (req, res) => {
  const params = TagIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid tag id is required.');
    return;
  }
  const result = await archiveTag(req.agent!, params.data.id);
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Tag not found.');
    return;
  }
  res.status(200).json(result.tag);
};

export const attachTagHandler: RequestHandler = async (req, res) => {
  const params = ConversationIdParams.safeParse(req.params);
  const body = AttachTagBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'A valid conversation id and tagId are required.');
    return;
  }
  const result = await attachTag(req.agent!, params.data.id, body.data.tagId);
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Tag not found.');
    return;
  }
  res.status(200).json(result);
};

export const detachTagHandler: RequestHandler = async (req, res) => {
  const params = ConversationTagParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'A valid conversation id and tag id are required.');
    return;
  }
  const result = await detachTag(req.agent!, params.data.id, params.data.tagId);
  res.status(200).json(result);
};
