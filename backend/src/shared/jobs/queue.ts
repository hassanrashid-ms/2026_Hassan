import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { getEnv } from '../../env.ts';
import { logger } from '../logging/logger.ts';
import { closeStaleSessions } from './sessionTimeout.ts';
import { sweepAbandonedForms } from './formTimeout.ts';
import { registerBotTurnWorker } from './botTurns.ts';
import { INACTIVITY_CLOCK_JOB, runInactivityClock } from './inactivityClock.ts';
import { AUTO_CLOSE_JOB, runAutoClose } from './autoClose.ts';
import { LEAVE_EXPIRY_JOB, runLeaveExpiry } from './leaveExpiry.ts';

const QUEUE_NAME = 'support-jobs';
const SESSION_TIMEOUT_JOB = 'session-timeout';
const FORM_TIMEOUT_JOB = 'form-timeout';

/**
 * BullMQ requires maxRetriesPerRequest: null on the connection a Worker uses.
 */
function connection(): IORedis {
  return new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
}

/**
 * One repeatable job every five minutes. A stable jobId means restarting the process
 * re-uses the same schedule rather than stacking a second one.
 */
export async function registerJobs(): Promise<{ close: () => Promise<void> }> {
  const queueConnection = connection();
  const workerConnection = connection();

  const queue = new Queue(QUEUE_NAME, { connection: queueConnection });
  await queue.upsertJobScheduler(
    SESSION_TIMEOUT_JOB,
    { pattern: '*/5 * * * *' },
    { name: SESSION_TIMEOUT_JOB, opts: { removeOnComplete: 50, removeOnFail: 100 } },
  );

  // Same five-minute cadence and the same stable-jobId rule: restarting the
  // process re-uses this schedule rather than stacking a second one.
  await queue.upsertJobScheduler(
    FORM_TIMEOUT_JOB,
    { pattern: '*/5 * * * *' },
    { name: FORM_TIMEOUT_JOB, opts: { removeOnComplete: 50, removeOnFail: 100 } },
  );

  // Same five-minute cadence and stable-jobId rule as the two above. Five
  // minutes is granular enough for a 24-hour window and cheap enough to run on
  // an empty queue.
  await queue.upsertJobScheduler(
    INACTIVITY_CLOCK_JOB,
    { pattern: '*/5 * * * *' },
    { name: INACTIVITY_CLOCK_JOB, opts: { removeOnComplete: 50, removeOnFail: 100 } },
  );

  await queue.upsertJobScheduler(
    AUTO_CLOSE_JOB,
    { pattern: '*/5 * * * *' },
    { name: AUTO_CLOSE_JOB, opts: { removeOnComplete: 50, removeOnFail: 100 } },
  );

  // Same cadence and stable-jobId rule as the others. Five minutes is
  // granular enough for a return date measured in days.
  await queue.upsertJobScheduler(
    LEAVE_EXPIRY_JOB,
    { pattern: '*/5 * * * *' },
    { name: LEAVE_EXPIRY_JOB, opts: { removeOnComplete: 50, removeOnFail: 100 } },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === SESSION_TIMEOUT_JOB) {
        const closed = await closeStaleSessions();
        if (closed > 0) logger.info('jobs', `closed ${closed} stale session(s)`);
        return;
      }
      if (job.name === FORM_TIMEOUT_JOB) {
        const terminated = await sweepAbandonedForms();
        if (terminated > 0) logger.info('jobs', `terminated ${terminated} abandoned form(s)`);
        return;
      }
      if (job.name === INACTIVITY_CLOCK_JOB) {
        const { asked, timedOut } = await runInactivityClock();
        if (asked > 0 || timedOut > 0) {
          logger.info('jobs', `inactivity clock asked ${asked}, timed out ${timedOut}`);
        }
        return;
      }
      if (job.name === AUTO_CLOSE_JOB) {
        const closed = await runAutoClose();
        if (closed > 0) logger.info('jobs', `auto-closed ${closed} conversation(s)`);
        return;
      }
      if (job.name === LEAVE_EXPIRY_JOB) {
        await runLeaveExpiry();
      }
    },
    { connection: workerConnection, concurrency: 1 },
  );

  worker.on('failed', (job, error) => {
    // Failure is never silent. Until real alerting exists, this log is the alert.
    logger.error('jobs', `${job?.name ?? 'unknown'} failed: ${error.name} ${error.message}`);
  });

  const botTurns = registerBotTurnWorker();

  return {
    close: async () => {
      await worker.close();
      await queue.close();
      queueConnection.disconnect();
      workerConnection.disconnect();
      await botTurns.close();
    },
  };
}
