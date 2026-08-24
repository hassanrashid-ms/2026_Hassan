import type { RequestHandler } from 'express';
import { NewTicketBody } from '@support/types';
import { sendError } from '../../errors.ts';
import { openNewTicket } from '../services/newTicketService.ts';

const ERRORS = {
  not_found: [404, 'No conversation found for this player.'],
  conversation_still_open: [
    409,
    'The current conversation is still open. Resolve or close it first.',
  ],
} as const;

export const newTicketHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!;
  const body = NewTicketBody.safeParse(req.body ?? {});
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'session_id, if present, must be a uuid.');
    return;
  }

  const result = await openNewTicket(ctx, body.data);
  if (!result.ok) {
    const [status, message] = ERRORS[result.reason];
    sendError(res, status, result.reason, message);
    return;
  }

  // `message: null` keeps this identical in shape to what POST /surface/messages
  // returns when it creates a conversation — a new ticket simply starts empty.
  res
    .status(201)
    .json({ conversation_id: result.conversationId, status: result.status, message: null });
};
