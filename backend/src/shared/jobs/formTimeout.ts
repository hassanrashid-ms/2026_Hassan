import { and, eq, isNull, lt } from 'drizzle-orm'
import { conversation, formSubmission, workspace } from '../db/schema/index.ts'
import { withWorkspace, withoutWorkspace } from '../db/withWorkspace.ts'
import { completeFormAndHandoff, emitFormTerminated } from '../../domain/forms/index.ts'
import { logger } from '../logging/logger.ts'

/**
 * Far longer than any plausible fill time, far shorter than a support SLA. A
 * constant in one file, tunable without a schema change.
 */
export const FORM_TIMEOUT_MINUTES = 30

export type SweepAbandonedFormsOptions = {
  now?: Date
  timeoutMinutes?: number
}

/**
 * Gating the status transition creates a failure mode that does not exist
 * without it: a player who force-quits mid-form leaves a conversation in
 * bot_active with confirm_phase = 'form', no agent assigned, and nothing aware
 * of it. That is "nothing may prevent a player reaching a human" violated by
 * accident, which is why this job is part of the slice rather than a follow-up.
 *
 * Answers so far are kept, the status derives normally, and the ticket reaches
 * the queue. A player who returns later reads a thread in which they were handed
 * off — which is what the handoff line already told them.
 *
 * Sweeps every workspace by looping one tenant-scoped transaction rather than by
 * bypassing RLS, following closeStaleSessions. Unlike that job it opens one
 * transaction per submission: this one assigns agents and posts messages, and a
 * single bad row must not roll back and strand every other player in the
 * workspace.
 */
export async function sweepAbandonedForms(options: SweepAbandonedFormsOptions = {}): Promise<number> {
  const now = options.now ?? new Date()
  const timeoutMinutes = options.timeoutMinutes ?? FORM_TIMEOUT_MINUTES
  const cutoff = new Date(now.getTime() - timeoutMinutes * 60_000)

  const workspaces = await withoutWorkspace(async (tx) =>
    tx.select({ id: workspace.id }).from(workspace).where(isNull(workspace.disabledAt)),
  )

  let terminated = 0
  for (const ws of workspaces) {
    const stale = await withWorkspace(ws.id, async (tx) =>
      tx
        .select({ id: formSubmission.id, conversationId: formSubmission.conversationId })
        .from(formSubmission)
        .innerJoin(conversation, eq(conversation.id, formSubmission.conversationId))
        .where(
          and(
            eq(formSubmission.status, 'in_progress'),
            lt(formSubmission.startedAt, cutoff),
            eq(conversation.confirmPhase, 'form'),
          ),
        ),
    )

    for (const row of stale) {
      try {
        const result = await withWorkspace(ws.id, async (tx) =>
          completeFormAndHandoff(
            tx,
            {
              workspaceId: ws.id,
              conversationId: row.conversationId,
              submissionId: row.id,
              // No player took this action, so there is no player actor to
              // attribute it to and no session that accompanied it.
              actorType: 'system',
              actorId: null,
              sessionId: null,
            },
            'timeout',
          ),
        )
        // null means the player terminated it between the select and here. Not
        // an error — the ticket reached the queue either way.
        if (!result) continue
        terminated += 1
        emitFormTerminated(ws.id, result)
      } catch (error) {
        // One stranded conversation must not strand the rest. Until real
        // alerting exists, this log is the alert.
        logger.error('jobs', `form-timeout failed for submission ${row.id}`, {
          workspaceId: ws.id,
          conversationId: row.conversationId,
          error: error instanceof Error ? `${error.name} ${error.message}` : String(error),
        })
      }
    }
  }

  return terminated
}
