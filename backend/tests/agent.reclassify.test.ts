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
  seedIntent,
  seedPlayer,
  seedSubintent,
  seedWorkspace,
  seedAgent,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts'

const app = express()
app.use(express.json())
app.use(requireAgentSession, conversationsRouter)
app.use(errorMiddleware)

beforeAll(() => {
  createSocketServer(createServer())
})

afterAll(async () => {
  await closeSocketServer()
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function setupAgent(workspaceId: string): Promise<{ agentId: string; token: string }> {
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

describe('PATCH /agent/conversations/:id/subintent', () => {
  it('reclassifies an open conversation for plain agent role', async () => {
    const workspaceId = await seedWorkspace()
    const intentId = await seedIntent(workspaceId)
    const fromSubintentId = await seedSubintent({ workspaceId, intentId })
    const toSubintentId = await seedSubintent({ workspaceId, intentId })
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open', subintentId: fromSubintentId })
    const { token } = await setupAgent(workspaceId)

    const res = await request(app)
      .patch(`/conversations/${conversationId}/subintent`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentId: toSubintentId })
      .expect(200)

    expect(res.body).toEqual({ reclassified: true })
  })

  it('reclassifies a resolved conversation (no status restriction)', async () => {
    const workspaceId = await seedWorkspace()
    const intentId = await seedIntent(workspaceId)
    const fromSubintentId = await seedSubintent({ workspaceId, intentId })
    const toSubintentId = await seedSubintent({ workspaceId, intentId })
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'resolved', subintentId: fromSubintentId })
    const { token } = await setupAgent(workspaceId)

    const res = await request(app)
      .patch(`/conversations/${conversationId}/subintent`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentId: toSubintentId })
      .expect(200)

    expect(res.body).toEqual({ reclassified: true })
  })

  it('reclassifies a closed conversation (no status restriction)', async () => {
    const workspaceId = await seedWorkspace()
    const intentId = await seedIntent(workspaceId)
    const fromSubintentId = await seedSubintent({ workspaceId, intentId })
    const toSubintentId = await seedSubintent({ workspaceId, intentId })
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'closed', subintentId: fromSubintentId })
    const { token } = await setupAgent(workspaceId)

    const res = await request(app)
      .patch(`/conversations/${conversationId}/subintent`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentId: toSubintentId })
      .expect(200)

    expect(res.body).toEqual({ reclassified: true })
  })

  it('returns 404 not_found for a conversation that does not exist', async () => {
    const workspaceId = await seedWorkspace()
    const intentId = await seedIntent(workspaceId)
    const toSubintentId = await seedSubintent({ workspaceId, intentId })
    const { token } = await setupAgent(workspaceId)
    const nonExistentConversationId = '00000000-0000-0000-0000-000000000000'

    const res = await request(app)
      .patch(`/conversations/${nonExistentConversationId}/subintent`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentId: toSubintentId })
      .expect(404)

    expect(res.body.error.code).toBe('not_found')
  })

  it('returns 409 invalid_subintent for an archived subintent', async () => {
    const workspaceId = await seedWorkspace()
    const intentId = await seedIntent(workspaceId)
    const fromSubintentId = await seedSubintent({ workspaceId, intentId })
    const archivedSubintentId = await seedSubintent({ workspaceId, intentId })
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open', subintentId: fromSubintentId })
    const { token } = await setupAgent(workspaceId)
    await ownerPool.query(`update subintent set archived_at = now() where id = $1`, [archivedSubintentId])

    const res = await request(app)
      .patch(`/conversations/${conversationId}/subintent`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentId: archivedSubintentId })
      .expect(409)

    expect(res.body.error.code).toBe('invalid_subintent')
  })

  it('returns 409 invalid_subintent for a subintent from a different workspace', async () => {
    const workspaceId1 = await seedWorkspace()
    const workspaceId2 = await seedWorkspace()
    const intentId1 = await seedIntent(workspaceId1)
    const intentId2 = await seedIntent(workspaceId2)
    const fromSubintentId = await seedSubintent({ workspaceId: workspaceId1, intentId: intentId1 })
    const otherWorkspaceSubintentId = await seedSubintent({ workspaceId: workspaceId2, intentId: intentId2 })
    const playerId = await seedPlayer(workspaceId1)
    const conversationId = await seedConversation({ workspaceId: workspaceId1, playerId, status: 'open', subintentId: fromSubintentId })
    const { token } = await setupAgent(workspaceId1)

    const res = await request(app)
      .patch(`/conversations/${conversationId}/subintent`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentId: otherWorkspaceSubintentId })
      .expect(409)

    expect(res.body.error.code).toBe('invalid_subintent')
  })

  it('updates conversation.subintent_id and classification_source in DB', async () => {
    const workspaceId = await seedWorkspace()
    const intentId = await seedIntent(workspaceId)
    const fromSubintentId = await seedSubintent({ workspaceId, intentId })
    const toSubintentId = await seedSubintent({ workspaceId, intentId })
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open', subintentId: fromSubintentId })
    const { token } = await setupAgent(workspaceId)

    await request(app)
      .patch(`/conversations/${conversationId}/subintent`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentId: toSubintentId })
      .expect(200)

    const { rows } = await ownerPool.query<{ subintent_id: string; classification_source: string }>(
      `select subintent_id, classification_source from conversation where id = $1`,
      [conversationId],
    )
    expect(rows[0]!.subintent_id).toBe(toSubintentId)
    expect(rows[0]!.classification_source).toBe('agent')
  })

  it('writes exactly one conversation_reclassified event with correct payload', async () => {
    const workspaceId = await seedWorkspace()
    const intentId = await seedIntent(workspaceId)
    const fromSubintentId = await seedSubintent({ workspaceId, intentId })
    const toSubintentId = await seedSubintent({ workspaceId, intentId })
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open', subintentId: fromSubintentId })
    const { agentId, token } = await setupAgent(workspaceId)

    await request(app)
      .patch(`/conversations/${conversationId}/subintent`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentId: toSubintentId })
      .expect(200)

    const { rows } = await ownerPool.query(
      `select type, actor_id, payload from event where conversation_id = $1 and type = 'conversation_reclassified' order by id`,
      [conversationId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: 'conversation_reclassified',
      actor_id: agentId,
      payload: { from_subintent_id: fromSubintentId, to_subintent_id: toSubintentId, classification_source: 'agent' },
    })
  })

  it('writes exactly one change_log row with correct before/after', async () => {
    const workspaceId = await seedWorkspace()
    const intentId = await seedIntent(workspaceId)
    const fromSubintentId = await seedSubintent({ workspaceId, intentId })
    const toSubintentId = await seedSubintent({ workspaceId, intentId })
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open', subintentId: fromSubintentId })
    const { agentId, token } = await setupAgent(workspaceId)

    await request(app)
      .patch(`/conversations/${conversationId}/subintent`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentId: toSubintentId })
      .expect(200)

    const { rows } = await ownerPool.query<{ field: string; before_value: string; after_value: string }>(
      `select field, before_value, after_value from change_log where entity_id = $1 and entity_type = 'conversation' and field = 'subintent_id' order by id`,
      [conversationId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.field).toBe('subintent_id')
    expect(rows[0]!.before_value).toBe(fromSubintentId)
    expect(rows[0]!.after_value).toBe(toSubintentId)
  })

  it('does not insert a message row (no system notice)', async () => {
    const workspaceId = await seedWorkspace()
    const intentId = await seedIntent(workspaceId)
    const fromSubintentId = await seedSubintent({ workspaceId, intentId })
    const toSubintentId = await seedSubintent({ workspaceId, intentId })
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open', subintentId: fromSubintentId })
    const { token } = await setupAgent(workspaceId)

    await request(app)
      .patch(`/conversations/${conversationId}/subintent`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentId: toSubintentId })
      .expect(200)

    const { rows } = await ownerPool.query(
      `select id from message where conversation_id = $1`,
      [conversationId],
    )
    expect(rows).toHaveLength(0)
  })
})
