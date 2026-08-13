import type { RequestHandler } from 'express'
import { ResolutionAnswerBody } from '@support/types'
import { sendError } from '../../errors.ts'
import { answerResolution } from '../services/resolutionService.ts'

const ERRORS = {
  not_found: [404, 'No conversation found for this player.'],
  no_check_pending: [409, 'There is no resolution check to answer.'],
} as const

export const resolutionAnswerHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!
  const body = ResolutionAnswerBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'helped must be a boolean and session_id, if present, a uuid.')
    return
  }

  const result = await answerResolution(ctx, body.data)
  if (!result.ok) {
    const [status, message] = ERRORS[result.reason]
    sendError(res, status, result.reason, message)
    return
  }

  res.status(200).json({ confirm_phase: 'none', status: result.status })
}
