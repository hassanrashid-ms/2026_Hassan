import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCallModel, mockSearchArticleIds } = vi.hoisted(() => ({
  mockCallModel: vi.fn(),
  mockSearchArticleIds: vi.fn(),
}))

vi.mock('../src/domain/bot/openaiClient.ts', () => ({
  callModel: mockCallModel,
  ModelTimeoutError: class ModelTimeoutError extends Error {},
  ModelRefusalError: class ModelRefusalError extends Error {},
}))

vi.mock('../src/shared/weaviate/articlesIndex.ts', () => ({
  searchArticleIds: mockSearchArticleIds,
}))

import { closeDb } from '../src/shared/db/client.ts'
import type { BotTurnInput } from '../src/domain/bot/botTurn.ts'
import { toolLoopDecider, MAX_TOOL_CALLS_PER_TURN, MAX_BOT_MESSAGES } from '../src/domain/bot/toolLoop.ts'
import { ModelRefusalError, ModelTimeoutError } from '../src/domain/bot/openaiClient.ts'
import { closeOwnerPool, ownerPool, seedConversation, seedIntent, seedPlayer, seedSubintent, seedWorkspace, truncateAll } from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)
beforeEach(() => {
  mockCallModel.mockReset()
  mockSearchArticleIds.mockReset()
  mockSearchArticleIds.mockResolvedValue([])
})

function baseInput(overrides: Partial<BotTurnInput> & { workspaceId: string; conversationId: string }): BotTurnInput {
  return {
    subintentId: null,
    confirmPhase: 'none',
    botMessageCount: 0,
    lastPlayerMessageAt: null,
    history: [],
    ...overrides,
  }
}

async function fixture() {
  const workspaceId = await seedWorkspace()
  const playerId = await seedPlayer(workspaceId)
  const conversationId = await seedConversation({ workspaceId, playerId })
  return { workspaceId, conversationId }
}

async function seedArticle(workspaceId: string, overrides: Partial<{ title: string; body: string; state: string; intentId: string | null }> = {}) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'A') returning id`,
    [`a-${Math.random().toString(36).slice(2)}@example.test`],
  )
  const agentId = rows[0]!.id
  const { rows: articleRows } = await ownerPool.query<{ id: string }>(
    `insert into article (workspace_id, intent_id, title, body, state, created_by, published_at)
     values ($1, $2, $3, $4, $5::article_state, $6, case when $5::text = 'published' then now() else null end) returning id`,
    [
      workspaceId,
      overrides.intentId ?? null,
      overrides.title ?? 'How to reset your password',
      overrides.body ?? 'Go to settings and tap reset.',
      overrides.state ?? 'published',
      agentId,
    ],
  )
  return articleRows[0]!.id
}

describe('toolLoopDecider', () => {
  it('a greeting with no tool call produces one bot message, no classification, no event', async () => {
    const { workspaceId, conversationId } = await fixture()
    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'Hi! How can I help?' })
    const input = baseInput({ workspaceId, conversationId })
    const decision = await toolLoopDecider(input)
    expect(decision).toEqual({ kind: 'answer', reply: 'Hi! How can I help?', subintentId: null })
  })

  it('search_articles then offer_article produces answer with articleId and would set bot_article', async () => {
    const { workspaceId, conversationId } = await fixture()
    const articleId = await seedArticle(workspaceId, { title: 'Refund policy' })
    mockSearchArticleIds.mockResolvedValueOnce([articleId])

    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 't1', name: 'search_articles', arguments: '{"query":"refund"}' }],
      text: null,
    })
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 't2', name: 'offer_article', arguments: `{"article_id":"${articleId}"}` }],
      text: null,
    })

    const input = baseInput({ workspaceId, conversationId })
    const decision = await toolLoopDecider(input)
    expect(decision).toEqual({ kind: 'answer', reply: "Here's an article that might help.", subintentId: null, articleId })
  })

  it('offer_article with an id not returned by search_articles this turn is rejected and the loop continues', async () => {
    const { workspaceId, conversationId } = await fixture()

    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 't1', name: 'offer_article', arguments: '{"article_id":"never-searched"}' }],
      text: null,
    })
    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'ok, anything else?' })

    const input = baseInput({ workspaceId, conversationId })
    const decision = await toolLoopDecider(input)
    expect(decision).toEqual({ kind: 'answer', reply: 'ok, anything else?', subintentId: null })
    expect(mockCallModel).toHaveBeenCalledTimes(2)
  })

  it('classify twice in one turn resolves once; the second call is ignored', async () => {
    const { workspaceId, conversationId } = await fixture()
    const intentId = await seedIntent(workspaceId, 'Billing')
    const subintentIdA = await seedSubintent({ workspaceId, intentId, name: 'A Refund' })
    await seedSubintent({ workspaceId, intentId, name: 'B Missing item' })

    mockCallModel.mockResolvedValueOnce({ toolCalls: [{ id: 't1', name: 'classify', arguments: '{"subintent_index":0}' }], text: null })
    mockCallModel.mockResolvedValueOnce({ toolCalls: [{ id: 't2', name: 'classify', arguments: '{"subintent_index":1}' }], text: null })
    mockCallModel.mockResolvedValueOnce({ toolCalls: [{ id: 't3', name: 'handoff', arguments: '{"reason":"asked_for_person"}' }], text: null })

    const input = baseInput({ workspaceId, conversationId })
    const decision = await toolLoopDecider(input)
    expect(decision).toEqual({ kind: 'handoff', reason: 'asked_for_person', subintentId: subintentIdA })
  })

  it('handoff from a turn where classify was never called leaves subintentId null', async () => {
    const { workspaceId, conversationId } = await fixture()
    mockCallModel.mockResolvedValueOnce({ toolCalls: [{ id: 't1', name: 'handoff', arguments: '{"reason":"asked_for_person"}' }], text: null })
    const input = baseInput({ workspaceId, conversationId })
    const decision = await toolLoopDecider(input)
    expect(decision).toEqual({ kind: 'handoff', reason: 'asked_for_person', subintentId: null })
  })

  it('confirm_resolution is absent from the tool set when confirm_phase is none, present when bot_article', async () => {
    const { workspaceId, conversationId } = await fixture()
    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'ok' })
    const input = baseInput({ workspaceId, conversationId, confirmPhase: 'none' })
    await toolLoopDecider(input)
    const toolNames = mockCallModel.mock.calls[0]![1].map((t: any) => t.function.name)
    expect(toolNames).not.toContain('confirm_resolution')

    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'ok' })
    const input2 = baseInput({ workspaceId, conversationId, confirmPhase: 'bot_article' })
    await toolLoopDecider(input2)
    const toolNames2 = mockCallModel.mock.calls[1]![1].map((t: any) => t.function.name)
    expect(toolNames2).toContain('confirm_resolution')
  })

  it('a model that calls search_articles forever stops at 4 tool calls and returns handoff(unsure)', async () => {
    const { workspaceId, conversationId } = await fixture()
    mockCallModel.mockResolvedValue({ toolCalls: [{ id: 't', name: 'search_articles', arguments: '{"query":"x"}' }], text: null })
    const input = baseInput({ workspaceId, conversationId })
    const decision = await toolLoopDecider(input)
    expect(decision).toEqual({ kind: 'handoff', reason: 'unsure', subintentId: null })
    expect(mockCallModel).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_TURN)
  })

  it('with 8 bot messages present, callModel is never called and the result is handoff(turn_cap)', async () => {
    const { workspaceId, conversationId } = await fixture()
    const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId, botMessageCount: MAX_BOT_MESSAGES }))
    expect(decision).toEqual({ kind: 'handoff', reason: 'turn_cap', subintentId: null })
    expect(mockCallModel).not.toHaveBeenCalled()
  })

  it('a refusal produces invalid_response and is not retried (throws once, caller does not catch-and-retry internally)', async () => {
    const { workspaceId, conversationId } = await fixture()
    mockCallModel.mockRejectedValueOnce(new ModelRefusalError('nope'))
    const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId }))
    expect(decision).toEqual({ kind: 'unavailable', reason: 'invalid_response' })
    expect(mockCallModel).toHaveBeenCalledTimes(1)
  })

  it('an unparseable tool argument produces invalid_response', async () => {
    const { workspaceId, conversationId } = await fixture()
    mockCallModel.mockResolvedValueOnce({ toolCalls: [{ id: 't', name: 'classify', arguments: '{not json' }], text: null })
    const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId }))
    expect(decision).toEqual({ kind: 'unavailable', reason: 'invalid_response' })
  })

  it('a network error throws rather than returning unavailable', async () => {
    const { workspaceId, conversationId } = await fixture()
    mockCallModel.mockRejectedValueOnce(new Error('ECONNRESET'))
    await expect(toolLoopDecider(baseInput({ workspaceId, conversationId }))).rejects.toThrow('ECONNRESET')
  })

  it('a timeout throws rather than returning unavailable', async () => {
    const { workspaceId, conversationId } = await fixture()
    mockCallModel.mockRejectedValueOnce(new ModelTimeoutError())
    await expect(toolLoopDecider(baseInput({ workspaceId, conversationId }))).rejects.toThrow(ModelTimeoutError)
  })

  it('confirm_resolution(true) exits resolve', async () => {
    const { workspaceId, conversationId } = await fixture()
    mockCallModel.mockResolvedValueOnce({ toolCalls: [{ id: 't', name: 'confirm_resolution', arguments: '{"helped":true}' }], text: null })
    const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId, confirmPhase: 'bot_article' }))
    expect(decision).toEqual({ kind: 'resolve', subintentId: null })
  })

  it('confirm_resolution(false) exits handoff(article_rejected)', async () => {
    const { workspaceId, conversationId } = await fixture()
    mockCallModel.mockResolvedValueOnce({ toolCalls: [{ id: 't', name: 'confirm_resolution', arguments: '{"helped":false}' }], text: null })
    const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId, confirmPhase: 'bot_article' }))
    expect(decision).toEqual({ kind: 'handoff', reason: 'article_rejected', subintentId: null })
  })
})
