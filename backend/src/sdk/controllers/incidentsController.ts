import type { RequestHandler } from 'express'
import { IncidentBody } from '@support/types'
import { recordIncident } from '../services/incidentsService.ts'

/**
 * Always 200 if the body parses. An incident report that itself errors is worse than
 * useless, so every field has a fallback and none of them can fail the request.
 */
export const incidents: RequestHandler = async (req, res) => {
  const player = req.player!

  // .catch() on every field means this cannot fail for a body that parsed as JSON.
  const body = IncidentBody.parse(req.body ?? {})

  await recordIncident(player, body)

  res.status(200).json({ ok: true })
}
