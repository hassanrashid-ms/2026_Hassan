import type { RequestHandler } from 'express'
import { BootstrapQuery, MarkPlayerReadBody, SendMessageBody } from '@support/types'
import { sendError } from '../../errors.ts'
import { getPlayerMessages, markPlayerMessagesRead, sendPlayerMessage } from '../services/messagesService.ts'

export const postMessageHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!
  const body = SendMessageBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'body must be a non-empty string.')
    return
  }
  const result = await sendPlayerMessage(ctx, body.data)
  res.status(200).json(result)
}

export const getMessagesHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!
  const query = BootstrapQuery.safeParse(req.query)
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'session_id must be a uuid.')
    return
  }
  const result = await getPlayerMessages(ctx, query.data)
  if (!result) {
    sendError(res, 404, 'not_found', 'Session not found.')
    return
  }
  res.status(200).json(result)
}

export const markReadHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!
  const body = MarkPlayerReadBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'up_to_seq must be a non-negative integer.')
    return
  }
  await markPlayerMessagesRead(ctx, body.data)
  res.status(200).json({ ok: true })
}
