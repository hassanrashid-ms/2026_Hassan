import { and, desc, eq } from 'drizzle-orm'
import type { z } from 'zod'
import type { ConversationStatusValue, ResolutionAnswerBody } from '@support/types'
import { applyResolutionAnswer, toAgentView, toPlayerView } from '../../domain/conversations/index.ts'
import { conversation, session } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import { emitInboxChanged, emitMessageToRooms, emitPhaseChanged } from '../../shared/realtime/emit.ts'
import { getIo } from '../../shared/realtime/socketServer.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'

type Body = z.infer<typeof ResolutionAnswerBody>

export type AnswerResolutionResult =
  | { ok: false; reason: 'not_found' | 'no_check_pending' }
  | { ok: true; status: ConversationStatusValue }

/**
 * The banner's Yes/No. No conversation id in the request: the thread is the
 * player's latest, resolved under RLS from the token — the same rule
 * getPlayerMessages follows, so the two can never disagree about which
 * conversation the banner belonged to.
 */
export async function answerResolution(ctx: PlayerContext, body: Body): Promise<AnswerResolutionResult> {
  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    // FK checks bypass RLS, so an unverified session id could point across the
    // tenant boundary and event.session_id is ON DELETE RESTRICT — a bad id
    // would roll the whole answer back. Any miss degrades to null instead.
    const [verifiedSession] = body.session_id
      ? await tx
          .select({ id: session.id })
          .from(session)
          .where(and(eq(session.id, body.session_id), eq(session.playerId, ctx.playerId)))
          .limit(1)
      : []

    const [found] = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.playerId, ctx.playerId))
      .orderBy(desc(conversation.createdAt))
      .limit(1)
    if (!found) return { ok: false as const, reason: 'not_found' as const }

    const outcome = await applyResolutionAnswer(
      tx,
      { workspaceId: ctx.workspaceId, conversationId: found.id, playerId: ctx.playerId, sessionId: verifiedSession?.id ?? null },
      body.helped,
    )
    if (outcome.kind === 'rejected') return { ok: false as const, reason: 'no_check_pending' as const }

    const [after] = await tx
      .select({ status: conversation.status })
      .from(conversation)
      .where(eq(conversation.id, found.id))
      .limit(1)

    return { ok: true as const, conversationId: found.id, outcome, status: after!.status }
  })

  if (!result.ok) return result

  // Emits only after commit. Phase always changed if we got here.
  emitPhaseChanged(getIo(), result.conversationId, { conversation_id: result.conversationId, confirm_phase: 'none' })
  // Every outcome that posts a message emits it the same way: the player's
  // Yes/No reaches the agent's open thread over the normal `message:new` path,
  // which already drives a refetch there. `posted` is null only on the bot
  // path's Yes, which writes no message at all.
  const posted = result.outcome.kind === 'handed_off' ? result.outcome.posted : (result.outcome.posted ?? null)
  if (posted) {
    emitMessageToRooms(getIo(), result.conversationId, toPlayerView(posted), toAgentView(posted))
  }
  // A decline changes no status, so the inbox has nothing to refetch for.
  if (result.outcome.kind !== 'declined') {
    emitInboxChanged(getIo(), ctx.workspaceId, result.conversationId, result.status)
  }

  return { ok: true, status: result.status }
}
