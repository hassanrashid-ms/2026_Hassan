import type { RequestHandler } from 'express'
import { and, eq } from 'drizzle-orm'
import { IncidentBody } from '@support/types'
import { appendEvent } from '../events/appendEvent.ts'
import { session } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'
import { headerPayload } from './headers.ts'

/**
 * Always 200 if the body parses. An incident report that itself errors is worse than
 * useless, so every field has a fallback and none of them can fail the request.
 *
 * Lands in `event` rather than a table of its own: volume is low, and it inherits
 * workspace scoping, the BRIN index and append-only enforcement for free.
 */
export const incidents: RequestHandler = async (req, res) => {
  const player = req.player!

  // .catch() on every field means this cannot fail for a body that parsed as JSON.
  const body = IncidentBody.parse(req.body ?? {})

  await withWorkspace(player.workspaceId, async (tx) => {
    // A foreign-key check runs as the referenced table's owner and ignores RLS, so an
    // unverified session_id would be accepted and would point across the tenant
    // boundary. Confirm it is this player's, or keep it in the payload only.
    let sessionId: string | null = null
    if (body.session_id) {
      const [owned] = await tx
        .select({ id: session.id })
        .from(session)
        .where(and(eq(session.id, body.session_id), eq(session.playerId, player.playerId)))
        .limit(1)
      sessionId = owned?.id ?? null
    }

    await appendEvent(tx, {
      workspaceId: player.workspaceId,
      type: 'sdk_incident',
      sessionId,
      actorType: 'system',
      payload: {
        kind: body.kind,
        detail: body.detail,
        sdk_version: body.sdk_version,
        client_version: body.client_version,
        incident_id: body.incident_id,
        ...(body.session_id && !sessionId ? { unresolved_session_id: body.session_id } : {}),
        ...headerPayload(player),
      },
    })
  })

  res.status(200).json({ ok: true })
}
