import { and, eq, ne, sql } from 'drizzle-orm'
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
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(message)
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .where(
        and(
          eq(conversation.playerId, player.playerId),
          eq(message.visibility, 'public'),
          ne(message.authorType, 'player'),
          ne(message.deliveryState, 'read'),
        ),
      )
    return row?.count ?? 0
  })
}
