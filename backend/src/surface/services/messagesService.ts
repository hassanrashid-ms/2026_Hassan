import { and, desc, eq, lte, ne } from 'drizzle-orm'
import type { z } from 'zod'
import {
  MarkPlayerReadBody,
  SendMessageBody,
  type PlayerFormView,
  type PlayerMessageView,
  type PlayerMessagesResponse,
} from '@support/types'

type SendMessageBodyType = z.infer<typeof SendMessageBody>
type MarkPlayerReadBodyType = z.infer<typeof MarkPlayerReadBody>
import { allocateTicketNumber, postMessage, toAgentView, toPlayerView, type PostedMessageRow } from '../../domain/conversations/index.ts'
import { applyBotTurn, assignOnHandoff, pickHandoffMessage, resolveBotConfig } from '../../domain/bot/index.ts'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import {
  agent,
  conversation,
  form,
  formAnswer,
  formSubmission,
  formVersion,
  message,
  session,
} from '../../shared/db/schema/index.ts'
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts'
import { emitInboxChanged, emitMessageToRooms, emitReadReceipt } from '../../shared/realtime/emit.ts'
import { getIo } from '../../shared/realtime/socketServer.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'
import { enqueueBotTurn } from '../../shared/jobs/botTurns.ts'

const REOPENABLE_STATUSES = new Set(['resolved', 'closed'])

export async function sendPlayerMessage(
  ctx: PlayerContext,
  body: SendMessageBodyType,
): Promise<{ conversation_id: string; message: PlayerMessageView | null }> {
  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    // Mandatory for tenant safety, not an optimisation: FK checks bypass RLS,
    // so a client-supplied session id must be confirmed visible before it can
    // be written to `event.session_id`. Any miss — absent, unknown, another
    // player's, or not uploaded yet — degrades to null. It never fails the
    // send: an FK rollback here would stop a player reaching a human.
    const [verifiedSession] = body.session_id
      ? await tx
          .select({ id: session.id, entryPoint: session.entryPoint })
          .from(session)
          .where(and(eq(session.id, body.session_id), eq(session.playerId, ctx.playerId)))
          .limit(1)
      : []
    const sessionId = verifiedSession?.id ?? null

    const [existing] = await tx
      .select({ id: conversation.id, status: conversation.status })
      .from(conversation)
      .where(eq(conversation.playerId, ctx.playerId))
      .orderBy(desc(conversation.createdAt))
      .limit(1)

    let conversationId: string
    // Set whenever the inbox needs to refetch: a brand-new conversation just
    // appeared in Unassigned, a reopen just moved one back into it, or a reply
    // just took one out of Awaiting Player. Claiming (Task 7) is the fourth
    // trigger for the same event, from a different path.
    let inboxStatus: string | null = null
    // Only the reopen branch sets this: the reopen's system message needs its
    // own socket emit, separate from the player's own message emitted below.
    let reopenPosted: PostedMessageRow | undefined
    // The reopen branch defers its handoff message until after the player's own
    // is posted — see below.
    let reopening = false

    if (!existing) {
      // The originating session, so a future agent Game View reaches the
      // player-state snapshot from when the problem happened. Never rewritten
      // on reopen — see docs/specs/2026-08-06-chat-module-design.md.
      // The verified request session when there is one; the latest-started
      // session is the fallback, correct with one live device and a guess with
      // two, which is why the request's own session wins.
      let originatingSessionId = sessionId
      const entryPoint = verifiedSession?.entryPoint ?? null
      if (!originatingSessionId) {
        const [latestSession] = await tx
          .select({ id: session.id })
          .from(session)
          .where(eq(session.playerId, ctx.playerId))
          .orderBy(desc(session.startedAt))
          .limit(1)
        originatingSessionId = latestSession?.id ?? null
      }

      const number = await allocateTicketNumber(tx, ctx.workspaceId)
      const [created] = await tx
        .insert(conversation)
        .values({ workspaceId: ctx.workspaceId, playerId: ctx.playerId, sessionId: originatingSessionId, number })
        .returning({ id: conversation.id })
      if (!created) throw new Error('conversation insert returned nothing')
      conversationId = created.id
      inboxStatus = 'bot_active'

      // `entry_point` is context, never classification. It is null when the
      // session could not be verified — an unknown entry point is recorded as
      // unknown, not guessed from a different session.
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'conversation_opened',
        conversationId,
        sessionId,
        actorId: ctx.playerId,
        actorType: 'player',
        payload: { entry_point: entryPoint },
      })
      // The `bot_active` default status made visible. No `provisioned` flag:
      // resolveBotConfig has not run yet, and the not-provisioned outcome is
      // already recorded by `bot_unavailable`.
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'conversation_assigned_bot',
        conversationId,
        sessionId,
        actorId: ctx.playerId,
        actorType: 'player',
      })
    } else {
      conversationId = existing.id
      if (REOPENABLE_STATUSES.has(existing.status)) {
        const [prior] = await tx
          .select({ assignedAgentId: conversation.assignedAgentId, resolutionSource: conversation.resolutionSource })
          .from(conversation)
          .where(eq(conversation.id, conversationId))
          .limit(1)

        let nextAssignedAgentId: string | null = null
        if (prior?.resolutionSource === 'agent' && prior.assignedAgentId) {
          const [previousOwner] = await tx.select({ status: agent.status }).from(agent).where(eq(agent.id, prior.assignedAgentId)).limit(1)
          nextAssignedAgentId = previousOwner?.status === 'active' ? prior.assignedAgentId : await assignOnHandoff(tx, ctx.workspaceId)
        } else {
          // Bot-resolved (never assigned to anyone), or no resolution_source
          // recorded at all (a `closed` conversation with no bot/agent
          // resolve event behind it — defensive, not expected once this
          // slice ships) — both take the same path.
          nextAssignedAgentId = await assignOnHandoff(tx, ctx.workspaceId)
        }

        await tx
          .update(conversation)
          .set({ status: 'open', assignedAgentId: nextAssignedAgentId, resolutionSource: null })
          .where(eq(conversation.id, conversationId))

        reopening = true

        await appendEvent(tx, {
          workspaceId: ctx.workspaceId,
          type: 'conversation_reopened',
          conversationId,
          // The *reopening* session, deliberately not `conversation.session_id`,
          // which keeps saying where the conversation began.
          sessionId,
          actorId: ctx.playerId,
          actorType: 'player',
          payload: { previous_resolution_source: prior?.resolutionSource ?? null },
        })
        inboxStatus = 'open'
      } else if (existing.status === 'awaiting_player') {
        // The other half of the pair `sendAgentMessage` opens with its
        // `open → awaiting_player` flip: the player has now answered, so support
        // owns the next action again. Deliberately NOT the reopen branch above —
        // clearing assignedAgentId here would dump an actively-handled
        // conversation back into Unassigned, and the agent who asked stays owner.
        await tx.update(conversation).set({ status: 'open' }).where(eq(conversation.id, conversationId))
        await appendEvent(tx, {
          workspaceId: ctx.workspaceId,
          type: 'conversation_player_replied',
          conversationId,
          sessionId,
          actorId: ctx.playerId,
          actorType: 'player',
        })
        inboxStatus = 'open'
      }
    }

    const posted = await postMessage(tx, {
      workspaceId: ctx.workspaceId,
      conversationId,
      authorType: 'player',
      actorId: ctx.playerId,
      sessionId,
      body: body.body,
    })

    // Deliberately after the player's message, not before it: the handoff line
    // is a response to what the player just said, and a lower `seq` rendered it
    // above the message that triggered the reopen — support appearing to answer
    // before anyone had spoken.
    if (reopening) {
      reopenPosted = await postMessage(tx, {
        workspaceId: ctx.workspaceId,
        conversationId,
        authorType: 'system',
        actorId: null,
        body: pickHandoffMessage(),
        visibility: 'public',
      })
    }

    let shouldEnqueue = false
    const [afterPost] = await tx
      .select({ status: conversation.status })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1)

    if (afterPost?.status === 'bot_active') {
      const config = await resolveBotConfig(tx, ctx.workspaceId)
      if (config.isProvisioned) {
        // Part 2 (2026-08-12-bot-turn-async-pipeline.md) enqueues bot-turns here.
        shouldEnqueue = true
      } else {
        await applyBotTurn(tx, { workspaceId: ctx.workspaceId, conversationId }, { kind: 'unavailable', reason: 'not_provisioned' })
        inboxStatus = 'open'
      }
    }

    return { conversationId, posted, reopenPosted, inboxStatus, shouldEnqueue }
  })

  const playerView = toPlayerView(result.posted)
  const agentView = toAgentView(result.posted)
  emitMessageToRooms(getIo(), result.conversationId, playerView, agentView)
  if (result.reopenPosted) {
    emitMessageToRooms(getIo(), result.conversationId, toPlayerView(result.reopenPosted), toAgentView(result.reopenPosted))
  }
  if (result.inboxStatus) {
    emitInboxChanged(getIo(), ctx.workspaceId, result.conversationId, result.inboxStatus)
  }
  if (result.shouldEnqueue) {
    await enqueueBotTurn({ workspaceId: ctx.workspaceId, conversationId: result.conversationId, seq: result.posted.seq })
  }

  return { conversation_id: result.conversationId, message: playerView }
}

/**
 * `session_id` is accepted, validated and then deliberately ignored. It stays
 * required because `BootstrapQuery` is shared with bootstrap and it is the
 * React Query cache key, but it must not gate: the thread is resolved from
 * `ctx.playerId` under RLS, which the player token already grants, so a foreign
 * or unknown session id can never name a foreign conversation. Gating on it
 * turned "your session has not uploaded yet" into a 404 that killed history and
 * the socket join alike — see the 2026-08-13 lifecycle-events design.
 */
export async function getPlayerMessages(
  ctx: PlayerContext,
  _query: { session_id: string },
): Promise<PlayerMessagesResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx
      .select({ id: conversation.id, status: conversation.status, confirmPhase: conversation.confirmPhase })
      .from(conversation)
      .where(eq(conversation.playerId, ctx.playerId))
      .orderBy(desc(conversation.createdAt))
      .limit(1)
    // No conversation means no question on screen — 'none', not undefined, so
    // the banner has one thing to test and never a missing field. `form` follows
    // the same rule for the same reason.
    if (!found) return { conversation_id: null, messages: [], confirm_phase: 'none', form: null }

    const rows = await tx.select().from(message).where(eq(message.conversationId, found.id)).orderBy(message.seq)
    const messages = rows.map(toPlayerView).filter((m): m is PlayerMessageView => m !== null)
    return {
      conversation_id: found.id,
      messages,
      status: found.status,
      confirm_phase: found.confirmPhase,
      form: found.confirmPhase === 'form' ? await loadPlayerForm(tx, found.id) : null,
    }
  })
}

/**
 * Everything the pinned card needs to render from cold. A reconnect mid-form
 * therefore resumes at the right question with earlier answers intact, which is
 * the whole reason the answers are written per step rather than batched at the
 * end.
 *
 * Fields come from the submission's snapshotted version, never the form's
 * current one: a form edited to v2 while a player is on question three must not
 * renumber the card underneath them.
 *
 * Returns null when confirm_phase says 'form' but no live submission exists —
 * the narrow window between a terminate committing and the phase update being
 * observed. A null there renders no card, which is correct.
 */
async function loadPlayerForm(tx: Tx, conversationId: string): Promise<PlayerFormView | null> {
  const [submission] = await tx
    .select({
      id: formSubmission.id,
      formId: formSubmission.formId,
      version: formSubmission.formVersion,
      formName: form.name,
      fields: formVersion.fields,
    })
    .from(formSubmission)
    .innerJoin(form, eq(form.id, formSubmission.formId))
    .innerJoin(
      formVersion,
      and(eq(formVersion.formId, formSubmission.formId), eq(formVersion.version, formSubmission.formVersion)),
    )
    .where(and(eq(formSubmission.conversationId, conversationId), eq(formSubmission.status, 'in_progress')))
    .orderBy(desc(formSubmission.startedAt))
    .limit(1)

  if (!submission) return null

  // The current answer for a field is the row with the greatest created_at for
  // that (form_submission_id, field_key). Older rows are correction history and
  // never reach the player — the card only needs what to prefill.
  const answers = await tx
    .selectDistinctOn([formAnswer.fieldKey], { fieldKey: formAnswer.fieldKey, value: formAnswer.value })
    .from(formAnswer)
    .where(eq(formAnswer.formSubmissionId, submission.id))
    .orderBy(formAnswer.fieldKey, desc(formAnswer.createdAt))

  return {
    submission_id: submission.id,
    form_id: submission.formId,
    form_name: submission.formName,
    version: submission.version,
    fields: [...submission.fields].sort((a, b) => a.position - b.position),
    answers: answers.map((a) => ({ field_key: a.fieldKey, value: a.value })),
  }
}

/**
 * `null` means there is nothing to announce — no conversation, or every message
 * in range was already read. The caller uses that to skip the socket emit.
 */
export type MarkReadResult = { conversationId: string; upToSeq: number; readAt: Date } | null

export async function markPlayerMessagesRead(
  ctx: PlayerContext,
  body: MarkPlayerReadBodyType,
): Promise<MarkReadResult> {
  // One timestamp for the whole batch: every message in this range was seen in
  // the same glance, and a per-row now() would imply an ordering that did not happen.
  const readAt = new Date()

  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    // `orderBy` is load-bearing, not tidiness: a player has more than one
    // conversation the moment they open a second ticket, and an unordered
    // limit(1) let Postgres hand back whichever row it liked — usually the old
    // closed one. The receipt then marked messages in a thread nobody was
    // looking at, and the agent's live thread never turned blue. Same rule as
    // getPlayerMessages/sendPlayerMessage: the latest conversation is the one
    // on screen.
    const [found] = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.playerId, ctx.playerId))
      .orderBy(desc(conversation.createdAt))
      .limit(1)
    if (!found) return null

    const updated = await tx
      .update(message)
      .set({ deliveryState: 'read', readAt })
      .where(
        and(
          eq(message.conversationId, found.id),
          ne(message.authorType, 'player'),
          // Load-bearing: this is what makes read_at first-write-wins. Removing
          // it would let every thread open overwrite the original read time.
          ne(message.deliveryState, 'read'),
          lte(message.seq, body.up_to_seq),
        ),
      )
      .returning({ seq: message.seq })

    if (updated.length === 0) return null
    return { conversationId: found.id, upToSeq: Math.max(...updated.map((r) => r.seq)), readAt }
  })

  if (result) {
    emitReadReceipt(getIo(), 'agents', {
      conversation_id: result.conversationId,
      up_to_seq: result.upToSeq,
      reader_type: 'player',
      read_at: result.readAt.toISOString(),
    })
  }

  return result
}
