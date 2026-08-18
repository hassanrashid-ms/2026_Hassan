import { createServer } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { conversation, resolutionCycle } from '../src/shared/db/schema/index.ts'
import { sendPlayerMessage } from '../src/surface/services/messagesService.ts'
import { openNewTicket } from '../src/surface/services/newTicketService.ts'
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts'
import { closeOwnerPool, seedAgent, seedPlayer, seedWorkspace, seedWorkspaceMember, truncateAll } from './helpers/db.ts'

beforeAll(() => {
  createSocketServer(createServer())
})

afterAll(async () => {
  await closeSocketServer()
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

const cyclesFor = (workspaceId: string, conversationId: string) =>
  withWorkspace(workspaceId, async (tx) =>
    tx
      .select()
      .from(resolutionCycle)
      .where(eq(resolutionCycle.conversationId, conversationId))
      .orderBy(desc(resolutionCycle.cycleNo)),
  )

describe('resolution cycles on the surface ticket paths', () => {
  it('opens cycle 1 when a player starts their first conversation', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId)

    const { conversation_id } = await sendPlayerMessage(
      { workspaceId, playerId } as never,
      { body: 'my gems vanished' },
    )

    const rows = await cyclesFor(workspaceId, conversation_id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cycleNo).toBe(1)
    // bot_active: the clock does not run under the bot.
    expect(rows[0]!.inactivityDueAt).toBeNull()
    expect(rows[0]!.resolvedAt).toBeNull()
  })

  it('opens cycle 2 on reopen, with the clock already running', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId)
    const { conversation_id } = await sendPlayerMessage({ workspaceId, playerId } as never, { body: 'first' })

    await withWorkspace(workspaceId, async (tx) => {
      await tx
        .update(conversation)
        .set({ status: 'resolved', resolutionSource: 'bot' })
        .where(eq(conversation.id, conversation_id))
      await tx
        .update(resolutionCycle)
        .set({ resolvedAt: new Date(), resolutionKind: 'bot' })
        .where(eq(resolutionCycle.conversationId, conversation_id))
    })

    await sendPlayerMessage({ workspaceId, playerId } as never, { body: 'it came back' })

    const rows = await cyclesFor(workspaceId, conversation_id)
    expect(rows.map((r) => r.cycleNo)).toEqual([2, 1])
    // The player's own message ran through postMessage while status was `open`.
    expect(rows[0]!.inactivityDueAt).not.toBeNull()
  })

  it('keeps the previous owner when the last resolution was player_confirmed or timed_out', async () => {
    for (const source of ['player_confirmed', 'timed_out'] as const) {
      await truncateAll()
      const workspaceId = await seedWorkspace({ slug: `ws-${source}` })
      const agentId = await seedAgent()
      await seedWorkspaceMember({ workspaceId, agentId })
      const playerId = await seedPlayer(workspaceId)
      const { conversation_id } = await sendPlayerMessage({ workspaceId, playerId } as never, { body: 'first' })

      await withWorkspace(workspaceId, async (tx) => {
        await tx
          .update(conversation)
          .set({ status: 'resolved', resolutionSource: source, assignedAgentId: agentId })
          .where(eq(conversation.id, conversation_id))
        await tx
          .update(resolutionCycle)
          .set({ resolvedAt: new Date(), resolutionKind: source })
          .where(eq(resolutionCycle.conversationId, conversation_id))
      })

      await sendPlayerMessage({ workspaceId, playerId } as never, { body: 'again' })

      const [row] = await withWorkspace(workspaceId, (tx) =>
        tx.select().from(conversation).where(eq(conversation.id, conversation_id)),
      )
      expect(row!.assignedAgentId, source).toBe(agentId)
    }
  })

  it('stamps closed_at on the old cycle and opens cycle 1 on the replacement ticket', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId)
    const { conversation_id: oldId } = await sendPlayerMessage({ workspaceId, playerId } as never, { body: 'first' })
    await withWorkspace(workspaceId, (tx) =>
      tx.update(conversation).set({ status: 'resolved' }).where(eq(conversation.id, oldId)),
    )

    const result = await openNewTicket({ workspaceId, playerId } as never, {})
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect((await cyclesFor(workspaceId, oldId))[0]!.closedAt).not.toBeNull()
    const fresh = await cyclesFor(workspaceId, result.conversationId)
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.cycleNo).toBe(1)
  })
})
