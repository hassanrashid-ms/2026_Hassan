import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { applyBotTurn } from '../src/domain/bot/applyBotTurn.ts'
import { HANDOFF_PLAYER_MESSAGE, botFailureNote } from '../src/domain/bot/messages.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { closeDb } from '../src/shared/db/client.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedIntent,
  seedPlayer,
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
    `select status, assigned_agent_id, subintent_id, classification_source from conversation where id = $1`,
    [id],
  )
  return rows[0]
}

async function messagesFor(conversationId: string) {
  const { rows } = await ownerPool.query(
    `select author_type, visibility, body from message where conversation_id = $1 order by seq`,
    [conversationId],
  )
  return rows
}

async function eventsFor(conversationId: string) {
  const { rows } = await ownerPool.query(`select type, payload from event where conversation_id = $1 order by id`, [
    conversationId,
  ])
  return rows
}

describe('applyBotTurn', () => {
  it('noop writes nothing', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    await withWorkspace(workspaceId, (tx) => applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'noop' }))

    expect(await messagesFor(conversationId)).toEqual([])
    expect(await eventsFor(conversationId)).toEqual([])
    const row = await conversationRow(conversationId)
    expect(row.status).toBe('bot_active')
  })

  it('answer keeps bot_active, posts one public bot message, classifies once', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const intentId = await seedIntent(workspaceId, 'Billing')
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Refund' })

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'answer', reply: 'Here is how refunds work.', subintentId }),
    )

    const msgs = await messagesFor(conversationId)
    expect(msgs).toEqual([{ author_type: 'bot', visibility: 'public', body: 'Here is how refunds work.' }])

    const row = await conversationRow(conversationId)
    expect(row.status).toBe('bot_active')
    expect(row.subintent_id).toBe(subintentId)
    expect(row.classification_source).toBe('bot')

    // postMessage (already-landed, separately tested) always appends its own
    // message_sent event alongside whatever bot-turn event this outcome appends.
    const events = await eventsFor(conversationId)
    expect(events.map((e) => e.type)).toEqual(['message_sent', 'intent_set'])
    expect(events[1].payload).toMatchObject({ source: 'bot', subintent_name: 'Refund', intent_name: 'Billing' })
  })

  it('a second answer does not reclassify or append a second intent_set', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    // A sibling, still-unclassified conversation in the same workspace: if
    // classifyIfUnset's `where` ever drops its `eq(conversation.id, ...)`
    // condition (e.g. combining with JS `&&` instead of Drizzle's `and()`,
    // which silently discards the left operand), the UPDATE ... WHERE
    // subintent_id IS NULL would match this row too, and this assertion is
    // what would catch that — a single-conversation test cannot.
    const siblingConversationId = await seedConversation({ workspaceId, playerId })
    const intentId = await seedIntent(workspaceId)
    const firstSubintent = await seedSubintent({ workspaceId, intentId })
    const secondSubintent = await seedSubintent({ workspaceId, intentId })

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'answer', reply: 'first', subintentId: firstSubintent }),
    )
    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'answer', reply: 'second', subintentId: secondSubintent }),
    )

    const row = await conversationRow(conversationId)
    expect(row.subintent_id).toBe(firstSubintent)

    const events = await eventsFor(conversationId)
    expect(events.filter((e) => e.type === 'intent_set').length).toBe(1)

    const siblingRow = await conversationRow(siblingConversationId)
    expect(siblingRow.subintent_id).toBeNull()
    expect(siblingRow.classification_source).toBeNull()
    expect(await eventsFor(siblingConversationId)).toEqual([])
  })

  it('handoff flips to open, posts one public system message, no internal note, assigns, appends bot_handoff', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const availableAgent = await seedAgent()
    await seedWorkspaceMember({ workspaceId, agentId: availableAgent })

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'handoff', reason: 'unsure', subintentId: null }),
    )

    const msgs = await messagesFor(conversationId)
    expect(msgs).toEqual([{ author_type: 'system', visibility: 'public', body: HANDOFF_PLAYER_MESSAGE }])

    const row = await conversationRow(conversationId)
    expect(row.status).toBe('open')
    expect(row.assigned_agent_id).toBe(availableAgent)
    expect(row.subintent_id).toBeNull()

    // postMessage's own message_sent event precedes the bot-turn event.
    const events = await eventsFor(conversationId)
    expect(events.map((e) => e.type)).toEqual(['message_sent', 'bot_handoff'])
    expect(events[1].payload).toEqual({ reason: 'unsure', assigned_agent_id: availableAgent })
    // The event snapshots exactly who the conversation landed on.
    expect(events[1].payload.assigned_agent_id).toBe(row.assigned_agent_id)
  })

  it('handoff with no active agent in the workspace records a null assigned_agent_id', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    // Deactivated member only: assignOnHandoff has nobody to pick, which is
    // explicitly not an error.
    const deactivated = await seedAgent()
    await seedWorkspaceMember({ workspaceId, agentId: deactivated, deactivatedAt: new Date() })

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'handoff', reason: 'unsure', subintentId: null }),
    )

    const row = await conversationRow(conversationId)
    expect(row.status).toBe('open')
    expect(row.assigned_agent_id).toBeNull()

    const events = await eventsFor(conversationId)
    expect(events.map((e) => e.type)).toEqual(['message_sent', 'bot_handoff'])
    expect(events[1].payload).toEqual({ reason: 'unsure', assigned_agent_id: null })
  })

  it('unavailable with a loud reason posts a public message and an internal note, appends bot_unavailable, no intent_set', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'unavailable', reason: 'error' }),
    )

    const msgs = await messagesFor(conversationId)
    expect(msgs).toEqual([
      { author_type: 'system', visibility: 'public', body: HANDOFF_PLAYER_MESSAGE },
      { author_type: 'system', visibility: 'internal', body: botFailureNote('error') },
    ])

    const row = await conversationRow(conversationId)
    expect(row.status).toBe('open')
    expect(row.subintent_id).toBeNull()

    // Two postMessage calls (public + internal) each append their own
    // message_sent event, ahead of the bot_unavailable event.
    const events = await eventsFor(conversationId)
    expect(events.map((e) => e.type)).toEqual(['message_sent', 'message_sent', 'bot_unavailable'])
    expect(events[2].payload).toEqual({ reason: 'error' })
  })

  it.each(['not_provisioned'] as const)(
    'unavailable with silent reason %s posts no internal note but still appends bot_unavailable',
    async (reason) => {
      const workspaceId = await seedWorkspace()
      const playerId = await seedPlayer(workspaceId)
      const conversationId = await seedConversation({ workspaceId, playerId })

      await withWorkspace(workspaceId, (tx) =>
        applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'unavailable', reason }),
      )

      const msgs = await messagesFor(conversationId)
      expect(msgs).toEqual([{ author_type: 'system', visibility: 'public', body: HANDOFF_PLAYER_MESSAGE }])

      const events = await eventsFor(conversationId)
      expect(events.map((e) => e.type)).toEqual(['message_sent', 'bot_unavailable'])
      expect(events[1].payload).toEqual({ reason })
    },
  )

  it('no active agent leaves assigned_agent_id null but still flips status to open', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'unavailable', reason: 'not_provisioned' }),
    )

    const row = await conversationRow(conversationId)
    expect(row.status).toBe('open')
    expect(row.assigned_agent_id).toBeNull()
  })

  it('is atomic: an event-append failure rolls back the message and status change', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    // A conversation_id that cannot exist forces appendEvent's insert to violate
    // the FK inside the same transaction applyBotTurn runs its writes in — this
    // proves rollback without mocking anything.
    await expect(
      withWorkspace(workspaceId, async (tx) => {
        await applyBotTurn(tx, { workspaceId, conversationId: '00000000-0000-0000-0000-000000000000' }, {
          kind: 'handoff',
          reason: 'unsure',
          subintentId: null,
        })
      }),
    ).rejects.toThrow()

    const row = await conversationRow(conversationId)
    expect(row.status).toBe('bot_active')
    expect(await messagesFor(conversationId)).toEqual([])
  })

  it('cross-tenant FK is refused by the database, not a handler', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const playerA = await seedPlayer(workspaceA)
    const conversationId = await seedConversation({ workspaceId: workspaceA, playerId: playerA })
    const intentB = await seedIntent(workspaceB)
    const subintentB = await seedSubintent({ workspaceId: workspaceB, intentId: intentB })

    await expect(
      withWorkspace(workspaceA, async (tx) => {
        await tx.execute(
          // Raw SQL: the point is proving the database's composite FK refuses this,
          // not that application code happens not to attempt it.
          sql`update conversation set subintent_id = ${subintentB} where id = ${conversationId}`,
        )
      }),
    ).rejects.toThrow()
  })
})
