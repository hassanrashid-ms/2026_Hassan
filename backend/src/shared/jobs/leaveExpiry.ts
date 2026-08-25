import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { agent } from '../db/schema/index.ts';
import { withoutWorkspace } from '../db/withWorkspace.ts';
import { logger } from '../logging/logger.ts';

export const LEAVE_EXPIRY_JOB = 'leave-expiry';

export type RunLeaveExpiryOptions = { now?: Date };

/**
 * `agent` is a global, unscoped table (only `workspace` and `agent` are), so
 * this needs no per-workspace loop — one statement covers every agent on
 * every workspace, same as `listAllWorkspaces`'s use of `withoutWorkspace`.
 *
 * Only clears a *planned* return (`on_leave_until` set and past). Indefinite
 * leave (`on_leave_until` NULL, per `setAgentLeaveStatus`'s own contract)
 * never auto-clears — there is no date to compare against, and reading
 * silence as "clear now" would return an agent to the queue nobody decided
 * was ready.
 *
 * No change-log row: `appendChangeLog` requires a real agent `actorId`
 * ("There is no system or bot actor" — see its own doc comment), and this is
 * exactly that case. The `logger.info` line below is the audit trail for a
 * system-driven transition, matching every other sweeper in this file's
 * siblings (autoClose.ts, formTimeout.ts).
 */
export async function runLeaveExpiry(options: RunLeaveExpiryOptions = {}): Promise<number> {
  const now = options.now ?? new Date();

  return withoutWorkspace(async (tx) => {
    const cleared = await tx
      .update(agent)
      .set({ status: 'active', onLeaveSince: null, onLeaveUntil: null })
      .where(
        and(
          eq(agent.status, 'on_leave'),
          isNotNull(agent.onLeaveUntil),
          lte(agent.onLeaveUntil, now),
        ),
      )
      .returning({ id: agent.id });

    if (cleared.length > 0) {
      logger.info(
        'jobs',
        `cleared expired leave for ${cleared.length} agent(s): ${cleared.map((a) => a.id).join(', ')}`,
      );
    }
    return cleared.length;
  });
}
