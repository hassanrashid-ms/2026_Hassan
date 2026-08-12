import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { conversation, event, message } from '../src/shared/db/schema/index.ts'
import { enqueueBotTurn, registerBotTurnWorker } from '../src/shared/jobs/botTurns.ts'
import { registerJobs } from '../src/shared/jobs/queue.ts'
import { getEnv } from '../src/env.ts'
import type { BotDecider, BotTurnDecision } from '../src/domain/bot/botTurn.ts'
import { closeOwnerPool, seedConversation, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

// Matches SESSION_TIMEOUT_JOB / QUEUE_NAME in ../src/shared/jobs/queue.ts. registerJobs()
// upserts this repeatable job scheduler against real Redis; a test that calls
// registerJobs() must remove it afterwards so it doesn't leak into
// jobs.sessionTimeout.test.ts or any other run against the same Redis instance.
const SUPPORT_JOBS_QUEUE_NAME = 'support-jobs'
const SESSION_TIMEOUT_JOB = 'session-timeout'

async function removeSessionTimeoutScheduler(): Promise<void> {
  const connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null })
  const queue = new Queue(SUPPORT_JOBS_QUEUE_NAME, { connection })
  await queue.removeJobScheduler(SESSION_TIMEOUT_JOB)
  await queue.close()
  connection.disconnect()
}

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

  it('registerJobs() registers a live bot-turns worker and its single close() stops it too', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })

    const jobs = await registerJobs()
    try {
      // Proves registerBotTurnWorker() is actually wired in: with no decider
      // override, registerJobs()'s bot-turns worker runs the default
      // stubDecider, which always resolves bot_unavailable(not_implemented).
      await enqueueBotTurn({ workspaceId, conversationId, seq: 1 })

      await waitFor(async () => {
        const events = await withWorkspace(workspaceId, (tx) =>
          tx.select().from(event).where(eq(event.type, 'bot_unavailable')),
        )
        return events.length === 1
      })

      const events = await withWorkspace(workspaceId, (tx) =>
        tx.select().from(event).where(eq(event.type, 'bot_unavailable')),
      )
      expect(events[0]!.payload).toMatchObject({ reason: 'not_implemented' })
    } finally {
      await jobs.close()
    }

    // The single close() awaited above must have stopped the bot-turns worker
    // alongside support-jobs. Enqueue one more turn for a fresh conversation and
    // prove, with a bounded wait, that nothing picks it up.
    const conversationId2 = await seedConversation({ workspaceId, playerId })
    await enqueueBotTurn({ workspaceId, conversationId: conversationId2, seq: 1 })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const eventsAfterClose = await withWorkspace(workspaceId, (tx) =>
      tx
        .select()
        .from(event)
        .where(and(eq(event.type, 'bot_unavailable'), eq(event.conversationId, conversationId2))),
    )
    expect(eventsAfterClose).toHaveLength(0)

    // Cleanup: drain the still-queued job (registered against real Redis, so it
    // would otherwise run the moment any later test starts a bot-turns worker)
    // and remove the session-timeout scheduler registerJobs() upserted, so this
    // test leaves no repeatable job or pending job behind for
    // jobs.sessionTimeout.test.ts or any later run.
    let drained = false
    const drainingWorker = registerBotTurnWorker(async () => {
      drained = true
      return { kind: 'noop' }
    })
    await waitFor(async () => drained)
    await drainingWorker.close()
    await removeSessionTimeoutScheduler()
  })
})
