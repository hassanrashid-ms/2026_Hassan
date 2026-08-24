import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { resolutionCycle } from '../../shared/db/schema/index.ts';
import type { Tx } from '../../shared/db/withWorkspace.ts';

/**
 * Both stages of the clock use the same window: 24h of silence before the ask,
 * 24h more before the timeout. A constant in one file — a per-workspace setting
 * would be a schema change and nobody has asked for one.
 */
export const INACTIVITY_WINDOW_HOURS = 24;

/** The four terminal outcomes a cycle can record. Mirrors the resolution_source enum. */
export type ResolutionKind = 'bot' | 'agent' | 'player_confirmed' | 'timed_out';

export function nextInactivityDueAt(from: Date): Date {
  return new Date(from.getTime() + INACTIVITY_WINDOW_HOURS * 3_600_000);
}

/**
 * Opens the next cycle. `inactivity_due_at` is always NULL here even on a reopen,
 * where the conversation goes straight to `open`: the player's own message is
 * posted immediately after, and postMessage's touch starts the clock. One writer
 * of that column beats two.
 *
 * Throws on a second open cycle — `resolution_cycle_open_uk` is the guard, and a
 * caller that double-opens is a bug that must not be swallowed.
 */
export async function openResolutionCycle(
  tx: Tx,
  args: { workspaceId: string; conversationId: string },
): Promise<{ id: string; cycleNo: number }> {
  const [prev] = await tx
    .select({ maxNo: sql<number | null>`max(${resolutionCycle.cycleNo})` })
    .from(resolutionCycle)
    .where(eq(resolutionCycle.conversationId, args.conversationId));

  const cycleNo = Number(prev?.maxNo ?? 0) + 1;
  const [created] = await tx
    .insert(resolutionCycle)
    .values({ workspaceId: args.workspaceId, conversationId: args.conversationId, cycleNo })
    .returning({ id: resolutionCycle.id, cycleNo: resolutionCycle.cycleNo });

  if (!created) throw new Error('openResolutionCycle: insert returned nothing');
  return created;
}

/**
 * Pushes the due date one window out on whichever cycle is currently open. The
 * `resolved_at IS NULL` filter is what makes every one of these a no-op on a
 * conversation with nothing running — no caller has to check first.
 */
export async function touchInactivityClock(
  tx: Tx,
  args: { conversationId: string; now: Date },
): Promise<void> {
  await tx
    .update(resolutionCycle)
    .set({ inactivityDueAt: nextInactivityDueAt(args.now) })
    .where(
      and(
        eq(resolutionCycle.conversationId, args.conversationId),
        isNull(resolutionCycle.resolvedAt),
      ),
    );
}

/** On escalated: NULL so the worker skips it entirely rather than filtering on status alone. */
export async function pauseInactivityClock(
  tx: Tx,
  args: { conversationId: string },
): Promise<void> {
  await tx
    .update(resolutionCycle)
    .set({ inactivityDueAt: null })
    .where(
      and(
        eq(resolutionCycle.conversationId, args.conversationId),
        isNull(resolutionCycle.resolvedAt),
      ),
    );
}

/** On unescalated: a fresh full window, not the remainder of the one that was paused. */
export async function resumeInactivityClock(
  tx: Tx,
  args: { conversationId: string; now: Date },
): Promise<void> {
  await touchInactivityClock(tx, args);
}

export async function closeResolutionCycle(
  tx: Tx,
  args: { conversationId: string; kind: ResolutionKind; now: Date },
): Promise<void> {
  await tx
    .update(resolutionCycle)
    .set({ resolvedAt: args.now, resolutionKind: args.kind, inactivityDueAt: null })
    .where(
      and(
        eq(resolutionCycle.conversationId, args.conversationId),
        isNull(resolutionCycle.resolvedAt),
      ),
    );
}

/**
 * Stamps `closed_at` on the newest cycle — the auto-close semantic, reached
 * either by runAutoClose or by openNewTicket force-closing the old conversation.
 * Write-once: a cycle already stamped keeps its original timestamp, because the
 * first close is the one that happened.
 */
export async function stampCycleClosed(
  tx: Tx,
  args: { conversationId: string; now: Date },
): Promise<void> {
  const [latest] = await tx
    .select({ id: resolutionCycle.id })
    .from(resolutionCycle)
    .where(eq(resolutionCycle.conversationId, args.conversationId))
    .orderBy(desc(resolutionCycle.cycleNo))
    .limit(1);

  if (!latest) return;

  await tx
    .update(resolutionCycle)
    .set({ closedAt: args.now })
    .where(and(eq(resolutionCycle.id, latest.id), isNull(resolutionCycle.closedAt)));
}
