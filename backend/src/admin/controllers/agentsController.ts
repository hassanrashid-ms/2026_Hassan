import type { RequestHandler } from 'express'
import { z } from 'zod'
import { sendError } from '../../errors.ts'
import { LastSuperAdmin, listAgents, SelfDemotion, setAdminFlag, setSuperAdminFlag } from '../services/agentsService.ts'

export const listAgentsHandler: RequestHandler = async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q : undefined
  const agents = await listAgents(query)
  res.status(200).json({ agents })
}

export const setAdminHandler: RequestHandler = async (req, res) => {
  const body = z.object({ is_admin: z.boolean() }).safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'is_admin is missing or malformed.')
    return
  }
  try {
    const updated = await setAdminFlag({
      targetAgentId: req.params.id!,
      callerAgentId: req.agent!.agentId,
      isAdmin: body.data.is_admin,
    })
    res.status(200).json(updated)
  } catch (error) {
    if (error instanceof SelfDemotion) {
      sendError(res, 422, 'invalid_value', 'A super admin cannot revoke their own admin access.')
      return
    }
    throw error
  }
}

export const setSuperAdminHandler: RequestHandler = async (req, res) => {
  const body = z.object({ is_super_admin: z.boolean() }).safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'is_super_admin is missing or malformed.')
    return
  }
  try {
    const updated = await setSuperAdminFlag({
      targetAgentId: req.params.id!,
      callerAgentId: req.agent!.agentId,
      isSuperAdmin: body.data.is_super_admin,
    })
    res.status(200).json(updated)
  } catch (error) {
    if (error instanceof SelfDemotion) {
      sendError(res, 422, 'invalid_value', 'A super admin cannot revoke their own super admin access.')
      return
    }
    if (error instanceof LastSuperAdmin) {
      sendError(res, 422, 'invalid_value', 'Cannot remove the last super admin.')
      return
    }
    throw error
  }
}
