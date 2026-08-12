import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { conversation, event, message } from '../src/shared/db/schema/index.ts'
import { enqueueBotTurn, registerBotTurnWorker } from '../src/shared/jobs/botTurns.ts'
import type { BotDecider, BotTurnDecision } from '../src/domain/bot/botTurn.ts'
import { closeOwnerPool, seedConversation, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

let activeWorker: { close: () => Promise<void> } | null = null

afterEach(async () => {
  if (activeWorker) {
    await activeWorker.close()
    activeWorker = null
  }
})

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('waitFor timed out')
}

describe('bot-turns queue and worker', () => {
  it('runs a job against the workspace and conversation it was enqueued for', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })

    let seenWorkspaceId = ''
    let seenConversationId = ''
    const decider: BotDecider = async (input) => {
      seenWorkspaceId = input.workspaceId
      seenConversationId = input.conversationId
      return { kind: 'unavailable', reason: 'error' }
    }
    activeWorker = registerBotTurnWorker(decider)

    await enqueueBotTurn({ workspaceId, conversationId, seq: 1 })

    await waitFor(async () => seenConversationId === conversationId)
    expect(seenWorkspaceId).toBe(workspaceId)
  })

  it('retries a throwing decider to the attempt limit, then applies the error fallback exactly once', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })

    let attempts = 0
    const decider: BotDecider = async () => {
      attempts += 1
      throw new Error('decider blew up')
    }
    activeWorker = registerBotTurnWorker(decider)

    await enqueueBotTurn({ workspaceId, conversationId, seq: 1 })

    await waitFor(async () => {
      const events = await withWorkspace(workspaceId, (tx) => tx.select().from(event).where(eq(event.type, 'bot_unavailable')))
      return events.length === 1
    }, 10_000)

    expect(attempts).toBe(2)
    const events = await withWorkspace(workspaceId, (tx) => tx.select().from(event).where(eq(event.type, 'bot_unavailable')))
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({ reason: 'error' })

    const rows = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    )
    expect(rows[0]!.status).toBe('open')
  })

  it('the default worker uses stubDecider, producing bot_unavailable(not_implemented) with no internal note', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })

    activeWorker = registerBotTurnWorker()
    await enqueueBotTurn({ workspaceId, conversationId, seq: 1 })

    await waitFor(async () => {
      const events = await withWorkspace(workspaceId, (tx) => tx.select().from(event).where(eq(event.type, 'bot_unavailable')))
      return events.length === 1
    })

    const events = await withWorkspace(workspaceId, (tx) => tx.select().from(event).where(eq(event.type, 'bot_unavailable')))
    expect(events[0]!.payload).toMatchObject({ reason: 'not_implemented' })

    const rows = await withWorkspace(workspaceId, (tx) => tx.select().from(message).where(eq(message.conversationId, conversationId)))
    expect(rows.filter((r) => r.visibility === 'internal')).toHaveLength(0)
    expect(rows.filter((r) => r.visibility === 'public')).toHaveLength(1)
  })

  it('deduplicates two enqueues of the same conversationId:seq into one job', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })

    let runCount = 0
    const decider: BotDecider = async (): Promise<BotTurnDecision> => {
      runCount += 1
      return { kind: 'unavailable', reason: 'error' }
    }
    activeWorker = registerBotTurnWorker(decider)

    await enqueueBotTurn({ workspaceId, conversationId, seq: 7 })
    await enqueueBotTurn({ workspaceId, conversationId, seq: 7 })

    await waitFor(async () => runCount >= 1)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(runCount).toBe(1)
  })
})
