import { eq } from 'drizzle-orm'
import { applyBotTurn } from '../bot/applyBotTurn.ts'
import type { PostedMessageRow } from './postMessage.ts'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { conversation } from '../../shared/db/schema/index.ts'
import type { Tx } from '../../shared/db/withWorkspace.ts'

export type ResolutionAnswerContext = {
  workspaceId: string
  conversationId: string
  playerId: string
  /** Verified by the caller, or null. Attribution only — never a gate. */
  sessionId: string | null
}

export type ResolutionAnswerOutcome =
  | { kind: 'rejected' }
  | { kind: 'resolved'; source: 'bot' | 'agent' }
  | { kind: 'handed_off'; posted: PostedMessageRow }
  | { kind: 'declined' }

/**
 * The only place a player's Yes/No is applied, for both sources. One
 * transaction, owned by the caller.
 *
 * The `bot_article` branches delegate to applyBotTurn's existing `resolve` and
 * `handoff('article_rejected')` cases rather than reimplementing them. That is
 * the point: a tap and the model's confirm_resolution tool then reach literally
 * the same code, so they cannot drift, and the bot path cannot regress because
 * this slice did not touch it.
 *
 * `for('update')` makes a double-tap safe — the second answer reads 'none' and
 * is rejected, instead of resolving an already-resolved conversation.
 */
export async function applyResolutionAnswer(
  tx: Tx,
  ctx: ResolutionAnswerContext,
  helped: boolean,
): Promise<ResolutionAnswerOutcome> {
  const [found] = await tx
    .select({ confirmPhase: conversation.confirmPhase })
    .from(conversation)
    .where(eq(conversation.id, ctx.conversationId))
    .limit(1)
    .for('update')

  // An answer with no question outstanding writes nothing. Covers a stale
  // banner, a replayed request and a double tap in one guard.
  if (!found || found.confirmPhase === 'none') return { kind: 'rejected' }

  const botCtx = { workspaceId: ctx.workspaceId, conversationId: ctx.conversationId }

  if (found.confirmPhase === 'bot_article') {
    if (helped) {
      await applyBotTurn(tx, botCtx, { kind: 'resolve', subintentId: null })
      return { kind: 'resolved', source: 'bot' }
    }
    const result = await applyBotTurn(tx, botCtx, { kind: 'handoff', reason: 'article_rejected', subintentId: null })
    const posted = result.posted[0]
    if (!posted) throw new Error('handoff produced no player message')
    return { kind: 'handed_off', posted }
  }

  // agent_ask.
  if (helped) {
    await tx
      .update(conversation)
      // resolution_source is what reopen reads to keep the previous owner
      // (spec 4 §10) — the event payload is the audit trail, not the signal.
      .set({ status: 'resolved', confirmPhase: 'none', resolutionSource: 'agent' })
      .where(eq(conversation.id, ctx.conversationId))
    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_resolved',
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      actorId: ctx.playerId,
      actorType: 'player',
      payload: { source: 'agent', confirmed_by: 'player' },
    })
    return { kind: 'resolved', source: 'agent' }
  }

  // A decline touches no status: a human already owns this conversation, so
  // there is nothing to hand off. The agent sees it through the phase event.
  await tx.update(conversation).set({ confirmPhase: 'none' }).where(eq(conversation.id, ctx.conversationId))
  await appendEvent(tx, {
    workspaceId: ctx.workspaceId,
    type: 'resolution_check_declined',
    conversationId: ctx.conversationId,
    sessionId: ctx.sessionId,
    actorId: ctx.playerId,
    actorType: 'player',
    payload: { source: 'agent' },
  })
  return { kind: 'declined' }
}
