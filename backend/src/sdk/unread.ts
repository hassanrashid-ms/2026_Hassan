import type { RequestHandler } from 'express'
import { and, eq, ne, sql } from 'drizzle-orm'
import type { UnreadResponse } from '@support/types'
import { conversation, message } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'

/**
 * Derived, never stored. Polled coarsely by the SDK — on foreground/resume only,
 * never per frame.
 *
 * Push is best effort; this is the guaranteed path. No requirement may depend on
 * push alone, which is why the poll exists at all.
 */
export const unread: RequestHandler = async (req, res) => {
  const player = req.player!

  const count = await withWorkspace(player.workspaceId, async (tx) => {
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

  const payload: UnreadResponse = { unread_count: count }
  res.status(200).json(payload)
}
