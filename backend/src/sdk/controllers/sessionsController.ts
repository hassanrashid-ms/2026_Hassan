import type { RequestHandler } from 'express'
import { SessionEndBody, SessionStartBody } from '@support/types'
import { sendError } from '../../errors.ts'
import { endSession, startSession } from '../services/sessionsService.ts'

/**
 * Non-blocking on the SDK side, so this can land after the web app has already
 * created a conversation. The snapshot is keyed to session_id and a conversation
 * reaches it through conversation.session_id, so a late arrival simply becomes
 * visible — no repair step, no ordering requirement.
 */
export const sessionsStart: RequestHandler = async (req, res) => {
  const player = req.player!

  console.log('[sdk/sessions/start] ▶ received', {
    session_id: req.body?.session_id,
    player_id:  player.externalPlayerId,
    workspace:  player.workspaceId,
    entry_point: req.body?.entry_point,
    has_snapshot: req.body?.snapshot != null,
  })

  const parsed = SessionStartBody.safeParse(req.body)
  if (!parsed.success) {
    // The only 4xx this endpoint has: without a usable session_id there is no
    // primary key to write against. Everything else about the body is recoverable.
    console.warn('[sdk/sessions/start] ✗ invalid body', parsed.error.flatten())
    sendError(res, 422, 'invalid_request', 'session_id must be a uuid.')
    return
  }

  await startSession(player, parsed.data)
  res.status(200).json({ ok: true })
}

/**
 * If this never arrives the session simply has no ended_at. Two mitigations exist and
 * both are needed: the session-timeout worker closes it as `timeout`, and self-serve
 * rate counts sessions by started_at, never by ended_at — a missing end must never
 * silently shrink the denominator.
 */
export const sessionsEnd: RequestHandler = async (req, res) => {
  const player = req.player!

  const parsed = SessionEndBody.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, 422, 'invalid_request', 'session_id must be a uuid.')
    return
  }

  await endSession(player, parsed.data)
  res.status(200).json({ ok: true })
}
