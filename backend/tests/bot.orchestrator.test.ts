import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { conversation, event, message } from '../src/shared/db/schema/index.ts'
import { runBotTurn } from '../src/domain/bot/orchestrator.ts'
import type { BotTurnDecision, BotTurnInput } from '../src/domain/bot/botTurn.ts'
import { closeOwnerPool, seedConversation, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

describe('runBotTurn', () => {
  it('re-reads status and no-ops when the conversation left bot_active before the job ran', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })
    await withWorkspace(workspaceId, (tx) =>
      tx.update(conversation).set({ status: 'open' }).where(eq(conversation.id, conversationId)),
    )

    let deciderCalled = false
    const decider = async (_input: BotTurnInput): Promise<BotTurnDecision> => {
      deciderCalled = true
      return { kind: 'noop' }
    }

    await runBotTurn(workspaceId, conversationId, decider)

    expect(deciderCalled).toBe(false)
    const rows = await withWorkspace(workspaceId, (tx) => tx.select().from(message).where(eq(message.conversationId, conversationId)))
    expect(rows).toHaveLength(0)
    const events = await withWorkspace(workspaceId, (tx) => tx.select().from(event))
    expect(events).toHaveLength(0)
  })

  it('gathers subintent_id and public history, passes them to the decider, and applies + emits the result', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })

    let seenInput: BotTurnInput | null = null
    const decider = async (input: BotTurnInput): Promise<BotTurnDecision> => {
      seenInput = input
      return { kind: 'unavailable', reason: 'error' }
    }

    await runBotTurn(workspaceId, conversationId, decider)

    expect(seenInput).not.toBeNull()
    expect(seenInput!.workspaceId).toBe(workspaceId)
    expect(seenInput!.conversationId).toBe(conversationId)
    expect(seenInput!.subintentId).toBeNull()
    expect(seenInput!.confirmPhase).toBe('none')
    expect(seenInput!.botMessageCount).toBe(0)
    expect(seenInput!.lastPlayerMessageAt).toBeNull()
    expect(seenInput!.history).toEqual([])

    const rows = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    )
    expect(rows[0]!.status).toBe('open')

    const events = await withWorkspace(workspaceId, (tx) => tx.select().from(event).where(eq(event.type, 'bot_unavailable')))
    expect(events).toHaveLength(1)
  })

  it('filters internal messages out of the history handed to the decider', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })
    const { seedMessage } = await import('./helpers/db.ts')
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player', visibility: 'public', body: 'hello' })
    await seedMessage({ workspaceId, conversationId, seq: 2, authorType: 'agent', visibility: 'internal', body: 'secret note' })

    let seenInput: BotTurnInput | null = null
    const decider = async (input: BotTurnInput): Promise<BotTurnDecision> => {
      seenInput = input
      return { kind: 'noop' }
    }

    await runBotTurn(workspaceId, conversationId, decider)

    expect(seenInput!.history.map((m) => m.body)).toEqual(['hello'])
  })

  it('propagates a throw from the decider without applying anything', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })

    const decider = async (): Promise<BotTurnDecision> => {
      throw new Error('decider blew up')
    }

    await expect(runBotTurn(workspaceId, conversationId, decider)).rejects.toThrow('decider blew up')

    const rows = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    )
    expect(rows[0]!.status).toBe('bot_active')
  })

  it('does not apply the decision when the conversation left bot_active while the decider was running', async () => {
    // Reproduces the race the atomic guard exists for: the cheap pre-decide
    // check in runBotTurn passes (status is still bot_active when gather()
    // runs), but an agent claims the conversation in its own committed
    // transaction *during* the decider call, before runBotTurn applies the
    // decision. The apply must re-read status and no-op instead of trusting
    // the stale read from gather().
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })

    const decider = async (): Promise<BotTurnDecision> => {
      await withWorkspace(workspaceId, (tx) =>
        tx.update(conversation).set({ status: 'open' }).where(eq(conversation.id, conversationId)),
      )
      return { kind: 'unavailable', reason: 'error' }
    }

    await runBotTurn(workspaceId, conversationId, decider)

    const rows = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    )
    expect(rows[0]!.status).toBe('open')

    const messages = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(message).where(eq(message.conversationId, conversationId)),
    )
    expect(messages).toHaveLength(0)

    const events = await withWorkspace(workspaceId, (tx) => tx.select().from(event))
    expect(events).toHaveLength(0)
  })
})
