import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { toolLoopDecider } from '../src/domain/bot/toolLoop.ts'
import * as openaiClient from '../src/domain/bot/openaiClient.ts'
import { saveBotConfig } from '../src/domain/bot/botConfig.ts'
import { buildBaselineToolsConfig } from '../src/domain/bot/tools.ts'
import { buildBaselineLimits } from '../src/domain/bot/limitsCatalog.ts'
import { closeOwnerPool, seedAgent, seedConversation, seedMessage, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('toolLoopDecider — deterministic tool gating', () => {
  let workspaceId: string
  let conversationId: string

  beforeEach(async () => {
    await truncateAll()
    workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    conversationId = await seedConversation({ workspaceId, playerId })
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player', body: 'help' })
    const actorId = await seedAgent()
    const toolsConfig = buildBaselineToolsConfig().map((t) => (t.tool === 'search_articles' ? { ...t, enabled: false } : t))
    await withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, isProvisioned: true, toolsConfig }))
  })

  it('never sends a disabled tool\'s schema to the model, regardless of prompt/rules content', async () => {
    const callModelSpy = vi.spyOn(openaiClient, 'callModel').mockResolvedValue({
      text: null,
      toolCalls: [{ id: '1', name: 'handoff', arguments: JSON.stringify({ reason: 'asked_for_person' }) }],
    })

    await toolLoopDecider({
      workspaceId,
      conversationId,
      subintentId: null,
      confirmPhase: 'none',
      botMessageCount: 0,
      unhelpedReplyCount: 0,
      lastPlayerMessageAt: new Date(),
      history: [],
    })

    expect(callModelSpy).toHaveBeenCalledTimes(1)
    const toolsSent = callModelSpy.mock.calls[0]![1] as { function: { name: string } }[]
    expect(toolsSent.map((t) => t.function.name)).not.toContain('search_articles')
  })
})

describe('toolLoopDecider — configurable limits', () => {
  let workspaceId: string
  let conversationId: string
  let actorId: string

  beforeEach(async () => {
    await truncateAll()
    workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    conversationId = await seedConversation({ workspaceId, playerId })
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player', body: 'help' })
    actorId = await seedAgent()
  })

  it('forces turn_cap at a lower configured max_bot_messages rather than the old hardcoded 8', async () => {
    const callModelSpy = vi.spyOn(openaiClient, 'callModel')
    const limitsConfig = buildBaselineLimits().map((l) => (l.key === 'max_bot_messages' ? { ...l, value: 4 } : l))
    await withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, isProvisioned: true, limitsConfig }))

    const decision = await toolLoopDecider({
      workspaceId,
      conversationId,
      subintentId: null,
      confirmPhase: 'none',
      botMessageCount: 4,
      unhelpedReplyCount: 0,
      lastPlayerMessageAt: new Date(),
      history: [],
    })

    expect(decision).toEqual({ kind: 'handoff', reason: 'turn_cap', subintentId: null })
    expect(callModelSpy).not.toHaveBeenCalled()
  })

  it('forces unhelped_cap before turn_cap when max_unhelped_replies is the lower ceiling', async () => {
    const callModelSpy = vi.spyOn(openaiClient, 'callModel')
    const limitsConfig = buildBaselineLimits().map((l) => (l.key === 'max_unhelped_replies' ? { ...l, value: 2 } : l))
    await withWorkspace(workspaceId, (tx) => saveBotConfig(tx, { workspaceId, actorId, isProvisioned: true, limitsConfig }))

    const decision = await toolLoopDecider({
      workspaceId,
      conversationId,
      subintentId: null,
      confirmPhase: 'none',
      botMessageCount: 2,
      unhelpedReplyCount: 2,
      lastPlayerMessageAt: new Date(),
      history: [],
    })

    expect(decision).toEqual({ kind: 'handoff', reason: 'unhelped_cap', subintentId: null })
    expect(callModelSpy).not.toHaveBeenCalled()
  })
})

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})
