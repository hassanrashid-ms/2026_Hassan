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
} | null

async function gather(tx: Tx, conversationId: string): Promise<{ conv: GatherResult; history: PlayerMessageView[] }> {
  const [conv] = await tx
    .select({ status: conversation.status, subintentId: conversation.subintentId })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1)

  const rows: PostedMessageRow[] = await tx
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.seq))

  const history = rows.map(toPlayerView).filter((m): m is PlayerMessageView => m !== null)

  return { conv: conv ?? null, history }
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

/**
 * Shared by `runBotTurn`'s own apply/emit step and the BullMQ `failed` handler
 * (`shared/jobs/botTurns.ts`) — the fallback outcome after a final retry attempt
 * runs through the exact same apply-then-emit path a successful decide does.
 */
export async function applyDecisionAndEmit(
  workspaceId: string,
  conversationId: string,
  decision: BotTurnDecision,
): Promise<{ posted: PostedMessageRow[]; statusChanged: boolean }> {
  const result = await withWorkspace(workspaceId, (tx) => applyBotTurn(tx, { workspaceId, conversationId }, decision))
  emitApplied(workspaceId, conversationId, result)
  return result
}

/**
 * The status is re-read here, not trusted from the enqueue site: an agent may have
 * claimed or replied to the conversation in the window between enqueue and this job
 * running. A no-op is the safe outcome of that race — see spec §4.
 */
export async function runBotTurn(workspaceId: string, conversationId: string, decider: BotDecider): Promise<void> {
  const { conv, history } = await withWorkspace(workspaceId, (tx) => gather(tx, conversationId))

  if (!conv || conv.status !== 'bot_active') return

  const decision = await decider({ workspaceId, conversationId, subintentId: conv.subintentId, history })

  await applyDecisionAndEmit(workspaceId, conversationId, decision)
}
