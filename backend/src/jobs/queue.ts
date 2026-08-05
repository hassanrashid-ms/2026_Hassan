import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'
import { getEnv } from '../env.ts'
import { closeStaleSessions } from './sessionTimeout.ts'

const QUEUE_NAME = 'support-jobs'
const SESSION_TIMEOUT_JOB = 'session-timeout'

/**
 * BullMQ requires maxRetriesPerRequest: null on the connection a Worker uses.
 */
function connection(): IORedis {
  return new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null })
}

/**
 * One repeatable job every five minutes. A stable jobId means restarting the process
 * re-uses the same schedule rather than stacking a second one.
 */
export async function registerJobs(): Promise<{ close: () => Promise<void> }> {
  const queueConnection = connection()
  const workerConnection = connection()

  const queue = new Queue(QUEUE_NAME, { connection: queueConnection })
  await queue.upsertJobScheduler(
    SESSION_TIMEOUT_JOB,
    { pattern: '*/5 * * * *' },
    { name: SESSION_TIMEOUT_JOB, opts: { removeOnComplete: 50, removeOnFail: 100 } },
  )

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name !== SESSION_TIMEOUT_JOB) return
      const closed = await closeStaleSessions()
      if (closed > 0) console.log(`[jobs] closed ${closed} stale session(s)`)
    },
    { connection: workerConnection, concurrency: 1 },
  )

  worker.on('failed', (job, error) => {
    // Failure is never silent. Until real alerting exists, this log is the alert.
    console.error(`[jobs] ${job?.name ?? 'unknown'} failed:`, error.name, error.message)
  })

  return {
    close: async () => {
      await worker.close()
      await queue.close()
      queueConnection.disconnect()
      workerConnection.disconnect()
    },
  }
}
