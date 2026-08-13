import { and, eq, isNull } from 'drizzle-orm'
import type { BotTurnDecision } from './botTurn.ts'
import { SILENT_UNAVAILABLE_REASONS } from './botTurn.ts'
import { botFailureNote, HANDOFF_PLAYER_MESSAGE } from './messages.ts'
import { assignOnHandoff } from './assignOnHandoff.ts'
import { postMessage, type PostedMessageRow } from '../conversations/postMessage.ts'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import type { Tx } from '../../shared/db/withWorkspace.ts'
import { article, conversation, intent, subintent } from '../../shared/db/schema/index.ts'

export type ApplyBotTurnContext = {
  workspaceId: string
  conversationId: string
}

export type ApplyBotTurnResult = {
  posted: PostedMessageRow[]
  statusChanged: boolean
}

/**
 * The only writer of a bot-turn outcome. One transaction per call — the caller
 * (sendPlayerMessage's not-provisioned branch here; runBotTurn once Part 2
 * lands) owns that transaction via `tx`. Socket emits never happen in here —
 * only after the caller's transaction commits.
 */
export async function applyBotTurn(tx: Tx, ctx: ApplyBotTurnContext, decision: BotTurnDecision): Promise<ApplyBotTurnResult> {
  switch (decision.kind) {
    case 'noop':
      return { posted: [], statusChanged: false }

    case 'answer': {
      const posted = await postMessage(tx, {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        authorType: 'bot',
        actorId: null,
        body: decision.reply,
        visibility: 'public',
      })
      if (decision.subintentId) await classifyIfUnset(tx, ctx, decision.subintentId)
      if (decision.articleId) {
        await tx
          .update(conversation)
          .set({ botPhase: 'article_confirm' })
          .where(eq(conversation.id, ctx.conversationId))
        const [row] = await tx.select({ title: article.title }).from(article).where(eq(article.id, decision.articleId)).limit(1)
        await appendEvent(tx, {
          workspaceId: ctx.workspaceId,
          type: 'bot_article_offered',
          conversationId: ctx.conversationId,
          actorId: null,
          actorType: 'bot',
          payload: { article_id: decision.articleId, article_title: row?.title ?? null },
        })
      }
      return { posted: [posted], statusChanged: false }
    }

    case 'resolve': {
      if (decision.subintentId) await classifyIfUnset(tx, ctx, decision.subintentId)
      await tx
        .update(conversation)
        .set({ status: 'resolved', botPhase: 'none', resolutionSource: 'bot' })
        .where(eq(conversation.id, ctx.conversationId))
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'conversation_resolved',
        conversationId: ctx.conversationId,
        actorId: null,
        actorType: 'bot',
        payload: { source: 'bot', confirmed_by: 'player' },
      })
      return { posted: [], statusChanged: true }
    }

    case 'handoff': {
      const posted = await postMessage(tx, {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        authorType: 'system',
        actorId: null,
        body: HANDOFF_PLAYER_MESSAGE,
        visibility: 'public',
      })
      if (decision.subintentId) await classifyIfUnset(tx, ctx, decision.subintentId)
      const assignedAgentId = await assignOnHandoff(tx, ctx.workspaceId)
      await tx
        .update(conversation)
        .set({ status: 'open', botPhase: 'none', assignedAgentId })
        .where(eq(conversation.id, ctx.conversationId))
      if (decision.reason === 'article_rejected') {
        await appendEvent(tx, {
          workspaceId: ctx.workspaceId,
          type: 'bot_article_rejected',
          conversationId: ctx.conversationId,
          actorId: null,
          actorType: 'bot',
          payload: {},
        })
      }
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'bot_handoff',
        conversationId: ctx.conversationId,
        actorId: null,
        actorType: 'bot',
        // `null` is legitimate: assignOnHandoff returns null when no active
        // agent exists, and that is explicitly not an error.
        payload: { reason: decision.reason, assigned_agent_id: assignedAgentId },
      })
      return { posted: [posted], statusChanged: true }
    }

    case 'unavailable': {
      const posted = [
        await postMessage(tx, {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          authorType: 'system',
          actorId: null,
          body: HANDOFF_PLAYER_MESSAGE,
          visibility: 'public',
        }),
      ]
      if (!SILENT_UNAVAILABLE_REASONS.has(decision.reason)) {
        posted.push(
          await postMessage(tx, {
            workspaceId: ctx.workspaceId,
            conversationId: ctx.conversationId,
            authorType: 'system',
            actorId: null,
            body: botFailureNote(decision.reason),
            visibility: 'internal',
          }),
        )
      }
      const assignedAgentId = await assignOnHandoff(tx, ctx.workspaceId)
      await tx
        .update(conversation)
        .set({ status: 'open', botPhase: 'none', assignedAgentId })
        .where(eq(conversation.id, ctx.conversationId))
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'bot_unavailable',
        conversationId: ctx.conversationId,
        actorId: null,
        actorType: 'bot',
        payload: { reason: decision.reason },
      })
      return { posted, statusChanged: true }
    }
  }
}

/**
 * Written once: only when subintent_id IS NULL. A second bot turn does not get
 * to reclassify — reclassification is the agent console's `intent_corrected`.
 * Snapshots both names as literals so a later rename does not rewrite history.
 *
 * Uses Drizzle's `and()` combinator, not JS `&&`, to combine the two `where`
 * conditions — `eq(...) && isNull(...)` would evaluate to the second operand
 * and silently drop the first, which would let this write run unconditionally.
 */
async function classifyIfUnset(tx: Tx, ctx: ApplyBotTurnContext, subintentId: string): Promise<void> {
  const updated = await tx
    .update(conversation)
    .set({ subintentId, classificationSource: 'bot' })
    .where(and(eq(conversation.id, ctx.conversationId), isNull(conversation.subintentId)))
    .returning({ id: conversation.id })

  if (updated.length === 0) return

  const [names] = await tx
    .select({ subintentName: subintent.name, intentName: intent.name })
    .from(subintent)
    .innerJoin(intent, eq(intent.id, subintent.intentId))
    .where(eq(subintent.id, subintentId))
    .limit(1)

  await appendEvent(tx, {
    workspaceId: ctx.workspaceId,
    type: 'intent_set',
    conversationId: ctx.conversationId,
    actorId: null,
    actorType: 'bot',
    payload: { source: 'bot', subintent_name: names?.subintentName ?? null, intent_name: names?.intentName ?? null },
  })
}
