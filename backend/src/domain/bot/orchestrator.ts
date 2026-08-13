import { asc, eq } from 'drizzle-orm'
import type { Server } from 'socket.io'
import { applyBotTurn } from './applyBotTurn.ts'
import type { BotDecider, BotTurnDecision, BotTurnInput } from './botTurn.ts'
import { toAgentView, toPlayerView, type PostedMessageRow } from '../conversations/index.ts'
import { conversation, message } from '../../shared/db/schema/index.ts'
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts'
import { emitInboxChanged, emitMessageToRooms } from '../../shared/realtime/emit.ts'
import { getIo } from '../../shared/realtime/socketServer.ts'
import { logger } from '../../shared/logging/logger.ts'
import type { PlayerMessageView } from '@support/types'

export type { BotTurnInput }

type GatherResult = {
  status: string
  subintentId: string | null
  botPhase: 'none' | 'article_confirm'
} | null

async function gather(
  tx: Tx,
  conversationId: string,
): Promise<{ conv: GatherResult; history: PlayerMessageView[]; botMessageCount: number; lastPlayerMessageAt: Date | null }> {
  const [conv] = await tx
    .select({ status: conversation.status, subintentId: conversation.subintentId, botPhase: conversation.botPhase })
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

  return { conv: conv ?? null, history, botMessageCount, lastPlayerMessageAt: lastPlayer?.createdAt ?? null }
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
  result: { posted: PostedMessageRow[]; statusChanged: boolean },
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
  if (result.statusChanged) {
    emitInboxChanged(io, workspaceId, conversationId, 'open')
  }
}

export type ApplyIfBotActiveResult =
  | { applied: true; posted: PostedMessageRow[]; statusChanged: boolean }
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
  const { conv, history, botMessageCount, lastPlayerMessageAt } = await withWorkspace(workspaceId, (tx) => gather(tx, conversationId))

  if (!conv || conv.status !== 'bot_active') return

  const decision = await decider({
    workspaceId,
    conversationId,
    subintentId: conv.subintentId,
    botPhase: conv.botPhase,
    botMessageCount,
    lastPlayerMessageAt,
    history,
  })

  await applyDecisionIfBotActive(workspaceId, conversationId, decision)
}
