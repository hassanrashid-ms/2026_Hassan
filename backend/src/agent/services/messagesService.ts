import { and, eq, lte, ne } from 'drizzle-orm'
import type { z } from 'zod'
import { MarkAgentReadBody, SendAgentMessageBody, type AgentMessageView } from '@support/types'
import { postMessage, toAgentView, toPlayerView } from '../../domain/conversations/index.ts'
import { conversation, message } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import { emitMessageToRooms } from '../../shared/realtime/emit.ts'
import { getIo } from '../../shared/realtime/socketServer.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'

export type SendAgentMessageResult =
  | { outcome: 'ok'; message: AgentMessageView }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }

export async function sendAgentMessage(
  ctx: AgentContext,
  body: z.infer<typeof SendAgentMessageBody>,
): Promise<SendAgentMessageResult> {
  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx
      .select({ id: conversation.id, assignedAgentId: conversation.assignedAgentId })
      .from(conversation)
      .where(eq(conversation.id, body.conversation_id))
      .limit(1)

    if (!found) return { outcome: 'not_found' } as const
    if (found.assignedAgentId !== ctx.agentId) return { outcome: 'forbidden' } as const

    const posted = await postMessage(tx, {
      workspaceId: ctx.workspaceId,
      conversationId: found.id,
      authorType: 'agent',
      actorId: ctx.agentId,
      authorAgentId: ctx.agentId,
      body: body.body,
    })
    return { outcome: 'ok', posted } as const
  })

  if (result.outcome !== 'ok') return result

  const agentView = toAgentView(result.posted)
  const playerView = toPlayerView(result.posted)
  emitMessageToRooms(getIo(), body.conversation_id, playerView, agentView)
  return { outcome: 'ok', message: agentView }
}

export async function markAgentMessagesRead(
  ctx: AgentContext,
  body: z.infer<typeof MarkAgentReadBody>,
): Promise<boolean> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx.select({ id: conversation.id }).from(conversation).where(eq(conversation.id, body.conversation_id)).limit(1)
    if (!found) return false

    await tx
      .update(message)
      .set({ deliveryState: 'read' })
      .where(
        and(
          eq(message.conversationId, found.id),
          eq(message.authorType, 'player'),
          ne(message.deliveryState, 'read'),
          lte(message.seq, body.up_to_seq),
        ),
      )
    return true
  })
}
