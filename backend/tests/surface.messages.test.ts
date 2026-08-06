import { createServer } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/shared/db/client.ts'
import { createSocketServer } from '../src/shared/realtime/socketServer.ts'
import { app, mintToken } from './helpers/app.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedPlayer,
  seedSession,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

// This suite's pool runs each test file in an isolated module registry, so the
// realtime singleton getIo() relies on isn't populated by realtime.rooms.test.ts
// running earlier in the same process. Initialise it here — the http server is
// never listened on, so this never accepts real socket connections; it exists
// only so emitMessageToRooms/emitInboxChanged have a Server instance to call.
beforeAll(() => {
  createSocketServer(createServer())
})

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

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
