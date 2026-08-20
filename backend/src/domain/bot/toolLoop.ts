// backend/src/domain/bot/toolLoop.ts
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { BotDecider, BotSearchRecord, BotTurnDecision, HandoffReason } from './botTurn.ts'
import { logger } from '../../shared/logging/logger.ts'
import { buildMessages, type ChatMessage } from './contextAssembly.ts'
import { callModel, ModelRefusalError, ModelTimeoutError } from './openaiClient.ts'
import { isGrounded, MIN_GROUNDED_FRACTION, scoreGrounding } from './grounding.ts'
import {
  ANSWER_FROM_ARTICLE_TOOL_NAME,
  CONFIRM_RESOLUTION_TOOL_NAME,
  resolveClassifyIndex,
  searchArticles,
  toolsForPhase,
  type SearchArticlesResult,
} from './tools.ts'
import { resolveFallbackSubintent } from './fallbackSubintent.ts'

/**
 * Six, not the original four. The happy path is `classify` → `search_articles`
 * → `answer_from_article`, which fits in four — but only if the model spends every
 * call perfectly. Once the prompt required a search before concluding no
 * article answers, a turn that classifies twice, or searches twice before
 * committing, hit the ceiling and fell through to `handoff('unsure')` — a
 * handoff caused by the budget rather than by the question, on a conversation
 * an article would have answered. Observed on a purchase question that had a
 * published article behind it.
 *
 * Still a hard runaway guard, and still well under `resolvedLimits.max_articles_per_turn * 2`:
 * the point is to bound a loop, not to force the model to be economical. The
 * `bot.tool` log line records `n/<max_tool_calls_per_turn>` per call, so a turn
 * that exhausts this is visible rather than inferred.
 */

const MODEL_HANDOFF_REASONS: ReadonlySet<string> = new Set(['asked_for_person', 'no_article', 'sensitive'])

type ParsedToolCall = { id: string; name: string; args: Record<string, unknown> }

class InvalidResponseError extends Error {}

function parseToolCall(raw: { id: string; name: string; arguments: string }): ParsedToolCall {
  let args: unknown
  try {
    args = JSON.parse(raw.arguments)
  } catch {
    throw new InvalidResponseError(`unparseable arguments for ${raw.name}`)
  }
  if (typeof args !== 'object' || args === null) throw new InvalidResponseError(`non-object arguments for ${raw.name}`)
  return { id: raw.id, name: raw.name, args: args as Record<string, unknown> }
}

/**
 * The real BotDecider (spec 4). Never writes — returns a BotTurnDecision for
 * applyBotTurn to write in one transaction. A throw here (network error,
 * timeout) propagates to BullMQ, which retries once; ModelRefusalError and an
 * unparseable tool argument map to `invalid_response` and are swallowed here
 * (not retried — a deterministic input that produced a refusal will produce
 * it again, per spec's Control flow section).
 */
export const toolLoopDecider: BotDecider = async (input) => {
  // Declared outside the try so the catch below can still attach whatever
  // retrieval happened before the model refused or returned something
  // unparseable. A turn that searched and *then* failed is the case where
  // knowing what it searched for matters most.
  const searches: BotSearchRecord[] = []

  try {
    const decision = await withWorkspace(input.workspaceId, async (tx): Promise<BotTurnDecision> => {
      const { messages, subintentOptions, enabledTools, resolvedLimits } = await buildMessages(tx, input)

      // Evaluated before the turn_cap check — whichever ceiling is lower fires
      // first, and max_unhelped_replies defaults lower (3) than max_bot_messages
      // (8), so it is expected to fire first under default config.
      if (input.unhelpedReplyCount >= resolvedLimits.max_unhelped_replies) {
        return { kind: 'handoff', reason: 'unhelped_cap', subintentId: null }
      }
      if (input.botMessageCount >= resolvedLimits.max_bot_messages) {
        return { kind: 'handoff', reason: 'turn_cap', subintentId: null }
      }

      let classifiedSubintentId = input.subintentId
      // Keyed by id and holding the text, not just the ids: answering from an
      // article means the article's own words have to be checkable at the
      // moment the answer is produced, against the exact rows this turn saw.
      const searchedArticles = new Map<string, { title: string; body: string }>()
      // Snapshotted from the assembled context before the loop starts, so it
      // holds the player's messages and their state block and nothing the loop
      // later appends. An answer is allowed to speak the player's own terms —
      // that is what "aligned to their problem" means — but not the terms of an
      // article it did not cite.
      const playerWords = messages.filter((m) => m.role === 'user').map((m) => m.content)
      let searchCallCount = 0
      let toolCallCount = 0
      const conversationMessages: ChatMessage[] = [...messages]

      while (toolCallCount < resolvedLimits.max_tool_calls_per_turn) {
        const availableTools = toolsForPhase(input.confirmPhase, enabledTools)
        const response = await callModel(conversationMessages, availableTools, {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          confirmPhase: input.confirmPhase,
          iteration: toolCallCount + 1,
          // Tool definitions are deliberately not sent as metadata: they contain
          // verbose schemas and are already captured with the generation input.
          enabledToolNames: [...enabledTools].sort(),
        })

        if (response.toolCalls.length === 0) {
          // No tool call and nothing to say is not an answer — it is the model
          // failing to take a turn. `response.text ?? ''` used to post that
          // straight through as a `bot` message, which is how empty bubbles
          // reached players. Treated as a malformed response, same as a refusal
          // or unparseable arguments: the player gets the handoff line and the
          // agent gets an internal note saying the bot could not respond, which
          // is exactly what happened.
          const reply = response.text?.trim()
          if (!reply) throw new InvalidResponseError('model returned neither a tool call nor any text')
          return { kind: 'answer', reply, subintentId: classifiedSubintentId }
        }

        for (const raw of response.toolCalls) {
          if (toolCallCount >= resolvedLimits.max_tool_calls_per_turn) {
            return { kind: 'handoff', reason: 'unsure', subintentId: classifiedSubintentId }
          }
          toolCallCount++

          const call = parseToolCall(raw)

          // The turn's spend, call by call. A budget-forced handoff('unsure')
          // records only that the turn ran out — this is what says *on what*,
          // which is the difference between "the budget is too tight" and "the
          // model looped on one tool".
          logger.info('bot.tool', call.name, {
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            call: `${toolCallCount}/${resolvedLimits.max_tool_calls_per_turn}`,
            args: call.args,
          })

          if (call.name === 'search_articles') {
            searchCallCount++
            if (searchCallCount > resolvedLimits.max_articles_per_turn) {
              conversationMessages.push({ role: 'user', content: '[search_articles limit reached this turn]' })
              continue
            }
            const query = call.args.query
            if (typeof query !== 'string') throw new InvalidResponseError('search_articles missing query')
            const results: SearchArticlesResult = await searchArticles(tx, input.workspaceId, query)
            for (const r of results) searchedArticles.set(r.id, { title: r.title, body: r.body })
            searches.push({ query, results: results.map((r) => ({ id: r.id, title: r.title })) })
            logger.info('bot.search', 'search_articles', {
              workspaceId: input.workspaceId,
              conversationId: input.conversationId,
              query,
              resultCount: results.length,
              titles: results.map((r) => r.title),
            })
            conversationMessages.push({ role: 'assistant', content: `[search_articles("${query}")]` })
            conversationMessages.push({ role: 'user', content: JSON.stringify(results.map((r) => ({ id: r.id, title: r.title, body: r.body }))) })
            continue
          }

          if (call.name === 'classify') {
            const index = call.args.subintent_index
            if (typeof index !== 'number') throw new InvalidResponseError('classify missing subintent_index')
            conversationMessages.push({ role: 'assistant', content: `[classify(${index})]` })
            if (classifiedSubintentId === null) {
              const resolved = resolveClassifyIndex(subintentOptions, index)
              classifiedSubintentId = resolved ? resolved.subintentId : await resolveFallbackSubintent(tx, input.workspaceId)
              conversationMessages.push({ role: 'user', content: '[acknowledged]' })
            } else {
              conversationMessages.push({ role: 'user', content: '[rejected: already classified this conversation — classify is write-once, do not call it again]' })
            }
            continue
          }

          if (call.name === ANSWER_FROM_ARTICLE_TOOL_NAME) {
            const articleId = call.args.article_id
            const answer = call.args.answer
            if (typeof articleId !== 'string') throw new InvalidResponseError(`${ANSWER_FROM_ARTICLE_TOOL_NAME} missing article_id`)
            if (typeof answer !== 'string') throw new InvalidResponseError(`${ANSWER_FROM_ARTICLE_TOOL_NAME} missing answer`)

            const cited = searchedArticles.get(articleId)
            if (!cited) {
              conversationMessages.push({ role: 'assistant', content: `[${ANSWER_FROM_ARTICLE_TOOL_NAME}(${articleId})]` })
              conversationMessages.push({ role: 'user', content: '[rejected: article_id was not returned by search_articles this turn]' })
              continue
            }

            const reply = answer.trim()
            // Same rule as a text-only response: a tool call that produces no
            // words still owes the player a message, and an empty one is a blank
            // bubble that records no failure anywhere.
            if (!reply) throw new InvalidResponseError(`${ANSWER_FROM_ARTICLE_TOOL_NAME} returned an empty answer`)

            // Scored against the cited article and the player's own words only —
            // deliberately NOT conversationMessages, which by now contains every
            // other article the turn retrieved. Widening it to those would let an
            // answer assembled from a different article pass while citing this
            // one, which is the exact provenance the check exists to establish.
            const grounding = scoreGrounding(reply, [cited.title, cited.body, ...playerWords])
            if (!isGrounded(grounding)) {
              logger.warn('bot.grounding', 'answer not grounded in the cited article — rejected', {
                workspaceId: input.workspaceId,
                conversationId: input.conversationId,
                articleId,
                articleTitle: cited.title,
                score: Number(grounding.score.toFixed(2)),
                threshold: MIN_GROUNDED_FRACTION,
                ungrounded: grounding.ungrounded,
              })
              conversationMessages.push({ role: 'assistant', content: `[${ANSWER_FROM_ARTICLE_TOOL_NAME}(${articleId})]` })
              // Naming the offending words rather than restating the rule: the
              // model has already read the rule and produced this anyway, so the
              // useful correction is which words it has to drop.
              conversationMessages.push({
                role: 'user',
                content: `[rejected: the answer must use the article's own wording. These words appear neither in the article nor in what the player wrote: ${grounding.ungrounded.join(', ')}. Rewrite using only the article's sentences, or hand off if the article does not answer them.]`,
              })
              continue
            }

            logger.info('bot.grounding', 'answered from article', {
              workspaceId: input.workspaceId,
              conversationId: input.conversationId,
              articleId,
              articleTitle: cited.title,
              score: Number(grounding.score.toFixed(2)),
            })
            return { kind: 'answer', reply, subintentId: classifiedSubintentId, articleId }
          }

          if (call.name === CONFIRM_RESOLUTION_TOOL_NAME) {
            const helped = call.args.helped
            if (typeof helped !== 'boolean') throw new InvalidResponseError('confirm_resolution missing helped')
            return helped
              ? { kind: 'resolve', subintentId: classifiedSubintentId }
              : { kind: 'handoff', reason: 'article_rejected', subintentId: classifiedSubintentId }
          }

          if (call.name === 'handoff') {
            const reason = call.args.reason
            if (typeof reason !== 'string' || !MODEL_HANDOFF_REASONS.has(reason)) throw new InvalidResponseError('handoff missing/invalid reason')
            return { kind: 'handoff', reason: reason as HandoffReason, subintentId: classifiedSubintentId }
          }

          throw new InvalidResponseError(`unknown tool ${call.name}`)
        }
      }

      return { kind: 'handoff', reason: 'unsure', subintentId: classifiedSubintentId }
    })

    // Attached once here rather than on each of the loop's exit paths, so a new
    // `return` inside the loop cannot silently lose the turn's retrieval record.
    return withSearches(decision, searches)
  } catch (err) {
    if (err instanceof ModelRefusalError || err instanceof InvalidResponseError) {
      return withSearches({ kind: 'unavailable', reason: 'invalid_response' }, searches)
    }
    throw err
  }
}

/** Omits the key entirely when nothing was searched, so an absent field always
 *  means "no retrieval ran" and never "ran and found nothing". */
function withSearches(decision: BotTurnDecision, searches: BotSearchRecord[]): BotTurnDecision {
  return searches.length > 0 ? { ...decision, searches } : decision
}
