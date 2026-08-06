import type { RequestHandler } from 'express'
import { MarkAgentReadBody, SendAgentMessageBody } from '@support/types'
import { sendError } from '../../errors.ts'
import { markAgentMessagesRead, sendAgentMessage } from '../services/messagesService.ts'

export const postAgentMessageHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const body = SendAgentMessageBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'conversation_id must be a uuid and body must be non-empty.')
    return
  }
  const result = await sendAgentMessage(ctx, body.data)
  if (result.outcome === 'not_found') {
    sendError(res, 404, 'not_found', 'Conversation not found.')
    return
  }
  if (result.outcome === 'forbidden') {
    sendError(res, 403, 'forbidden', 'This conversation is not assigned to you.')
    return
  }
  res.status(200).json({ message: result.message })
}

export const markAgentReadHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const body = MarkAgentReadBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'conversation_id must be a uuid and up_to_seq must be a non-negative integer.')
    return
  }
  await markAgentMessagesRead(ctx, body.data)
  res.status(200).json({ ok: true })
}
