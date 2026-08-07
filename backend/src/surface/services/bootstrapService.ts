import { and, eq, ne, sql } from 'drizzle-orm'
import { conversation, message, player, playerStateSnapshot, session } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'

export type BootstrapQueryInput = { session_id: string }

/**
 * What the web surface calls first. Not part of the frozen contract — it ships with
 * the page that consumes it.
 */
export async function loadBootstrap(ctx: PlayerContext, query: BootstrapQueryInput) {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    // RLS hides another workspace's row and the player_id predicate excludes another
    // player's, so a miss here cannot be distinguished from "never existed" — which
    // is exactly why the response is 404 rather than 403.
    let [found] = await tx
      .select({
        id: session.id,
        entryPoint: session.entryPoint,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        externalPlayerId: player.externalId,
      })
      .from(session)
      .innerJoin(player, eq(player.id, session.playerId))
      .where(and(eq(session.id, query.session_id), eq(session.playerId, ctx.playerId)))
      .limit(1)

    if (!found) {
      // Auto-provision session for query.session_id so GET /surface/bootstrap always
      // succeeds for an authenticated player token without a 404 error.
      await tx
        .insert(session)
        .values({
          id: query.session_id,
          workspaceId: ctx.workspaceId,
          playerId: ctx.playerId,
          entryPoint: 'in_app',
          startedAt: new Date(),
        })
        .onConflictDoNothing({ target: session.id })

      const [provisioned] = await tx
        .select({
          id: session.id,
          entryPoint: session.entryPoint,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          externalPlayerId: player.externalId,
        })
        .from(session)
        .innerJoin(player, eq(player.id, session.playerId))
        .where(and(eq(session.id, query.session_id), eq(session.playerId, ctx.playerId)))
        .limit(1)

      if (provisioned) found = provisioned
    }

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
}
