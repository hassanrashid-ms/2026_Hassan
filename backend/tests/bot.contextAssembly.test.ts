import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { appendEvent } from '../src/shared/events/appendEvent.ts'
import { buildMessages, MAX_HISTORY_MESSAGES } from '../src/domain/bot/contextAssembly.ts'
import type { BotTurnInput } from '../src/domain/bot/botTurn.ts'
import {
  closeOwnerPool,
  seedConversation,
  seedIntent,
  seedMessage,
  seedPlayer,
  seedSubintent,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

function baseInput(overrides: Partial<BotTurnInput> & { workspaceId: string; conversationId: string }): BotTurnInput {
  return {
    subintentId: null,
    botPhase: 'none',
    botMessageCount: 0,
    lastPlayerMessageAt: null,
    history: [],
    ...overrides,
  }
}

describe('buildMessages', () => {
  it('renders classification and offered/rejected article from event rows, with no model-generated text', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const intentId = await seedIntent(workspaceId, 'Billing')
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Refund' })

    await withWorkspace(workspaceId, (tx) =>
      appendEvent(tx, {
        workspaceId,
        conversationId,
        type: 'bot_article_offered',
        actorType: 'bot',
        payload: { article_title: 'How refunds work' },
      }),
    )
    await withWorkspace(workspaceId, (tx) =>
      appendEvent(tx, {
        workspaceId,
        conversationId,
        type: 'bot_article_rejected',
        actorType: 'bot',
        payload: {},
      }),
    )

    const input = baseInput({ workspaceId, conversationId, subintentId })
    const { messages } = await withWorkspace(workspaceId, (tx) => buildMessages(tx, input))

    const stateMessage = messages.find((m) => m.content.includes('conversation state'))
    expect(stateMessage).toBeDefined()
    expect(stateMessage!.content).toContain('Billing')
    expect(stateMessage!.content).toContain('Refund')
    expect(stateMessage!.content).toContain('How refunds work')
    expect(stateMessage!.content).toContain('rejected')
  })

  it('with 40 messages, keeps the first player message, the last 20, and an elision marker with the dropped count', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    for (let seq = 1; seq <= 40; seq++) {
      await seedMessage({
        workspaceId,
        conversationId,
        seq,
        authorType: seq % 2 === 1 ? 'player' : 'bot',
        body: `msg-${seq}`,
      })
    }

    const input = baseInput({ workspaceId, conversationId })
    const { messages } = await withWorkspace(workspaceId, (tx) => buildMessages(tx, input))
    const bodies = messages.map((m) => m.content)

    expect(bodies).toContain('msg-1')
    for (let seq = 21; seq <= 40; seq++) {
      expect(bodies).toContain(`msg-${seq}`)
    }
    // messages 2..20 were dropped: 39 - MAX_HISTORY_MESSAGES = 19
    const droppedCount = 39 - MAX_HISTORY_MESSAGES
    const elisionMarker = bodies.filter((b) => new RegExp(`${droppedCount} messages? omitted|elided`).test(b))
    expect(elisionMarker).toHaveLength(1)
    for (let seq = 2; seq <= 20; seq++) {
      expect(bodies).not.toContain(`msg-${seq}`)
    }
  })

  it('never includes an internal-visibility message, at any window size', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player', visibility: 'public', body: 'hello' })
    await seedMessage({
      workspaceId,
      conversationId,
      seq: 2,
      authorType: 'agent',
      visibility: 'internal',
      body: 'secret internal note',
    })
    await seedMessage({ workspaceId, conversationId, seq: 3, authorType: 'bot', visibility: 'public', body: 'public reply' })

    const input = baseInput({ workspaceId, conversationId })
    const { messages } = await withWorkspace(workspaceId, (tx) => buildMessages(tx, input))

    expect(messages.some((m) => m.content.includes('secret internal note'))).toBe(false)
  })

  it('emits no system-role message after the first', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player', body: 'hello' })

    const input = baseInput({ workspaceId, conversationId })
    const { messages } = await withWorkspace(workspaceId, (tx) => buildMessages(tx, input))

    expect(messages.filter((m) => m.role === 'system')).toHaveLength(1)
    expect(messages[0]!.role).toBe('system')
  })

  it('produces the same state block after a simulated five-day gap, plus the gap line', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationIdRecent = await seedConversation({ workspaceId, playerId })
    const conversationIdOld = await seedConversation({ workspaceId, playerId })

    const recentInput = baseInput({
      workspaceId,
      conversationId: conversationIdRecent,
      lastPlayerMessageAt: new Date(),
    })
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    const oldInput = baseInput({
      workspaceId,
      conversationId: conversationIdOld,
      lastPlayerMessageAt: fiveDaysAgo,
    })

    const recentResult = await withWorkspace(workspaceId, (tx) => buildMessages(tx, recentInput))
    const oldResult = await withWorkspace(workspaceId, (tx) => buildMessages(tx, oldInput))

    const recentState = recentResult.messages.find((m) => m.content.includes('conversation state'))!
    const oldState = oldResult.messages.find((m) => m.content.includes('conversation state'))!

    expect(recentState.content).not.toMatch(/last here \d+ days? ago/)
    expect(oldState.content).toMatch(/last here 5 days ago/)

    const recentWithoutGap = recentState.content
    const oldWithoutGapLine = oldState.content.replace(/\nPlayer was last here 5 days ago/, '')
    expect(oldWithoutGapLine).toBe(recentWithoutGap)

    // Every other message is identical between the two calls (no history, no classification).
    const stripState = (msgs: typeof recentResult.messages) => msgs.filter((m) => !m.content.includes('conversation state'))
    expect(stripState(recentResult.messages)).toEqual(stripState(oldResult.messages))
  })
})
