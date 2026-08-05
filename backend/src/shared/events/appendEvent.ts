import type { Tx } from '../db/withWorkspace.ts'
import { event } from '../db/schema/index.ts'

export type EventActorType = 'player' | 'agent' | 'bot' | 'system'

export type EventInput = {
  workspaceId: string
  type: string
  conversationId?: string | null
  sessionId?: string | null
  actorId?: string | null
  actorType: EventActorType
  payload?: Record<string, unknown>
  occurredAt?: Date
}

/**
 * Events are a projection, not the source of truth — every state change writes both
 * the mutable row and this append-only row, in one transaction, through one function.
 * Never insert into `event` directly.
 *
 * Payload values must be snapshotted literals, never ids that resolve to a live
 * name: an event records what happened, and a FK-resolved name would silently
 * rewrite history when someone renames the thing.
 *
 * Any client-supplied `sessionId` must already have been confirmed visible in this
 * workspace by the caller — FK checks bypass RLS, so an unverified id would be
 * accepted and would point across the tenant boundary.
 */
export async function appendEvent(tx: Tx, input: EventInput): Promise<void> {
  await tx.insert(event).values({
    workspaceId: input.workspaceId,
    type: input.type,
    conversationId: input.conversationId ?? null,
    sessionId: input.sessionId ?? null,
    actorId: input.actorId ?? null,
    actorType: input.actorType,
    payload: input.payload ?? {},
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  })
}
