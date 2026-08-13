import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'
import { getEnv } from '../../env.ts'
import { logger } from '../logging/logger.ts'
import { applyDecisionIfBotActive, runBotTurn } from '../../domain/bot/orchestrator.ts'
import { toolLoopDecider } from '../../domain/bot/toolLoop.ts'
import type { BotDecider } from '../../domain/bot/botTurn.ts'

const QUEUE_NAME = 'bot-turns'

type BotTurnJobData = { workspaceId: string; conversationId: string; seq: number }

function connection(): IORedis {
  return new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null })
}

let queueConnection: IORedis | undefined
let queue: Queue<BotTurnJobData> | undefined

function getQueue(): Queue<BotTurnJobData> {
  if (!queue) {
    queueConnection = connection()
    queue = new Queue<BotTurnJobData>(QUEUE_NAME, { connection: queueConnection })
  }
  return queue
}

/**
 * Enqueued after sendPlayerMessage's transaction commits — never inside it, so a
 * rolled-back message can never spawn a turn. Failure here is logged and
 * swallowed: the player's message already committed, and throwing would fail a
 * request that succeeded (spec §10).
 */
export async function enqueueBotTurn(input: BotTurnJobData): Promise<void> {
  try {
    await getQueue().add('bot-turn', input, {
      // BullMQ 5.x rejects custom job ids containing ':' (`Custom Id cannot
      // contain :`), so the conversationId:seq dedup key uses '__' as its
      // separator instead — same dedup semantics, different delimiter.
      jobId: `${input.conversationId}__${input.seq}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    })
  } catch (error) {
    const err = error as Error
    logger.error('jobs', `enqueueBotTurn failed: ${err.name} ${err.message}`)
  }
}

/**
 * `decider` defaults to `toolLoopDecider` for production use; tests inject their own
 * to exercise retry and fallback behaviour without a real model.
 */
export function registerBotTurnWorker(decider: BotDecider = toolLoopDecider): { close: () => Promise<void> } {
  const workerConnection = connection()

  const worker = new Worker<BotTurnJobData>(
    QUEUE_NAME,
    async (job) => {
      await runBotTurn(job.data.workspaceId, job.data.conversationId, decider)
    },
    { connection: workerConnection, concurrency: 5 },
  )

  worker.on('failed', (job, error) => {
    logger.error('jobs', `bot-turn failed: ${error.name} ${error.message}`)
    if (!job) return
    const attempts = job.opts.attempts ?? 1
    if (job.attemptsMade < attempts) return
    // Last attempt exhausted: the fallback must not itself depend on the thing
    // that just failed, so this calls applyDecisionIfBotActive directly rather
    // than going through the decider again. That guard re-reads status atomically
    // with the apply, so an agent claiming or replying in the gap between this
    // last attempt and this handler running is not overridden by a forced
    // handoff — see orchestrator.ts.
    void applyDecisionIfBotActive(job.data.workspaceId, job.data.conversationId, { kind: 'unavailable', reason: 'error' }).catch(
      (fallbackError: Error) => {
        logger.error('jobs', `bot-turn error fallback failed: ${fallbackError.name} ${fallbackError.message}`)
      },
    )
  })

  return {
    close: async () => {
      await worker.close()
      // Guard: only close the queue/connection if one was actually created by an
      // enqueueBotTurn call. Calling getQueue() here would lazily create a queue
      // (and a Redis connection) just to immediately close it.
      if (queue) {
        await queue.close()
        queueConnection?.disconnect()
        queue = undefined
        queueConnection = undefined
      }
      workerConnection.disconnect()
    },
  }
}
