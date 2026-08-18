import { and, eq, isNull } from 'drizzle-orm'
import type { BotTurnDecision } from './botTurn.ts'
import { SILENT_UNAVAILABLE_REASONS } from './botTurn.ts'
import { botFailureNote, pickHandoffMessage } from './messages.ts'
import { assignOnHandoff } from './assignOnHandoff.ts'
import { postMessage, type PostedMessageRow } from '../conversations/postMessage.ts'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import type { Tx } from '../../shared/db/withWorkspace.ts'
import { article, conversation, formSubmission, intent, subintent } from '../../shared/db/schema/index.ts'
import { resolveSubintentForm } from '../forms/resolveSubintentForm.ts'
import type { ConfirmPhaseValue } from '@support/types'

export type ApplyBotTurnContext = {
  workspaceId: string
  conversationId: string
}

export type ApplyBotTurnResult = {
  posted: PostedMessageRow[]
  statusChanged: boolean
  /**
   * Non-null only when this turn moved confirm_phase in a way a client must be
   * told about out of band. Today that is exactly one case: the form offer,
   * which changes no status and so triggers no other refetch on the agent side.
   * Every other branch returns null deliberately — adding an emit to a path
   * that never had one is a behaviour change, and the no-form handoff must stay
   * byte-identical.
   */
  phaseChanged: ConfirmPhaseValue | null
}

/**
 * The only writer of a bot-turn outcome. One transaction per call — the caller
 * (sendPlayerMessage's not-provisioned branch here; runBotTurn once Part 2
 * lands) owns that transaction via `tx`. Socket emits never happen in here —
 * only after the caller's transaction commits.
 */
export async function applyBotTurn(tx: Tx, ctx: ApplyBotTurnContext, decision: BotTurnDecision): Promise<ApplyBotTurnResult> {
  await appendSearchEvents(tx, ctx, decision)

  switch (decision.kind) {
    case 'noop':
      return { posted: [], statusChanged: false, phaseChanged: null }

    case 'answer': {
      const posted = await postMessage(tx, {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        authorType: 'bot',
        actorId: null,
        body: decision.reply,
        articleId: decision.articleId ?? null,
        visibility: 'public',
      })
      if (decision.subintentId) await classifyIfUnset(tx, ctx, decision.subintentId)
      if (decision.articleId) {
        await tx
          .update(conversation)
          .set({ confirmPhase: 'bot_article' })
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
      return { posted: [posted], statusChanged: false, phaseChanged: null }
    }

    case 'resolve': {
      if (decision.subintentId) await classifyIfUnset(tx, ctx, decision.subintentId)
      await tx
        .update(conversation)
        .set({ status: 'resolved', confirmPhase: 'none', resolutionSource: 'bot' })
        .where(eq(conversation.id, ctx.conversationId))
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'conversation_resolved',
        conversationId: ctx.conversationId,
        actorId: null,
        actorType: 'bot',
        payload: { source: 'bot', confirmed_by: 'player' },
      })
      return { posted: [], statusChanged: true, phaseChanged: null }
    }

    case 'handoff': {
      const posted = await postMessage(tx, {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        authorType: 'system',
        actorId: null,
        body: pickHandoffMessage(),
        visibility: 'public',
      })
      if (decision.subintentId) await classifyIfUnset(tx, ctx, decision.subintentId)

      // The offer branch. Everything after this block is today's behaviour,
      // untouched — a subintent with no published form falls straight through.
      //
      // `asked_for_person` is excluded explicitly: the product spec requires an
      // immediate redirect to an agent, and four questions in front of someone
      // who just asked for a human is the behaviour that rule forbids. The other
      // two exclusions need no special case — `turn_cap` carries a null
      // subintent, and `unavailable` is a different decision kind entirely.
      if (decision.subintentId && decision.reason !== 'asked_for_person') {
        const resolved = await resolveSubintentForm(tx, decision.subintentId)
        if (resolved) {
          await tx.insert(formSubmission).values({
            workspaceId: ctx.workspaceId,
            conversationId: ctx.conversationId,
            formId: resolved.formId,
            formVersion: resolved.version,
          })
          await tx
            .update(conversation)
            .set({ confirmPhase: 'form' })
            .where(eq(conversation.id, ctx.conversationId))

          // Written here rather than deferred to terminate: it records why the
          // handoff happened, which is a fact about this turn. A form the player
          // abandons would otherwise lose the record of the rejection entirely.
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

          // `handoff_reason` is here because `bot_handoff` still has to carry it
          // at terminate, and by then the decision is gone and no column holds
          // it. A snapshot in the event that explains the offer is this repo's
          // mechanism for exactly that.
          await appendEvent(tx, {
            workspaceId: ctx.workspaceId,
            type: 'form_offered',
            conversationId: ctx.conversationId,
            actorId: null,
            actorType: 'bot',
            payload: {
              form_id: resolved.formId,
              form_version: resolved.version,
              field_count: resolved.fields.length,
              handoff_reason: decision.reason,
            },
          })

          // Status stays bot_active, no agent is assigned, and no bot_handoff is
          // written. completeFormAndHandoff does all three at terminate — that
          // gate is what keeps a half-filled ticket out of the queue.
          return { posted: [posted], statusChanged: false, phaseChanged: 'form' }
        }
      }

      const assignedAgentId = await assignOnHandoff(tx, ctx.workspaceId)
      await tx
        .update(conversation)
        .set({ status: 'open', confirmPhase: 'none', assignedAgentId })
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
      return { posted: [posted], statusChanged: true, phaseChanged: null }
    }

    case 'unavailable': {
      const posted = [
        await postMessage(tx, {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          authorType: 'system',
          actorId: null,
          body: pickHandoffMessage(),
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
        .set({ status: 'open', confirmPhase: 'none', assignedAgentId })
        .where(eq(conversation.id, ctx.conversationId))
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'bot_unavailable',
        conversationId: ctx.conversationId,
        actorId: null,
        actorType: 'bot',
        payload: { reason: decision.reason },
      })
      return { posted, statusChanged: true, phaseChanged: null }
    }
  }
}

/**
 * One `bot_search` per `search_articles` call the model made, written before the
 * outcome events so the timeline reads in the order it happened: what the bot
 * looked for, then what it did about it.
 *
 * Written for every decision kind, including `handoff` and `unavailable`. A
 * handoff that searched first and a handoff that never searched at all are the
 * same row in `conversation` and produced the same `bot_handoff` event, and
 * telling them apart is the whole point — "the bot ignored the knowledge base"
 * and "the knowledge base has no answer" are different problems with different
 * fixes.
 *
 * Titles come from the decision's snapshot, not a join: the search happened
 * before this transaction, and re-resolving the ids here would record what the
 * articles are called now rather than what the model was actually shown.
 */
async function appendSearchEvents(tx: Tx, ctx: ApplyBotTurnContext, decision: BotTurnDecision): Promise<void> {
  for (const search of decision.searches ?? []) {
    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'bot_search',
      conversationId: ctx.conversationId,
      actorId: null,
      actorType: 'bot',
      payload: {
        query: search.query,
        result_count: search.results.length,
        articles: search.results.map((r) => ({ article_id: r.id, article_title: r.title })),
      },
    })
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
