import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { conversation, message, player, playerStateSnapshot, session, workspace } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'

export type BootstrapQueryInput = { session_id: string }

/**
 * What the web surface calls first. Not part of the frozen contract — it ships with
 * the page that consumes it.
 */
export async function loadBootstrap(ctx: PlayerContext, query: BootstrapQueryInput) {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    // `workspace` is unscoped (no RLS policy), so this is a plain lookup by the
    // already-verified id from the player token — no set_config dependency.
    const [ws] = await tx.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, ctx.workspaceId)).limit(1)

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
      .where(and(eq(session.id, query.session_id), eq(session.playerId, ctx.playerId)))
      .limit(1)

    if (!found) return null

    const [snapshot] = await tx
      .select()
      .from(playerStateSnapshot)
      .where(eq(playerStateSnapshot.sessionId, found.id))
      .limit(1)

    // The player's *latest* conversation, not all of them: closed tickets stay
    // in history once "open a new ticket" ships, and a player_id-wide count
    // would badge the player for messages on a thread they deliberately ended.
    // Mirrors the same scoping in sdk/services/unreadService.ts.
    const [current] = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.playerId, ctx.playerId))
      .orderBy(desc(conversation.createdAt))
      .limit(1)

    const [unread] = current
      ? await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(message)
          .where(
            and(
              eq(message.conversationId, current.id),
              eq(message.visibility, 'public'),
              ne(message.authorType, 'player'),
              ne(message.deliveryState, 'read'),
            ),
          )
      : []

    return { found, snapshot, unreadCount: unread?.count ?? 0, workspaceName: ws?.name ?? '' }
  })
}
