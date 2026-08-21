import type { RequestHandler } from 'express'
import { listWorkspaceAgents } from '../services/agentsService.ts'

export const listAgentsHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const agents = await listWorkspaceAgents(ctx.workspaceId)
  res.status(200).json({ agents })
}
