import type { RequestHandler } from 'express';
import { MarkAgentReadBody, SendAgentMessageBody } from '@support/types';
import { sendError } from '../../errors.ts';
import { markAgentMessagesRead, sendAgentMessage } from '../services/messagesService.ts';

export const postAgentMessageHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const body = SendAgentMessageBody.safeParse(req.body);
  if (!body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'conversation_id must be a uuid and body must be non-empty.',
    );
    return;
  }
  const result = await sendAgentMessage(ctx, body.data);
  if (result.outcome === 'not_found') {
    sendError(res, 404, 'not_found', 'Conversation not found.');
    return;
  }
  if (result.outcome === 'attachment_not_found') {
    sendError(res, 422, 'attachment_not_found', 'The uploaded file was not found or has expired.');
    return;
  }
  if (result.outcome === 'attachment_mismatch') {
    sendError(
      res,
      422,
      'attachment_mismatch',
      'The uploaded file does not match its declared type or size.',
    );
    return;
  }
  if (result.outcome === 'forbidden') {
    sendError(res, 403, 'forbidden', 'This conversation is not assigned to you.');
    return;
  }
  if (result.outcome === 'wrong_status') {
    sendError(
      res,
      409,
      'wrong_status',
      'Cannot send a message to a resolved or closed conversation.',
    );
    return;
  }
  res.status(200).json({ message: result.message });
};

export const markAgentReadHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const body = MarkAgentReadBody.safeParse(req.body);
  if (!body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'conversation_id must be a uuid and up_to_seq must be a non-negative integer.',
    );
    return;
  }
  await markAgentMessagesRead(ctx, body.data);
  res.status(200).json({ ok: true });
};
