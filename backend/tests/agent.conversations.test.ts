import { createServer } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts'
import { errorMiddleware } from '../src/errors.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts'
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedMessage,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

// A standalone app carrying just this router, gated by the real
// requireAgentSession middleware — not the shared app.ts, and it never
// touches agent/router.ts. conversationsRouter isn't mounted there until the
// Batch 2 Checkpoint, so this is the only way to exercise it before then, and
// it keeps this task's test run from racing Task 8's over the same file.
const app = express()
app.use(express.json())
app.use(requireAgentSession, conversationsRouter)
app.use(errorMiddleware)

// claimConversationHandler calls getIo() after a successful claim, so this
// file's own process needs a live Socket.io instance even though no test
// connects a client to it — a bare, unlistened http server is enough to
// satisfy getIo(). Same pattern as agent.messages.test.ts and
// surface.messages.test.ts, which hit the same singleton requirement.
beforeAll(() => {
  createSocketServer(createServer())
})

afterAll(async () => {
  await closeSocketServer()
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function setupAgent(workspaceId: string) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ('agent1@example.test', 'Agent One') returning id`,
  )
  const agentId = rows[0]!.id
  await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
    workspaceId,
    agentId,
  ])
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })
  return { agentId, token }
}

describe('GET /agent/conversations', () => {
  it('lists unassigned conversations with a last-message preview', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player', body: 'help please' })
    const { token } = await setupAgent(workspaceId)

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(res.body.conversations).toHaveLength(1)
    expect(res.body.conversations[0].last_message_preview).toBe('help please')
  })
})

describe('POST /agent/conversations/:id/claim', () => {
  it('claims an unassigned conversation', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const { token } = await setupAgent(workspaceId)

    const res = await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body).toEqual({ claimed: true })
  })

  it('a claim race: exactly one of two concurrent claims succeeds', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const agentA = await setupAgent(workspaceId)
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agent2@example.test', 'Agent Two') returning id`,
    )
    await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
      workspaceId,
      rows[0]!.id,
    ])
    const tokenB = await signAgentSession({ agent_id: rows[0]!.id, workspace_id: workspaceId })

    const [resA, resB] = await Promise.all([
      request(app).post(`/conversations/${conversationId}/claim`).set('Authorization', `Bearer ${agentA.token}`),
      request(app).post(`/conversations/${conversationId}/claim`).set('Authorization', `Bearer ${tokenB}`),
    ])

    const claimedFlags = [resA.body.claimed, resB.body.claimed].sort()
    expect(claimedFlags).toEqual([false, true])
  })
})

describe('GET /agent/conversations/:id/messages', () => {
  it('returns the full history via toAgentView', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player', body: 'hi' })
    const { token } = await setupAgent(workspaceId)

    const res = await request(app)
      .get(`/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.messages).toHaveLength(1)
    expect(res.body.messages[0]).toMatchObject({ author_type: 'player', body: 'hi' })
  })

  it('404s for a conversation outside the agent\'s workspace', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const playerB = await seedPlayer(workspaceB)
    const conversationB = await seedConversation({ workspaceId: workspaceB, playerId: playerB })
    const { token } = await setupAgent(workspaceA)

    await request(app)
      .get(`/conversations/${conversationB}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404)
  })
})
