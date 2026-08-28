import type { RequestHandler } from 'express';
import { RequestUploadBody } from '@support/types';
import { sendError } from '../../errors.ts';
import { maxBytesForAttachment } from '../../shared/storage/presign.ts';
import { cancelPlayerUpload, requestPlayerUpload } from '../services/uploadsService.ts';

export const postUploadRequestHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!;
  const body = RequestUploadBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'filename, content_type and byte_size are required.');
    return;
  }
  if (body.data.byte_size > maxBytesForAttachment(body.data.content_type)) {
    sendError(res, 422, 'invalid_request', 'byte_size exceeds the size limit for this file type.');
    return;
  }
  const result = await requestPlayerUpload(ctx, body.data);
  if (result.outcome === 'invalid_media_type') {
    sendError(
      res,
      422,
      'unsupported_media_type',
      'Only PNG, JPEG, WEBP, GIF, MP4 or WEBM are accepted.',
    );
    return;
  }
  if (result.outcome === 'too_large') {
    sendError(res, 422, 'invalid_request', 'byte_size exceeds the size limit for this file type.');
    return;
  }
  res
    .status(200)
    .json({ key: result.key, upload_url: result.upload_url, expires_at: result.expires_at });
};

export const deleteUploadHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!;
  // Normalized to a single string by uploadsRouter's wildcard-join middleware.
  const key = req.params.key as string;
  const result = await cancelPlayerUpload(ctx, key);
  if (result === 'not_owner') {
    sendError(res, 404, 'not_found', 'Upload not found.');
    return;
  }
  res.status(204).send();
};
