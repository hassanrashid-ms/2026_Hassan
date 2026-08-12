import { createServer } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts'
import { app, mintToken } from './helpers/app.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedBotConfig,
  seedConversation,
  seedPlayer,
  seedSession,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts'
import { enqueueBotTurn } from '../src/shared/jobs/botTurns.ts'

vi.mock('../src/shared/jobs/botTurns.ts', () => ({ enqueueBotTurn: vi.fn().mockResolvedValue(undefined) }))

// This suite's pool runs each test file in an isolated module registry, so the
// realtime singleton getIo() relies on isn't populated by realtime.rooms.test.ts
// running earlier in the same process. Initialise it here — the http server is
// never listened on, so this never accepts real socket connections; it exists
// only so emitMessageToRooms/emitInboxChanged have a Server instance to call.
beforeAll(() => {
  createSocketServer(createServer())
})

afterAll(async () => {
  await closeSocketServer()
  await closeDb()
  await closeOwnerPool()
})

beforeEach(async () => {
  await truncateAll()
  vi.clearAllMocks()
})

async function setup() {
  const workspaceId = await seedWorkspace()
  const playerId = await seedPlayer(workspaceId)
  const sessionId = await seedSession({ workspaceId, playerId })
  const token = await mintToken({ workspace_id: workspaceId, player_id: playerId, external_player_id: 'p1' })
  return { workspaceId, playerId, sessionId, token }
}

describe('POST /surface/messages', () => {
  it('creates the conversation on the first message', async () => {
    const { token } = await setup()
    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello' })
      .expect(200)
    expect(res.body.conversation_id).toBeDefined()
    expect(res.body.message).toMatchObject({ author_type: 'player', body: 'hello', seq: 1 })
  })

  it('creates a new conversation at bot_active, not open', async () => {
    const { workspaceId, token } = await setup()
    // Provisioned: this first message resolves to `shouldEnqueue`, which this
    // plan computes but does not act on, so the transaction never touches
    // status again and it stays at the schema default.
    await seedBotConfig({ workspaceId, isProvisioned: true })
    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hi' })
      .expect(200)

    const { rows } = await ownerPool.query(`select status from conversation where id = $1`, [res.body.conversation_id])
    expect(rows[0].status).toBe('bot_active')
  })

  it('a not-provisioned bot hands off inline: open, assigned, one public system message, no internal note, one bot_unavailable event, no job', async () => {
    const { workspaceId, token } = await setup()
    const availableAgent = await seedAgent()
    await seedWorkspaceMember({ workspaceId, agentId: availableAgent })
    await seedBotConfig({ workspaceId, isProvisioned: false })

    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hi' })
      .expect(200)

    const conversationId = res.body.conversation_id

    const { rows: convRows } = await ownerPool.query(
      `select status, assigned_agent_id from conversation where id = $1`,
      [conversationId],
    )
    expect(convRows[0].status).toBe('open')
    expect(convRows[0].assigned_agent_id).toBe(availableAgent)

    const { rows: msgRows } = await ownerPool.query(
      `select author_type, visibility from message where conversation_id = $1 and author_type = 'system'`,
      [conversationId],
    )
    expect(msgRows.length).toBe(1)
    expect(msgRows[0].visibility).toBe('public')

    const { rows: eventRows } = await ownerPool.query(
      `select type, payload from event where conversation_id = $1 and type = 'bot_unavailable'`,
      [conversationId],
    )
    expect(eventRows.length).toBe(1)
    expect(eventRows[0].payload).toEqual({ reason: 'not_provisioned' })

    // Only the player's own message comes back in the response body.
    expect(res.body.message.body).toBe('hi')
  })

  it('rejects an empty body with 422', async () => {
    const { token } = await setup()
    await request(app).post('/surface/messages').set('Authorization', `Bearer ${token}`).send({ body: '' }).expect(422)
  })

  it('reopens a resolved conversation and appends conversation_reopened', async () => {
    const { workspaceId, playerId, token } = await setup()
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'resolved', assigned_agent_id = null where id = $1`, [
      conversationId,
    ])
    const agentRow = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('a1@example.test', 'A1') returning id`,
    )
    await ownerPool.query(`update conversation set assigned_agent_id = $2 where id = $1`, [
      conversationId,
      agentRow.rows[0]!.id,
    ])

    await request(app).post('/surface/messages').set('Authorization', `Bearer ${token}`).send({ body: 'still here' }).expect(200)

    const { rows } = await ownerPool.query<{ status: string; assigned_agent_id: string | null }>(
      `select status, assigned_agent_id from conversation where id = $1`,
      [conversationId],
    )
    expect(rows[0]!.status).toBe('open')
    expect(rows[0]!.assigned_agent_id).toBeNull()

    const { rows: events } = await ownerPool.query<{ type: string }>(
      `select type from event where conversation_id = $1 and type = 'conversation_reopened'`,
      [conversationId],
    )
    expect(events).toHaveLength(1)
  })

  it('flips awaiting_player back to open, keeps the assignment, and appends conversation_player_replied', async () => {
    const { workspaceId, playerId, token } = await setup()
    const conversationId = await seedConversation({ workspaceId, playerId })
    const agentRow = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('a2@example.test', 'A2') returning id`,
    )
    const agentId = agentRow.rows[0]!.id
    await ownerPool.query(`update conversation set status = 'awaiting_player', assigned_agent_id = $2 where id = $1`, [
      conversationId,
      agentId,
    ])

    await request(app).post('/surface/messages').set('Authorization', `Bearer ${token}`).send({ body: 'here it is' }).expect(200)

    const { rows } = await ownerPool.query<{ status: string; assigned_agent_id: string | null }>(
      `select status, assigned_agent_id from conversation where id = $1`,
      [conversationId],
    )
    expect(rows[0]!.status).toBe('open')
    // A reply is not a reopen: the agent who asked stays the owner.
    expect(rows[0]!.assigned_agent_id).toBe(agentId)

    const { rows: events } = await ownerPool.query<{ type: string }>(
      `select type from event where conversation_id = $1 order by id`,
      [conversationId],
    )
    expect(events.map((e) => e.type)).toContain('conversation_player_replied')
    expect(events.map((e) => e.type)).not.toContain('conversation_reopened')
  })

  it('leaves a status outside the transition table untouched on a player reply', async () => {
    const { workspaceId, playerId, token } = await setup()
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'escalated' where id = $1`, [conversationId])

    await request(app).post('/surface/messages').set('Authorization', `Bearer ${token}`).send({ body: 'any news?' }).expect(200)

    const { rows } = await ownerPool.query<{ status: string }>(`select status from conversation where id = $1`, [
      conversationId,
    ])
    expect(rows[0]!.status).toBe('escalated')
  })

  it('enqueues exactly one bot-turn job with id conversationId__seq when the bot is provisioned', async () => {
    const { workspaceId, token } = await setup()
    await seedBotConfig({ workspaceId, isProvisioned: true })

    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello' })
      .expect(200)

    expect(enqueueBotTurn).toHaveBeenCalledTimes(1)
    const call = vi.mocked(enqueueBotTurn).mock.calls[0]![0]
    expect(call.workspaceId).toBe(workspaceId)
    expect(call.conversationId).toBe(res.body.conversation_id)
    // The posted player message's own seq, not just "some number" — a regression
    // to a wrong or zero seq (e.g. always enqueuing seq 1) must fail this.
    expect(call.seq).toBe(res.body.message.seq)

    const { rows } = await ownerPool.query<{ seq: number }>(
      `select seq from message where conversation_id = $1 and author_type = 'player'`,
      [res.body.conversation_id],
    )
    expect(rows).toHaveLength(1)
    expect(call.seq).toBe(rows[0]!.seq)
  })

  it('does not enqueue on the reopen branch', async () => {
    const { workspaceId, playerId, token } = await setup()
    await seedBotConfig({ workspaceId, isProvisioned: true })
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'resolved', assigned_agent_id = null where id = $1`, [
      conversationId,
    ])

    await request(app).post('/surface/messages').set('Authorization', `Bearer ${token}`).send({ body: 'hello again' }).expect(200)

    expect(enqueueBotTurn).not.toHaveBeenCalled()
  })

  it('does not enqueue on the awaiting_player -> open branch', async () => {
    const { workspaceId, playerId, token } = await setup()
    await seedBotConfig({ workspaceId, isProvisioned: true })
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'awaiting_player' where id = $1`, [conversationId])

    await request(app).post('/surface/messages').set('Authorization', `Bearer ${token}`).send({ body: 'answer' }).expect(200)

    expect(enqueueBotTurn).not.toHaveBeenCalled()
  })
})

describe('GET /surface/messages', () => {
  it('returns conversation_id: null and an empty list when no conversation exists yet', async () => {
    const { token, sessionId } = await setup()
    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: sessionId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body).toEqual({ conversation_id: null, messages: [] })
  })

  it('404s for a session_id that is not the caller\'s own', async () => {
    const { token } = await setup()
    await request(app)
      .get('/surface/messages')
      .query({ session_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })
      .set('Authorization', `Bearer ${token}`)
      .expect(404)
  })

  it('includes status and no internal-only fields', async () => {
    const { workspaceId, playerId, token, sessionId } = await setup()
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [conversationId])
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, body) values ($1, $2, 1, 'agent', 'hi')`,
      [workspaceId, conversationId],
    )

    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: sessionId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(res.body.status).toBe('open')
    expect(res.body.messages[0]).not.toHaveProperty('visibility')
    expect(res.body.messages[0]).not.toHaveProperty('author_agent_id')
  })
})

describe('POST /surface/messages/read', () => {
  it('marks agent-authored messages up to seq as read', async () => {
    const { workspaceId, playerId, token } = await setup()
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, body) values ($1, $2, 1, 'agent', 'hi')`,
      [workspaceId, conversationId],
    )
    await request(app).post('/surface/messages/read').set('Authorization', `Bearer ${token}`).send({ up_to_seq: 1 }).expect(200)

    const { rows } = await ownerPool.query<{ delivery_state: string }>(
      `select delivery_state from message where conversation_id = $1 and seq = 1`,
      [conversationId],
    )
    expect(rows[0]!.delivery_state).toBe('read')
  })
})

describe('POST /surface/messages/read records when the player saw it', () => {
  it("stamps read_at on agent messages and leaves the player's own untouched", async () => {
    const { workspaceId, playerId, token } = await setup()
    const conversationId = await seedConversation({ workspaceId, playerId })
    const agentRow = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('r1@example.test', 'R1') returning id`,
    )
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, author_agent_id, body)
       values ($1, $2, 1, 'agent', $3, 'from the agent'), ($1, $2, 2, 'player', null, 'from the player')`,
      [workspaceId, conversationId, agentRow.rows[0]!.id],
    )

    await request(app)
      .post('/surface/messages/read')
      .set('Authorization', `Bearer ${token}`)
      .send({ up_to_seq: 2 })
      .expect(200)

    const { rows } = await ownerPool.query<{ seq: number; delivery_state: string; read_at: Date | null }>(
      `select seq, delivery_state, read_at from message where conversation_id = $1 order by seq`,
      [conversationId],
    )
    expect(rows[0]).toMatchObject({ seq: 1, delivery_state: 'read' })
    expect(rows[0]!.read_at).toBeInstanceOf(Date)
    // The player reading their own message is not a receipt.
    expect(rows[1]).toMatchObject({ seq: 2, delivery_state: 'sent' })
    expect(rows[1]!.read_at).toBeNull()
  })

  it('never moves read_at forward on a second read of the same message', async () => {
    const { workspaceId, playerId, token } = await setup()
    const conversationId = await seedConversation({ workspaceId, playerId })
    const agentRow = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('r2@example.test', 'R2') returning id`,
    )
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, author_agent_id, body)
       values ($1, $2, 1, 'agent', $3, 'first')`,
      [workspaceId, conversationId, agentRow.rows[0]!.id],
    )

    const read = () =>
      request(app).post('/surface/messages/read').set('Authorization', `Bearer ${token}`).send({ up_to_seq: 1 }).expect(200)
    const readAtNow = async () => {
      const { rows } = await ownerPool.query<{ read_at: Date }>(
        `select read_at from message where conversation_id = $1 and seq = 1`,
        [conversationId],
      )
      return rows[0]!.read_at.toISOString()
    }

    await read()
    const first = await readAtNow()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await read()
    expect(await readAtNow()).toBe(first)
  })
})
