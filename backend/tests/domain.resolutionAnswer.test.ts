import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyResolutionAnswer } from '../src/domain/conversations/index.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { HANDOFF_PLAYER_MESSAGES } from '../src/domain/bot/messages.ts'
import { conversation, event, resolutionCycle } from '../src/shared/db/schema/index.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedForm,
  seedFormVersion,
  seedIntent,
  seedPlayer,
  seedResolutionCycle,
  seedSubintent,
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

async function setSubintent(conversationId: string, subintentId: string) {
  await ownerPool.query(`update conversation set subintent_id = $2 where id = $1`, [conversationId, subintentId])
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

  it('yes on agent_ask resolves an escalated conversation too — the only forward path out of escalated', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'escalated' where id = $1`, [conversationId])
    await setConfirmPhase(conversationId, 'agent_ask')

    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, true),
    )

    expect(outcome.kind).toBe('resolved')
    const row = await conversationRow(conversationId)
    expect(row.status).toBe('resolved')
    expect(row.confirm_phase).toBe('none')
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
      { author_type: 'system', visibility: 'public', body: expect.toBeOneOf([...HANDOFF_PLAYER_MESSAGES]) },
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

  it('no on bot_article offers the classified subintent\'s published form instead of handing off straight to a human', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const agentId = await seedAgent()
    await seedWorkspaceMember({ workspaceId, agentId })
    const intentId = await seedIntent(workspaceId)
    const formId = await seedForm({ workspaceId })
    await seedFormVersion({ workspaceId, formId, version: 1, fields: [], publishedAt: new Date() })
    const subintentId = await seedSubintent({ workspaceId, intentId, formId })
    await setConfirmPhase(conversationId, 'bot_article')
    await setSubintent(conversationId, subintentId)

    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, false),
    )

    expect(outcome.kind).toBe('handed_off')
    const row = await conversationRow(conversationId)
    expect(row.status).toBe('bot_active')
    expect(row.confirm_phase).toBe('form')
    expect(row.assigned_agent_id).toBe(null)
    expect((await eventsFor(conversationId)).map((e) => e.type)).toEqual([
      'message_sent',
      'bot_article_rejected',
      'form_offered',
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

describe('applyResolutionAnswer — inactivity_ask', () => {
  it('resolves as player_confirmed on Yes and closes the cycle', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'awaiting_player',
      confirmPhase: 'inactivity_ask',
    })
    await seedResolutionCycle({ workspaceId, conversationId, inactivityDueAt: new Date() })

    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, true),
    )
    expect(outcome.kind).toBe('resolved')
    if (outcome.kind === 'resolved') expect(outcome.source).toBe('player_confirmed')

    const [conv] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    )
    expect(conv!.status).toBe('resolved')
    expect(conv!.confirmPhase).toBe('none')
    expect(conv!.resolutionSource).toBe('player_confirmed')

    const [cycle] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(resolutionCycle).where(eq(resolutionCycle.conversationId, conversationId)),
    )
    expect(cycle!.resolutionKind).toBe('player_confirmed')
    expect(cycle!.resolvedAt).not.toBeNull()
    expect(cycle!.inactivityDueAt).toBeNull()

    const events = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.type, 'conversation_resolved')),
    )
    expect(events[0]!.payload).toMatchObject({ source: 'inactivity', confirmed_by: 'player' })
  })

  it('on No, clears the phase, posts the decline and restarts the clock', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'awaiting_player',
      confirmPhase: 'inactivity_ask',
    })
    const past = new Date('2026-08-01T00:00:00Z')
    await seedResolutionCycle({ workspaceId, conversationId, inactivityDueAt: past })

    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, false),
    )
    expect(outcome.kind).toBe('declined')

    const [conv] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    )
    expect(conv!.status).toBe('awaiting_player')
    expect(conv!.confirmPhase).toBe('none')

    const [cycle] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(resolutionCycle).where(eq(resolutionCycle.conversationId, conversationId)),
    )
    expect(cycle!.resolvedAt).toBeNull()
    // Spec step 3: "clock restarts". The decline message's own postMessage did it.
    expect(cycle!.inactivityDueAt!.getTime()).toBeGreaterThan(past.getTime())

    const events = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.type, 'resolution_check_declined')),
    )
    expect(events[0]!.payload).toMatchObject({ source: 'inactivity' })
  })

  it('closes the cycle on the agent_ask Yes path too', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      confirmPhase: 'agent_ask',
    })
    await seedResolutionCycle({ workspaceId, conversationId, inactivityDueAt: new Date() })

    await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, true),
    )

    const [cycle] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(resolutionCycle).where(eq(resolutionCycle.conversationId, conversationId)),
    )
    expect(cycle!.resolutionKind).toBe('agent')
    expect(cycle!.resolvedAt).not.toBeNull()
  })

  it('closes the cycle on the bot_article Yes path', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'bot_active',
      confirmPhase: 'bot_article',
    })
    await seedResolutionCycle({ workspaceId, conversationId })

    await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, true),
    )

    const [cycle] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(resolutionCycle).where(eq(resolutionCycle.conversationId, conversationId)),
    )
    expect(cycle!.resolutionKind).toBe('bot')
  })
})
