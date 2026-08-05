import type { RequestHandler } from 'express'
import { and, eq, ne, sql } from 'drizzle-orm'
import {
  BootstrapQuery,
  type BootstrapResponse,
  type PlayerStateAvailability,
} from '@support/types'
import { getEnv } from '../env.ts'
import { sendError } from '../errors.ts'
import { conversation, message, player, playerStateSnapshot, session } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'

/**
 * What the web surface calls first. Not part of the frozen contract — it ships with
 * the page that consumes it.
 */
export const bootstrap: RequestHandler = async (req, res) => {
  const ctx = req.player!

  const query = BootstrapQuery.safeParse(req.query)
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'session_id must be a uuid.')
    return
  }

  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    // RLS hides another workspace's row and the player_id predicate excludes another
    // player's, so a miss here cannot be distinguished from "never existed" — which
    // is exactly why the response is 404 rather than 403.
    const [found] = await tx
      .select({
        id: session.id,
        entryPoint: session.entryPoint,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        externalPlayerId: player.externalId,
      })
      .from(session)
      .innerJoin(player, eq(player.id, session.playerId))
      .where(and(eq(session.id, query.data.session_id), eq(session.playerId, ctx.playerId)))
      .limit(1)

    if (!found) return null

    const [snapshot] = await tx
      .select()
      .from(playerStateSnapshot)
      .where(eq(playerStateSnapshot.sessionId, found.id))
      .limit(1)

    const [unread] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(message)
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .where(
        and(
          eq(conversation.playerId, ctx.playerId),
          eq(message.visibility, 'public'),
          ne(message.authorType, 'player'),
          ne(message.deliveryState, 'read'),
        ),
      )

    return { found, snapshot, unreadCount: unread?.count ?? 0 }
  })

  if (!result) {
    sendError(res, 404, 'not_found', 'Session not found.')
    return
  }

  const { found, snapshot, unreadCount } = result

  // Three distinct no-data states, all rendered "unavailable" but diagnosed
  // differently. All three are states, never errors.
  const availability: PlayerStateAvailability = !snapshot
    ? 'absent'
    : snapshot.isMissing
      ? 'missing'
      : snapshot.degradedReason
        ? 'degraded'
        : 'ok'

  const payload: BootstrapResponse = {
    session: {
      id: found.id,
      entry_point: found.entryPoint,
      started_at: found.startedAt.toISOString(),
      ended_at: found.endedAt?.toISOString() ?? null,
    },
    player: { external_player_id: found.externalPlayerId },
    player_state: {
      availability,
      captured_at: snapshot?.capturedAt.toISOString() ?? null,
      degraded_reason: snapshot?.degradedReason ?? null,
      declared: snapshot?.declared ?? {},
      // `raw` is the player's own data, but it is also PII by default and the real
      // surface has no use for it — the agent Game View is what reads it. It is
      // exposed outside production only, because proving the split is the whole
      // point of the stub. Remove this branch when the real chat UI lands.
      ...(getEnv().NODE_ENV === 'production' ? {} : { raw: snapshot?.raw ?? {} }),
    },
    unread_count: unreadCount,
  }

  res.status(200).json(payload)
}
