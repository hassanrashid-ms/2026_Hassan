import type { RequestHandler } from 'express'
import { z } from 'zod'
import { sendError } from '../../errors.ts'
import { getIo } from '../../shared/realtime/socketServer.ts'
import { emitInboxChanged, emitMessageToRooms, emitPhaseChanged } from '../../shared/realtime/emit.ts'
import { toAgentView, toPlayerView } from '../../domain/conversations/index.ts'
import { claimConversation, getAgentConversationMessages, listConversations, reassignConversation, takeOverConversation } from '../services/conversationsService.ts'
import { askResolved } from '../services/resolutionService.ts'
import { escalateConversation, unescalateConversation } from '../services/escalationService.ts'
import { getConversationContext, getConversationDetail } from '../services/conversationContextService.ts'

const ConversationsQuery = z.object({
  status: z.enum(['unassigned', 'mine', 'agentAssigned', 'botHandling', 'escalated']),
  priority: z.union([z.enum(['p1', 'p2', 'p3', 'p4']), z.array(z.enum(['p1', 'p2', 'p3', 'p4']))]).optional().transform(v => v ? (Array.isArray(v) ? v : [v]) : undefined),
  labelIds: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional().transform(v => v ? (Array.isArray(v) ? v : [v]) : undefined),
  subintentIds: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional().transform(v => v ? (Array.isArray(v) ? v : [v]) : undefined),
  assigneeIds: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional().transform(v => v ? (Array.isArray(v) ? v : [v]) : undefined),
  olderThanHours: z.coerce.number().optional(),
  q: z.string().optional()
})
const ConversationIdParams = z.object({ id: z.uuid() })

export const listConversationsHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const query = ConversationsQuery.safeParse(req.query)
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'Invalid query parameters.')
    return
  }
  const { status, ...extra } = query.data
  const conversations = await listConversations(ctx, status, extra)
  res.status(200).json({ conversations })
}

export const takeOverConversationHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const params = ConversationIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }
  const result = await takeOverConversation(ctx, params.data.id)
  if (result.claimed && result.status) {
    emitInboxChanged(getIo(), ctx.workspaceId, params.data.id, result.status)
    // toPlayerView returns null for an internal message — this never reaches the player room.
    if (result.posted) emitMessageToRooms(getIo(), params.data.id, toPlayerView(result.posted), toAgentView(result.posted))
    // takeOverConversation always resets confirmPhase to 'none', including out from
    // under a pending bot_article banner — without this, the player's client keeps
    // showing "Is your issue resolved?" from stale cache, and tapping Yes/No 409s
    // (no_check_pending) against the DB's already-'none' phase instead of clearing.
    emitPhaseChanged(getIo(), params.data.id, { conversation_id: params.data.id, confirm_phase: 'none' })
  }
  res.status(200).json({ taken_over: result.claimed })
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
    // toPlayerView returns null for an internal message — this never reaches the player room.
    if (result.posted) emitMessageToRooms(getIo(), params.data.id, toPlayerView(result.posted), toAgentView(result.posted))
  }
  res.status(200).json({ claimed: result.claimed })
}

const ReassignBody = z.object({ agentId: z.uuid() })

const REASSIGN_ERRORS = {
  not_found: [404, 'Conversation not found.'],
  invalid_status: [409, 'Conversation cannot be reassigned in its current status.'],
  agent_not_found: [404, 'Target agent is not an active member of this workspace.'],
  agent_not_active: [409, 'Target agent is not active.'],
} as const

export const reassignConversationHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const params = ConversationIdParams.safeParse(req.params)
  const body = ReassignBody.safeParse(req.body)
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid, body must be { agentId: uuid }.')
    return
  }
  const result = await reassignConversation(ctx, params.data.id, body.data.agentId)
  if (!result.ok) {
    const [status, message] = REASSIGN_ERRORS[result.reason]
    sendError(res, status, result.reason, message)
    return
  }
  emitInboxChanged(getIo(), ctx.workspaceId, params.data.id, result.status)
  emitMessageToRooms(getIo(), params.data.id, toPlayerView(result.posted), toAgentView(result.posted))
  res.status(200).json({ reassigned: true })
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

const ASK_RESOLVED_ERRORS = {
  not_found: [404, 'Conversation not found.'],
  wrong_status: [
    409,
    'A resolution check can only be asked while the conversation is open, awaiting player, or escalated.',
  ],
  not_owner: [403, 'Another agent owns this conversation.'],
  already_pending: [409, 'A resolution check is already pending on this conversation.'],
} as const

export const askResolvedHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const params = ConversationIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }

  const result = await askResolved(ctx, params.data.id)
  if (!result.ok) {
    const [status, message] = ASK_RESOLVED_ERRORS[result.reason]
    sendError(res, status, result.reason, message)
    return
  }

  // After commit, never inside it. The question is a public system message, so
  // both audiences get it; the phase event is what un-greys the player's banner
  // and greys the agent's button.
  emitMessageToRooms(getIo(), params.data.id, toPlayerView(result.posted), toAgentView(result.posted))
  emitPhaseChanged(getIo(), params.data.id, { conversation_id: params.data.id, confirm_phase: 'agent_ask' })

  res.status(200).json({ asked: true })
}

const ESCALATION_ERRORS = {
  not_found: [404, 'Conversation not found.'],
  wrong_status: [409, 'Escalation can only be toggled from open, awaiting player, or escalated.'],
  not_owner: [403, 'Another agent owns this conversation.'],
} as const

export const escalateConversationHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const params = ConversationIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }

  const result = await escalateConversation(ctx, params.data.id)
  if (!result.ok) {
    const [status, message] = ESCALATION_ERRORS[result.reason]
    sendError(res, status, result.reason, message)
    return
  }

  // After commit, never inside it. escalateConversation always posts a notice on this path
  // (unlike unescalate, which posts nothing), so result.posted is never null here.
  if (result.posted) {
    emitMessageToRooms(getIo(), params.data.id, toPlayerView(result.posted), toAgentView(result.posted))
  }
  emitInboxChanged(getIo(), ctx.workspaceId, params.data.id, 'escalated')
  res.status(200).json({ escalated: true })
}

export const unescalateConversationHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const params = ConversationIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }

  const result = await unescalateConversation(ctx, params.data.id)
  if (!result.ok) {
    const [status, message] = ESCALATION_ERRORS[result.reason]
    sendError(res, status, result.reason, message)
    return
  }

  emitInboxChanged(getIo(), ctx.workspaceId, params.data.id, 'open')
  res.status(200).json({ unescalated: true })
}

export const getConversationDetailHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const params = ConversationIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }
  const detail = await getConversationDetail(ctx, params.data.id)
  if (!detail) {
    sendError(res, 404, 'not_found', 'Conversation not found.')
    return
  }
  res.status(200).json(detail)
}

export const getConversationContextHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const params = ConversationIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }
  const context = await getConversationContext(ctx, params.data.id)
  if (!context) {
    sendError(res, 404, 'not_found', 'Conversation not found.')
    return
  }
  res.status(200).json(context)
}
