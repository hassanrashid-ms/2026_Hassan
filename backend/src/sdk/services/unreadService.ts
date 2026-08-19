import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { conversation, message } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'

/**
 * Derived, never stored. Polled coarsely by the SDK — on foreground/resume only,
 * never per frame.
 *
 * Push is best effort; this is the guaranteed path. No requirement may depend on
 * push alone, which is why the poll exists at all.
 */
export async function getUnreadCount(player: PlayerContext): Promise<number> {
  return withWorkspace(player.workspaceId, async (tx) => {
    // Scoped to the *latest* conversation, not every conversation this player
    // has ever had. Once "open a new ticket" leaves closed tickets in history,
    // a player_id-wide count would keep summing unread agent messages from
    // threads the player deliberately ended. Same "latest by created_at" rule
    // sendPlayerMessage and getPlayerMessages use, so the badge and the thread
    // can never disagree about which conversation they mean.
    const [current] = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.playerId, player.playerId))
      .orderBy(desc(conversation.createdAt))
      .limit(1)
    if (!current) return 0

    const [row] = await tx
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
    return row?.count ?? 0
  })
}
