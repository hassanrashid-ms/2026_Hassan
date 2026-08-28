import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { conversation, resolutionCycle, workspace } from '../db/schema/index.ts';
import { withWorkspace, withoutWorkspace } from '../db/withWorkspace.ts';
import { appendEvent } from '../events/appendEvent.ts';
import { emitInboxChanged } from '../realtime/emit.ts';
import { tryIo } from '../realtime/tryIo.ts';
import { logger } from '../logging/logger.ts';

export const AUTO_CLOSE_JOB = 'auto-close';

export type RunAutoCloseOptions = { now?: Date };

/**
 * `resolved` → `closed` once the workspace's auto-close window has elapsed.
 *
 * The join to `conversation` filtered on `status = 'resolved'` is required, not
 * decorative. A cycle whose conversation was later reopened keeps its old
 * `resolved_at` and a NULL `closed_at` forever — correct, it records that this
 * resolution never got auto-closed because it reopened first. Without the status
 * filter that stale, superseded cycle would close a conversation that has since
 * moved on.
 *
 * The window is read per workspace, not from an env var: it is a per-tenant
 * product setting.
 */
export async function runAutoClose(options: RunAutoCloseOptions = {}): Promise<number> {
  const now = options.now ?? new Date();

  const workspaces = await withoutWorkspace(async (tx) =>
    tx
      .select({ id: workspace.id, autoCloseDays: workspace.autoCloseDays })
      .from(workspace)
      .where(isNull(workspace.disabledAt)),
  );

  let closed = 0;
  for (const ws of workspaces) {
    const cutoff = new Date(now.getTime() - ws.autoCloseDays * 86_400_000);

    const due = await withWorkspace(ws.id, async (tx) =>
      tx
        .select({ cycleId: resolutionCycle.id, conversationId: resolutionCycle.conversationId })
        .from(resolutionCycle)
        .innerJoin(conversation, eq(conversation.id, resolutionCycle.conversationId))
        .where(
          and(
            isNotNull(resolutionCycle.resolvedAt),
            isNull(resolutionCycle.closedAt),
            lte(resolutionCycle.resolvedAt, cutoff),
            eq(conversation.status, 'resolved'),
          ),
        ),
    );

    for (const row of due) {
      try {
        const done = await withWorkspace(ws.id, async (tx) => {
          // The status is repeated in the UPDATE's WHERE rather than trusted from
          // the select — the same claim-race pattern conversationsService uses.
          // A player who reopened between the scan and here wins, and this
          // becomes a no-op instead of closing a live conversation.
          const updated = await tx
            .update(conversation)
            .set({ status: 'closed' })
            .where(
              and(eq(conversation.id, row.conversationId), eq(conversation.status, 'resolved')),
            )
            .returning({ id: conversation.id });

          if (updated.length === 0) return false;

          await tx
            .update(resolutionCycle)
            .set({ closedAt: now })
            .where(and(eq(resolutionCycle.id, row.cycleId), isNull(resolutionCycle.closedAt)));

          await appendEvent(tx, {
            workspaceId: ws.id,
            type: 'conversation_closed',
            conversationId: row.conversationId,
            actorId: null,
            actorType: 'system',
            // Snapshotted: the window is a mutable per-workspace setting, and an
            // event that only said "auto_close" could never say after what.
            payload: { reason: 'auto_close', days: ws.autoCloseDays },
          });

          return true;
        });

        if (!done) continue;
        closed += 1;

        const io = tryIo('jobs', { workspaceId: ws.id, conversationId: row.conversationId });
        if (io) emitInboxChanged(io, ws.id, row.conversationId, 'closed');
      } catch (error) {
        logger.error('jobs', `auto-close failed for conversation ${row.conversationId}`, {
          workspaceId: ws.id,
          error: error instanceof Error ? `${error.name} ${error.message}` : String(error),
        });
      }
    }
  }

  return closed;
}
