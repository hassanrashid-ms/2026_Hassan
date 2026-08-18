import { eq } from 'drizzle-orm'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { conversation } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'
import { pauseInactivityClock, resumeInactivityClock } from '../../domain/conversations/index.ts'

const ESCALATABLE_STATUSES = new Set(['open', 'awaiting_player'])

export type EscalationOutcome =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'wrong_status' | 'not_owner' }

// Escalation is a direct status flip, not a side effect of a message — unlike
// the rest of the lifecycle, there is no message that would carry it. It never
// touches assigned_agent_id: the agent keeps the conversation, only the status
// changes, so `for('update')` guards against a double-toggle race, same as
// askResolved.
export async function escalateConversation(ctx: AgentContext, conversationId: string): Promise<EscalationOutcome> {
  return toggle(ctx, conversationId, {
    allowedFrom: ESCALATABLE_STATUSES,
    next: 'escalated',
    eventType: 'conversation_escalated',
    clock: 'pause',
  })
}

export async function unescalateConversation(ctx: AgentContext, conversationId: string): Promise<EscalationOutcome> {
  return toggle(ctx, conversationId, {
    allowedFrom: new Set(['escalated']),
    next: 'open',
    eventType: 'conversation_unescalated',
    clock: 'resume',
  })
}

async function toggle(
  ctx: AgentContext,
  conversationId: string,
  opts: {
    allowedFrom: Set<string>
    next: 'escalated' | 'open'
    eventType: 'conversation_escalated' | 'conversation_unescalated'
    clock: 'pause' | 'resume'
  },
): Promise<EscalationOutcome> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx
      .select({ status: conversation.status, assignedAgentId: conversation.assignedAgentId })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1)
      .for('update')

    // RLS makes "another workspace's" and "nonexistent" the same answer.
    if (!found) return { ok: false, reason: 'not_found' }
    if (!opts.allowedFrom.has(found.status)) return { ok: false, reason: 'wrong_status' }
    if (found.assignedAgentId !== null && found.assignedAgentId !== ctx.agentId) {
      return { ok: false, reason: 'not_owner' }
    }

    await tx.update(conversation).set({ status: opts.next }).where(eq(conversation.id, conversationId))

    // No message carries an escalation, so the clock cannot ride on
    // postMessage's touch here — these two calls are the only direct writers of
    // inactivity_due_at outside that hook. Pausing (rather than filtering on
    // status in the worker) is what the design requires: an escalated
    // conversation must be invisible to the scan, not merely skipped by it.
    // Resume grants a fresh full window rather than the remainder of the paused
    // one — the escalation, however long it ran, is not silence from the player.
    if (opts.clock === 'pause') {
      await pauseInactivityClock(tx, { conversationId })
    } else {
      await resumeInactivityClock(tx, { conversationId, now: new Date() })
    }

    // No session_id: an agent-console request has no player session behind it.
    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: opts.eventType,
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { agent_id: ctx.agentId },
    })

    return { ok: true }
  })
}
