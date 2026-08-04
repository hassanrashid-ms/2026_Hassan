import type { RequestHandler } from 'express'
import { and, eq, isNull } from 'drizzle-orm'
import { SessionEndBody } from '@support/types'
import { sendError } from '../errors.ts'
import { appendEvent } from '../events/appendEvent.ts'
import { session } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'
import { headerPayload } from './headers.ts'

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

  const body = parsed.data
  const now = new Date()

  await withWorkspace(player.workspaceId, async (tx) => {
    // The predicate carries the whole guard: RLS scopes it to the workspace,
    // player_id scopes it to this player, and `ended_at IS NULL` makes a redelivery
    // a no-op instead of moving the timestamp. Zero rows back means there is nothing
    // to do — unknown session, someone else's session, or already ended.
    const [ended] = await tx
      .update(session)
      .set({ endedAt: now, endedBy: 'client' })
      .where(
        and(
          eq(session.id, body.session_id),
          eq(session.playerId, player.playerId),
          isNull(session.endedAt),
        ),
      )
      .returning({ id: session.id, startedAt: session.startedAt })

    if (!ended) return

    await appendEvent(tx, {
      workspaceId: player.workspaceId,
      type: 'session_end',
      sessionId: ended.id,
      actorId: player.playerId,
      actorType: 'player',
      occurredAt: now,
      payload: {
        ended_by: 'client',
        // Derived is what reporting reads.
        duration_ms_derived: now.getTime() - ended.startedAt.getTime(),
        // Reported is recorded for cross-checking a suspected bug, never aggregated.
        // articles_read is a client-side echo of the article_read events the web
        // surface writes; having both is how a silently dead bridge is detected.
        duration_ms_reported: body.duration_ms,
        conversation_created_reported: body.conversation_created,
        articles_read_reported: body.articles_read,
        ...headerPayload(player),
      },
    })
  })

  res.status(200).json({ ok: true })
}
