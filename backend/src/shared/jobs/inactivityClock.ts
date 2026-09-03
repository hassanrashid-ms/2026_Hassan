import { and, desc, eq, inArray, isNull, lte, ne } from 'drizzle-orm';
import type { NotificationView } from '@support/types';
import {
  conversation,
  message,
  resolutionCycle,
  workspace,
  workspaceMember,
} from '../db/schema/index.ts';
import { withWorkspace, withoutWorkspace, type Tx } from '../db/withWorkspace.ts';
import { appendEvent } from '../events/appendEvent.ts';
import {
  closeResolutionCycle,
  postMessage,
  RESOLUTION_CHECK_MESSAGE,
  toAgentView,
  toPlayerView,
  touchInactivityClock,
} from '../../domain/conversations/index.ts';
import { notifyAgentReplyOwed } from '../../domain/notifications/notifyAgentReplyOwed.ts';
import {
  emitInboxChanged,
  emitMessageToRooms,
  emitNotificationNew,
  emitPhaseChanged,
} from '../realtime/emit.ts';
import { tryIo } from '../realtime/tryIo.ts';
import { logger } from '../logging/logger.ts';

export const INACTIVITY_CLOCK_JOB = 'inactivity-clock';

/** The clock only runs while support owns the conversation. */
const CLOCK_STATUSES = ['open', 'awaiting_player'] as const;

export type RunInactivityClockOptions = { now?: Date };
export type InactivityClockResult = { asked: number; timedOut: number };

/**
 * The two-stage inactivity clock. Stage 1 asks "Did this solve it?" after a
 * window of silence; stage 2 resolves as `timed_out` after a second window with
 * no answer.
 *
 * Both stages run every tick and cannot double-process one conversation, because
 * stage 1's own post runs through postMessage, whose touch pushes
 * inactivity_due_at a full window into the future — which is also what sets the
 * stage 2 deadline, so no code here writes that column directly.
 *
 * Sweeps every workspace by looping one tenant-scoped transaction per workspace
 * rather than by bypassing RLS, following closeStaleSessions. Like
 * sweepAbandonedForms it opens one transaction per conversation: this job posts
 * messages and flips statuses, and a single bad row must not roll back and
 * strand every other player in the workspace.
 */
export async function runInactivityClock(
  options: RunInactivityClockOptions = {},
): Promise<InactivityClockResult> {
  const now = options.now ?? new Date();

  const workspaces = await withoutWorkspace(async (tx) =>
    tx.select({ id: workspace.id }).from(workspace).where(isNull(workspace.disabledAt)),
  );

  let asked = 0;
  let timedOut = 0;
  for (const ws of workspaces) {
    asked += await runAskStage(ws.id, now);
    timedOut += await runTimeoutStage(ws.id, now);
  }
  return { asked, timedOut };
}

/** Candidate rows for a stage. The status join is what keeps escalated, bot_active and resolved out. */
async function candidates(
  workspaceId: string,
  now: Date,
  phase: 'none' | 'inactivity_ask',
): Promise<{ cycleId: string; conversationId: string; assignedAgentId: string | null }[]> {
  return withWorkspace(workspaceId, async (tx) =>
    tx
      .select({
        cycleId: resolutionCycle.id,
        conversationId: resolutionCycle.conversationId,
        assignedAgentId: conversation.assignedAgentId,
      })
      .from(resolutionCycle)
      .innerJoin(conversation, eq(conversation.id, resolutionCycle.conversationId))
      .where(
        and(
          isNull(resolutionCycle.resolvedAt),
          lte(resolutionCycle.inactivityDueAt, now),
          inArray(conversation.status, CLOCK_STATUSES),
          eq(conversation.confirmPhase, phase),
        ),
      ),
  );
}

/**
 * Re-reads and locks the conversation inside the write transaction. The
 * candidate list was gathered in an earlier, already-committed transaction, so a
 * player can have answered in between — this lock plus the re-check is what makes
 * that a no-op instead of a second question or a resolve over an answer.
 */
async function lockAndCheck(
  tx: Tx,
  conversationId: string,
  phase: 'none' | 'inactivity_ask',
): Promise<{ status: string; confirmPhase: string; assignedAgentId: string | null } | null> {
  const [locked] = await tx
    .select({
      status: conversation.status,
      confirmPhase: conversation.confirmPhase,
      assignedAgentId: conversation.assignedAgentId,
    })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1)
    .for('update');

  if (!locked) return null;
  if (locked.confirmPhase !== phase) return null;
  if (!(CLOCK_STATUSES as readonly string[]).includes(locked.status)) return null;
  return locked;
}

type AskOutcome =
  | { kind: 'asked'; message: Awaited<ReturnType<typeof postMessage>> }
  | { kind: 'reply_owed'; notifications: NotificationView[] };

async function runAskStage(workspaceId: string, now: Date): Promise<number> {
  const rows = await candidates(workspaceId, now, 'none');

  let asked = 0;
  for (const row of rows) {
    try {
      const outcome = await withWorkspace(workspaceId, async (tx): Promise<AskOutcome | null> => {
        const locked = await lockAndCheck(tx, row.conversationId, 'none');
        if (!locked) return null;

        // Same "last public, non-system message" check stage 2 uses to compute
        // supportOwedFlag — if the agent hasn't replied since the player's last
        // word, asking "did this solve it?" is nonsensical.
        const [last] = await tx
          .select({ authorType: message.authorType })
          .from(message)
          .where(
            and(
              eq(message.conversationId, row.conversationId),
              eq(message.visibility, 'public'),
              ne(message.authorType, 'system'),
            ),
          )
          .orderBy(desc(message.seq))
          .limit(1);

        if (last?.authorType === 'player') {
          const notifiedAgentIds: string[] = [];
          if (locked.assignedAgentId) {
            notifiedAgentIds.push(locked.assignedAgentId);
          } else {
            const leads = await tx
              .select({ agentId: workspaceMember.agentId })
              .from(workspaceMember)
              .where(
                and(
                  eq(workspaceMember.workspaceId, workspaceId),
                  eq(workspaceMember.role, 'team_lead'),
                  isNull(workspaceMember.deactivatedAt),
                ),
              );
            notifiedAgentIds.push(...leads.map((l) => l.agentId));
          }

          const notifications: NotificationView[] = [];
          for (const agentId of notifiedAgentIds) {
            notifications.push(
              await notifyAgentReplyOwed(tx, {
                workspaceId,
                agentId,
                conversationId: row.conversationId,
              }),
            );
          }

          await touchInactivityClock(tx, { conversationId: row.conversationId, now });

          await appendEvent(tx, {
            workspaceId,
            type: 'reply_owed_reminder_sent',
            conversationId: row.conversationId,
            actorId: null,
            actorType: 'system',
            payload: { source: 'inactivity', notified: locked.assignedAgentId ? 'agent' : 'team_leads' },
          });

          return { kind: 'reply_owed', notifications };
        }

        // `now` is threaded into postMessage so the stage 2 deadline this touch
        // writes is derived from the tick's clock, not from wall time.
        const sent = await postMessage(tx, {
          workspaceId,
          conversationId: row.conversationId,
          authorType: 'system',
          actorId: null,
          body: RESOLUTION_CHECK_MESSAGE,
          visibility: 'public',
          now,
        });

        await tx
          .update(conversation)
          .set({ confirmPhase: 'inactivity_ask' })
          .where(eq(conversation.id, row.conversationId));

        // Same event type the agent's manual ask writes, disambiguated by
        // payload `source` — the pattern conversation_assigned already uses for
        // `via`. Two event types for one fact would split every funnel that
        // counts "questions asked".
        await appendEvent(tx, {
          workspaceId,
          type: 'resolution_check_requested',
          conversationId: row.conversationId,
          actorId: null,
          actorType: 'system',
          payload: { source: 'inactivity' },
        });

        return { kind: 'asked', message: sent };
      });

      if (!outcome) continue;

      const io = tryIo('jobs', { workspaceId, conversationId: row.conversationId });

      if (outcome.kind === 'asked') {
        asked += 1;
        if (io) {
          emitMessageToRooms(
            io,
            row.conversationId,
            toPlayerView(outcome.message),
            toAgentView(outcome.message),
          );
          emitPhaseChanged(io, row.conversationId, {
            conversation_id: row.conversationId,
            confirm_phase: 'inactivity_ask',
          });
        }
      } else if (io) {
        for (const notificationView of outcome.notifications) {
          emitNotificationNew(io, notificationView.agent_id, notificationView);
        }
      }
    } catch (error) {
      logger.error('jobs', `inactivity-clock ask failed for conversation ${row.conversationId}`, {
        workspaceId,
        error: error instanceof Error ? `${error.name} ${error.message}` : String(error),
      });
    }
  }
  return asked;
}

async function runTimeoutStage(workspaceId: string, now: Date): Promise<number> {
  const rows = await candidates(workspaceId, now, 'inactivity_ask');

  let timedOut = 0;
  for (const row of rows) {
    try {
      const done = await withWorkspace(workspaceId, async (tx) => {
        if (!(await lockAndCheck(tx, row.conversationId, 'inactivity_ask'))) return false;

        // "Support owed the reply when the clock fired." System messages are
        // excluded because stage 1's own ask is one and is always last, which
        // would make the flag unconditionally true; internal notes are excluded
        // because a note between agents is not a reply to the player.
        const [last] = await tx
          .select({ authorType: message.authorType })
          .from(message)
          .where(
            and(
              eq(message.conversationId, row.conversationId),
              eq(message.visibility, 'public'),
              ne(message.authorType, 'system'),
            ),
          )
          .orderBy(desc(message.seq))
          .limit(1);
        const supportOwed = last?.authorType === 'player';

        await tx
          .update(conversation)
          .set({ status: 'resolved', confirmPhase: 'none', resolutionSource: 'timed_out' })
          .where(eq(conversation.id, row.conversationId));

        // By id, not by the open-cycle predicate: this runs before the close and
        // must land on the row the candidate scan actually selected.
        await tx
          .update(resolutionCycle)
          .set({ supportOwedFlag: supportOwed })
          .where(eq(resolutionCycle.id, row.cycleId));

        await closeResolutionCycle(tx, {
          conversationId: row.conversationId,
          kind: 'timed_out',
          now,
        });

        await appendEvent(tx, {
          workspaceId,
          type: 'conversation_resolved',
          conversationId: row.conversationId,
          actorId: null,
          actorType: 'system',
          payload: { source: 'inactivity', confirmed_by: 'timeout', support_owed: supportOwed },
        });

        return true;
      });

      if (!done) continue;
      timedOut += 1;

      const io = tryIo('jobs', { workspaceId, conversationId: row.conversationId });
      if (io) {
        emitPhaseChanged(io, row.conversationId, {
          conversation_id: row.conversationId,
          confirm_phase: 'none',
        });
        emitInboxChanged(io, workspaceId, row.conversationId, 'resolved');
      }
    } catch (error) {
      logger.error(
        'jobs',
        `inactivity-clock timeout failed for conversation ${row.conversationId}`,
        {
          workspaceId,
          error: error instanceof Error ? `${error.name} ${error.message}` : String(error),
        },
      );
    }
  }
  return timedOut;
}
