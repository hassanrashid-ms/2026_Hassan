import type { RequestHandler } from 'express'
import { z } from 'zod'
import { sendError } from '../../errors.ts'
import { getIo } from '../../shared/realtime/socketServer.ts'
import { emitInboxChanged } from '../../shared/realtime/emit.ts'
import { claimConversation, getAgentConversationMessages, listConversations } from '../services/conversationsService.ts'

const ConversationsQuery = z.object({ status: z.enum(['unassigned', 'mine']) })
const ConversationIdParams = z.object({ id: z.uuid() })

export const listConversationsHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const query = ConversationsQuery.safeParse(req.query)
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'status must be "unassigned" or "mine".')
    return
  }
  const conversations = await listConversations(ctx, query.data.status)
  res.status(200).json({ conversations })
}

export const claimConversationHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const params = ConversationIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }
  const result = await claimConversation(ctx, params.data.id)
  if (result.claimed && result.status) {
    emitInboxChanged(getIo(), ctx.workspaceId, params.data.id, result.status)
  }
  res.status(200).json({ claimed: result.claimed })
}

export const getConversationMessagesHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const params = ConversationIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }
  const messages = await getAgentConversationMessages(ctx, params.data.id)
  if (!messages) {
    sendError(res, 404, 'not_found', 'Conversation not found.')
    return
  }
  res.status(200).json({ messages })
}
