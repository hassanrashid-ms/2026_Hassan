import { and, isNull, lt } from 'drizzle-orm';
import { getEnv } from '../../env.ts';
import { appendEvent } from '../events/appendEvent.ts';
import { session, workspace } from '../db/schema/index.ts';
import { withWorkspace, withoutWorkspace } from '../db/withWorkspace.ts';

export type CloseStaleSessionsOptions = {
  now?: Date;
  timeoutMinutes?: number;
};

/**
 * Closes sessions with no ended_at older than the timeout, marking them
 * ended_by = 'timeout'. The first of the two mitigations the wire contract requires
 * for a `sessions/end` that never arrives; the second is that self-serve rate counts
 * by started_at, so an unclosed session still appears in the denominator.
 *
 * This is NOT the inactivity clock and NOT auto-close. Those operate on
 * resolution_cycle and ship with the conversation slice.
 *
 * It sweeps every workspace by looping one tenant-scoped transaction per workspace
 * rather than by bypassing RLS. Granting BYPASSRLS for the convenience of a job
 * would put a hole in the mechanism protecting the highest-risk requirement here.
 */
export async function closeStaleSessions(options: CloseStaleSessionsOptions = {}): Promise<number> {
  const now = options.now ?? new Date();
  const timeoutMinutes = options.timeoutMinutes ?? getEnv().SESSION_TIMEOUT_MINUTES;
  const cutoff = new Date(now.getTime() - timeoutMinutes * 60_000);

  const workspaces = await withoutWorkspace(async (tx) =>
    tx.select({ id: workspace.id }).from(workspace).where(isNull(workspace.disabledAt)),
  );

  let closed = 0;
  for (const ws of workspaces) {
    closed += await withWorkspace(ws.id, async (tx) => {
      const ended = await tx
        .update(session)
        .set({ endedAt: now, endedBy: 'timeout' })
        .where(and(isNull(session.endedAt), lt(session.startedAt, cutoff)))
        .returning({ id: session.id, playerId: session.playerId, startedAt: session.startedAt });

      for (const row of ended) {
        await appendEvent(tx, {
          workspaceId: ws.id,
          type: 'session_end',
          sessionId: row.id,
          actorType: 'system',
          occurredAt: now,
          payload: {
            ended_by: 'timeout',
            duration_ms_derived: now.getTime() - row.startedAt.getTime(),
            timeout_minutes: timeoutMinutes,
          },
        });
      }
      return ended.length;
    });
  }

  return closed;
}
