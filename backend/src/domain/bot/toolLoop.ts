// backend/src/domain/bot/toolLoop.ts
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { BotDecider, BotTurnDecision, HandoffReason } from './botTurn.ts'
import { buildMessages, type ChatMessage } from './contextAssembly.ts'
import { callModel, ModelRefusalError, ModelTimeoutError } from './openaiClient.ts'
import {
  CONFIRM_RESOLUTION_TOOL_NAME,
  MAX_ARTICLES_PER_TURN,
  resolveClassifyIndex,
  searchArticles,
  toolsForPhase,
  type SearchArticlesResult,
} from './tools.ts'
import { resolveFallbackSubintent } from './fallbackSubintent.ts'

export const MAX_TOOL_CALLS_PER_TURN = 4
export const MAX_BOT_MESSAGES = 8

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
  if (input.botMessageCount >= MAX_BOT_MESSAGES) {
    return { kind: 'handoff', reason: 'turn_cap', subintentId: null }
  }

  try {
    return await withWorkspace(input.workspaceId, async (tx): Promise<BotTurnDecision> => {
      const { messages, subintentOptions } = await buildMessages(tx, input)

      let classifiedSubintentId = input.subintentId
      const searchedArticleIds = new Set<string>()
      let searchCallCount = 0
      let toolCallCount = 0
      const conversationMessages: ChatMessage[] = [...messages]

      while (toolCallCount < MAX_TOOL_CALLS_PER_TURN) {
        const response = await callModel(conversationMessages, toolsForPhase(input.botPhase))

        if (response.toolCalls.length === 0) {
          return { kind: 'answer', reply: response.text ?? '', subintentId: classifiedSubintentId }
        }

        for (const raw of response.toolCalls) {
          if (toolCallCount >= MAX_TOOL_CALLS_PER_TURN) {
            return { kind: 'handoff', reason: 'unsure', subintentId: classifiedSubintentId }
          }
          toolCallCount++

          const call = parseToolCall(raw)

          if (call.name === 'search_articles') {
            searchCallCount++
            if (searchCallCount > MAX_ARTICLES_PER_TURN) {
              conversationMessages.push({ role: 'user', content: '[search_articles limit reached this turn]' })
              continue
            }
            const query = call.args.query
            if (typeof query !== 'string') throw new InvalidResponseError('search_articles missing query')
            const results: SearchArticlesResult = await searchArticles(tx, input.workspaceId, query)
            for (const r of results) searchedArticleIds.add(r.id)
            conversationMessages.push({ role: 'assistant', content: `[search_articles("${query}")]` })
            conversationMessages.push({ role: 'user', content: JSON.stringify(results.map((r) => ({ id: r.id, title: r.title, body: r.body }))) })
            continue
          }

          if (call.name === 'classify') {
            const index = call.args.subintent_index
            if (typeof index !== 'number') throw new InvalidResponseError('classify missing subintent_index')
            if (classifiedSubintentId === null) {
              const resolved = resolveClassifyIndex(subintentOptions, index)
              classifiedSubintentId = resolved ? resolved.subintentId : await resolveFallbackSubintent(tx, input.workspaceId)
            }
            conversationMessages.push({ role: 'assistant', content: `[classify(${index})]` })
            conversationMessages.push({ role: 'user', content: '[acknowledged]' })
            continue
          }

          if (call.name === 'offer_article') {
            const articleId = call.args.article_id
            if (typeof articleId !== 'string') throw new InvalidResponseError('offer_article missing article_id')
            if (!searchedArticleIds.has(articleId)) {
              conversationMessages.push({ role: 'assistant', content: `[offer_article(${articleId})]` })
              conversationMessages.push({ role: 'user', content: '[rejected: article_id was not returned by search_articles this turn]' })
              continue
            }
            return { kind: 'answer', reply: "Here's an article that might help.", subintentId: classifiedSubintentId, articleId }
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
  } catch (err) {
    if (err instanceof ModelRefusalError || err instanceof InvalidResponseError) {
      return { kind: 'unavailable', reason: 'invalid_response' }
    }
    throw err
  }
}
