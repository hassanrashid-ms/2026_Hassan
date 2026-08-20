import { and, asc, desc, eq } from 'drizzle-orm'
import type { Server } from 'socket.io'
import { applyBotTurn } from './applyBotTurn.ts'
import type { BotDecider, BotTurnDecision, BotTurnInput } from './botTurn.ts'
import { toAgentView, toPlayerView, type PostedMessageRow } from '../conversations/index.ts'
import { conversation, event, message } from '../../shared/db/schema/index.ts'
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts'
import { emitInboxChanged, emitMessageToRooms, emitPhaseChanged } from '../../shared/realtime/emit.ts'
import { getIo } from '../../shared/realtime/socketServer.ts'
import { logger } from '../../shared/logging/logger.ts'
import type { ConfirmPhaseValue, PlayerMessageView } from '@support/types'

export type { BotTurnInput }

type GatherResult = {
  status: string
  subintentId: string | null
  confirmPhase: ConfirmPhaseValue
} | null

async function gather(
  tx: Tx,
  conversationId: string,
): Promise<{
  conv: GatherResult
  history: PlayerMessageView[]
  botMessageCount: number
  unhelpedReplyCount: number
  lastPlayerMessageAt: Date | null
}> {
  const [conv] = await tx
    .select({ status: conversation.status, subintentId: conversation.subintentId, confirmPhase: conversation.confirmPhase })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1)

  const rows: PostedMessageRow[] = await tx
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.seq))

  const history = rows.map(toPlayerView).filter((m): m is PlayerMessageView => m !== null)
  const botMessageCount = rows.filter((r) => r.authorType === 'bot').length
  const lastPlayer = rows.filter((r) => r.authorType === 'player').at(-1)

  // "Unhelped" resets at the conversation's most recent conversation_resolved
  // event — no new stored counter, derived the same way botMessageCount is.
  const [lastResolved] = await tx
    .select({ occurredAt: event.occurredAt })
    .from(event)
    .where(and(eq(event.conversationId, conversationId), eq(event.type, 'conversation_resolved')))
    .orderBy(desc(event.occurredAt))
    .limit(1)
  const unhelpedReplyCount = rows.filter(
    (r) => r.authorType === 'bot' && (!lastResolved || r.createdAt > lastResolved.occurredAt),
  ).length

  return { conv: conv ?? null, history, botMessageCount, unhelpedReplyCount, lastPlayerMessageAt: lastPlayer?.createdAt ?? null }
}

/**
 * Socket server may not be running at all (a `runBotTurn` unit test with no
 * Redis, per the orchestrator's global contract) — that's not an error worth
 * failing the turn over, since the DB write already committed. Any other
 * failure from the emit path still propagates.
 */
function emitApplied(
  workspaceId: string,
  conversationId: string,
  result: { posted: PostedMessageRow[]; statusChanged: boolean; phaseChanged: ConfirmPhaseValue | null },
): void {
  let io: Server
  try {
    io = getIo()
  } catch (err) {
    logger.warn('bot.orchestrator', 'skipping realtime emit: socket server not initialised', {
      workspaceId,
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  for (const row of result.posted) {
    emitMessageToRooms(io, conversationId, toPlayerView(row), toAgentView(row))
  }
  // The form offer changes no status, so `conversation:changed` says nothing and
  // the agent rail would never learn the card went up. Only the offer sets this.
  if (result.phaseChanged) {
    emitPhaseChanged(io, conversationId, { conversation_id: conversationId, confirm_phase: result.phaseChanged })
  }
  if (result.statusChanged) {
    emitInboxChanged(io, workspaceId, conversationId, 'open')
  }
}

export type ApplyIfBotActiveResult =
  | { applied: true; posted: PostedMessageRow[]; statusChanged: boolean; phaseChanged: ConfirmPhaseValue | null }
  | { applied: false }

/**
 * Shared by `runBotTurn`'s own apply/emit step and the BullMQ `failed` handler
 * (`shared/jobs/botTurns.ts`) — the fallback outcome after a final retry attempt
 * runs through the exact same guarded apply-then-emit path a successful decide
 * does.
 *
 * The guard is made atomic with the apply by doing both inside a single
 * transaction: `SELECT ... FOR UPDATE` row-locks the conversation so a
 * concurrent claim serialises against this apply rather than racing it, then
 * the status check and `applyBotTurn` call happen against that locked read.
 * Reading status in an earlier, separate transaction (as a naive
 * "check-then-apply" would) leaves a window between the check and the write
 * where an agent can claim or reply — this closes that window rather than
 * narrowing it.
 *
 * The socket emit happens after the transaction commits, never inside it, and
 * only when the decision actually applied — a skip must not emit.
 */
export async function applyDecisionIfBotActive(
  workspaceId: string,
  conversationId: string,
  decision: BotTurnDecision,
): Promise<ApplyIfBotActiveResult> {
  const result = await withWorkspace(workspaceId, async (tx) => {
    const [conv] = await tx
      .select({ status: conversation.status })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .for('update')
      .limit(1)

    if (!conv || conv.status !== 'bot_active') return { applied: false } as const

    const applied = await applyBotTurn(tx, { workspaceId, conversationId }, decision)
    return { applied: true, ...applied } as const
  })

  if (!result.applied) {
    logger.info('bot.orchestrator', 'skipped apply: conversation left bot_active before apply', {
      workspaceId,
      conversationId,
    })
    return result
  }

  emitApplied(workspaceId, conversationId, result)
  return result
}

/**
 * The status is re-read here, not trusted from the enqueue site: an agent may have
 * claimed or replied to the conversation in the window between enqueue and this job
 * running. A no-op is the safe outcome of that race — see spec §4.
 *
 * This cheap pre-decide check is deliberately not the only guard: it saves calling
 * the decider at all once the conversation has left `bot_active`, but status can
 * still change while the decider itself is running (it may call out to a model).
 * `applyDecisionIfBotActive` re-checks atomically with the apply, which is the
 * authoritative guard.
 */
export async function runBotTurn(workspaceId: string, conversationId: string, decider: BotDecider): Promise<void> {
  const { conv, history, botMessageCount, unhelpedReplyCount, lastPlayerMessageAt } = await withWorkspace(workspaceId, (tx) =>
    gather(tx, conversationId),
  )

  if (!conv || conv.status !== 'bot_active') return

  const decision = await decider({
    workspaceId,
    conversationId,
    subintentId: conv.subintentId,
    confirmPhase: conv.confirmPhase,
    botMessageCount,
    unhelpedReplyCount,
    lastPlayerMessageAt,
    history,
  })

  await applyDecisionIfBotActive(workspaceId, conversationId, decision)
}
