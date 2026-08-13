import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { applyResolutionAnswer } from '../src/domain/conversations/index.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { closeDb } from '../src/shared/db/client.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts'

beforeEach(truncateAll)
afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

async function conversationRow(id: string) {
  const { rows } = await ownerPool.query(
    `select status, confirm_phase, resolution_source, assigned_agent_id from conversation where id = $1`,
    [id],
  )
  return rows[0]
}

async function messagesFor(conversationId: string) {
  const { rows } = await ownerPool.query(`select author_type, visibility, body from message where conversation_id = $1 order by seq`, [
    conversationId,
  ])
  return rows
}

async function eventsFor(conversationId: string) {
  const { rows } = await ownerPool.query(`select type, payload from event where conversation_id = $1 order by id`, [
    conversationId,
  ])
  return rows
}

async function setConfirmPhase(conversationId: string, phase: 'none' | 'bot_article' | 'agent_ask') {
  await ownerPool.query(`update conversation set confirm_phase = $2 where id = $1`, [conversationId, phase])
}

describe('applyResolutionAnswer', () => {
  it('writes nothing when confirm_phase is none', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, true),
    )

    expect(outcome).toEqual({ kind: 'rejected' })
    expect((await conversationRow(conversationId)).status).toBe('bot_active')
    expect(await eventsFor(conversationId)).toEqual([])
    expect(await messagesFor(conversationId)).toEqual([])
  })

  it('yes on bot_article resolves with source bot and posts nothing', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    await setConfirmPhase(conversationId, 'bot_article')

    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, true),
    )

    expect(outcome).toEqual({ kind: 'resolved', source: 'bot', posted: null })
    const row = await conversationRow(conversationId)
    expect(row.status).toBe('resolved')
    expect(row.confirm_phase).toBe('none')
    expect(row.resolution_source).toBe('bot')
    expect(await eventsFor(conversationId)).toEqual([
      { type: 'conversation_resolved', payload: { source: 'bot', confirmed_by: 'player' } },
    ])
    expect(await messagesFor(conversationId)).toEqual([])
  })

  it('yes on agent_ask resolves with source agent and posts the confirmation as the player', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [conversationId])
    await setConfirmPhase(conversationId, 'agent_ask')

    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, true),
    )

    expect(outcome.kind).toBe('resolved')
    const row = await conversationRow(conversationId)
    expect(row.status).toBe('resolved')
    expect(row.confirm_phase).toBe('none')
    // The column, not the event, is what reopen actually reads.
    expect(row.resolution_source).toBe('agent')
    // The answer lands in the transcript before the resolution it caused.
    expect(await eventsFor(conversationId)).toEqual([
      { type: 'message_sent', payload: { seq: 1, author_type: 'player', visibility: 'public' } },
      { type: 'conversation_resolved', payload: { source: 'agent', confirmed_by: 'player' } },
    ])
    expect(await messagesFor(conversationId)).toEqual([
      { author_type: 'player', visibility: 'public', body: 'Yes, my issue is resolved.' },
    ])
  })

  it('no on bot_article still runs spec 4 handoff(article_rejected) unchanged', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const agentId = await seedAgent()
    await seedWorkspaceMember({ workspaceId, agentId })
    await setConfirmPhase(conversationId, 'bot_article')

    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, false),
    )

    expect(outcome.kind).toBe('handed_off')
    const row = await conversationRow(conversationId)
    expect(row.status).toBe('open')
    expect(row.confirm_phase).toBe('none')
    expect(row.assigned_agent_id).toBe(agentId)
    expect(await messagesFor(conversationId)).toEqual([
      { author_type: 'system', visibility: 'public', body: "You're being connected to our support team." },
    ])
    // applyBotTurn's handoff branch posts the player-facing message first, via
    // postMessage, which appends its own message_sent event before the
    // lifecycle events — same order bot.phase.test.ts asserts for this same
    // applyBotTurn call.
    expect((await eventsFor(conversationId)).map((e) => e.type)).toEqual([
      'message_sent',
      'bot_article_rejected',
      'bot_handoff',
    ])
  })

  it('no on agent_ask clears the phase, touches no status, and posts the decline as the player', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const agentId = await seedAgent()
    await seedWorkspaceMember({ workspaceId, agentId })
    await ownerPool.query(`update conversation set status = 'awaiting_player', assigned_agent_id = $2 where id = $1`, [
      conversationId,
      agentId,
    ])
    await setConfirmPhase(conversationId, 'agent_ask')

    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, false),
    )

    expect(outcome.kind).toBe('declined')
    const row = await conversationRow(conversationId)
    expect(row.status).toBe('awaiting_player')
    expect(row.confirm_phase).toBe('none')
    expect(row.assigned_agent_id).toBe(agentId)
    expect(row.resolution_source).toBe(null)
    // Player-authored, not system: the player answered, and the agent's
    // transcript has to show that they did.
    expect(await messagesFor(conversationId)).toEqual([
      { author_type: 'player', visibility: 'public', body: "No, I'm still having issues." },
    ])
    expect(await eventsFor(conversationId)).toEqual([
      { type: 'message_sent', payload: { seq: 1, author_type: 'player', visibility: 'public' } },
      { type: 'resolution_check_declined', payload: { source: 'agent' } },
    ])
  })

  it('a second answer after the first is rejected and writes nothing', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    await setConfirmPhase(conversationId, 'agent_ask')
    const base = { workspaceId, conversationId, playerId, sessionId: null }

    await withWorkspace(workspaceId, (tx) => applyResolutionAnswer(tx, base, false))
    const second = await withWorkspace(workspaceId, (tx) => applyResolutionAnswer(tx, base, false))
    expect(second).toEqual({ kind: 'rejected' })
    // The first decline's pair (message_sent, resolution_check_declined) and
    // nothing from the second — a double tap must not post twice.
    expect((await eventsFor(conversationId)).map((e) => e.type)).toEqual(['message_sent', 'resolution_check_declined'])
    expect(await messagesFor(conversationId)).toHaveLength(1)
  })
})
