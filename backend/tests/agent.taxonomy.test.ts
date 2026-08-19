import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { errorMiddleware } from '../src/errors.ts'
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts'
import { taxonomyRouter } from '../src/agent/routers/taxonomyRouter.ts'
import { closeOwnerPool, ownerPool, seedArticle, seedIntent, seedSubintent, seedWorkspace, truncateAll } from './helpers/db.ts'

// Standalone app carrying just this router, gated by the real
// requireAgentSession/requireAdminRole middleware — mirrors
// agent.conversations.test.ts's rationale: this keeps the test from racing
// Task 3's edits to backend/src/surface/router.ts, and from needing
// backend/src/agent/router.ts wired before this task's own Step 8 does it.
const app = express()
app.use(express.json())
app.use(requireAgentSession, taxonomyRouter)
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

async function seedAgentWithRole(workspaceId: string, role: 'agent' | 'admin'): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Test Agent') returning id`,
    [`${role}-${Math.random().toString(36).slice(2)}@example.test`],
  )
  const agentId = rows[0]!.id
  await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, $3)`, [
    workspaceId,
    agentId,
    role,
  ])
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })
  return { agentId, token }
}

describe('GET /intents', () => {
  it('lists intents with nested subintents for any role', async () => {
    const workspaceId = await seedWorkspace()
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [workspaceId],
    )
    await ownerPool.query(`insert into subintent (workspace_id, intent_id, name) values ($1, $2, 'Refunds')`, [
      workspaceId,
      rows[0]!.id,
    ])
    const { token } = await seedAgentWithRole(workspaceId, 'agent')

    const res = await request(app).get('/intents').set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.intents).toHaveLength(1)
    expect(res.body.intents[0]).toEqual({
      id: rows[0]!.id,
      name: 'Billing',
      isSystem: false,
      archivedAt: null,
      subintents: [
        { id: expect.any(String), name: 'Refunds', formId: null, archivedAt: null, defaultPriority: null, mergedIntoId: null },
      ],
    })
  })
})

describe('POST /intents', () => {
  it('creates an intent for an admin', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    const res = await request(app)
      .post('/intents')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Billing' })
      .expect(201)

    expect(res.body).toEqual({ id: expect.any(String), name: 'Billing' })
  })

  it('refuses a non-admin agent with 403, not 404', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'agent')

    await request(app).post('/intents').set('Authorization', `Bearer ${token}`).send({ name: 'Billing' }).expect(403)
  })
})

describe('POST /intents/:id/subintents', () => {
  it('creates a subintent for an admin', async () => {
    const workspaceId = await seedWorkspace()
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [workspaceId],
    )
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    const res = await request(app)
      .post(`/intents/${rows[0]!.id}/subintents`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Refunds' })
      .expect(201)

    expect(res.body).toEqual({ id: expect.any(String), name: 'Refunds', intent_id: rows[0]!.id })
  })

  it('404s for an intent id from another workspace — invisible under RLS', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [workspaceB],
    )
    const { token } = await seedAgentWithRole(workspaceA, 'admin')

    await request(app)
      .post(`/intents/${rows[0]!.id}/subintents`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Refunds' })
      .expect(404)
  })
})

describe('PATCH /intents/:id', () => {
  it('renames an intent for an admin', async () => {
    const workspaceId = await seedWorkspace()
    const intentId = await seedIntent(workspaceId, 'Billing')
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    const res = await request(app)
      .patch(`/intents/${intentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Payments' })
      .expect(200)

    expect(res.body).toEqual({ id: intentId, name: 'Payments' })
  })

  it('409s on a name collision with another intent in the workspace', async () => {
    const workspaceId = await seedWorkspace()
    await seedIntent(workspaceId, 'Payments')
    const intentId = await seedIntent(workspaceId, 'Billing')
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    await request(app)
      .patch(`/intents/${intentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Payments' })
      .expect(409)
  })

  it('refuses a non-admin agent with 403', async () => {
    const workspaceId = await seedWorkspace()
    const intentId = await seedIntent(workspaceId, 'Billing')
    const { token } = await seedAgentWithRole(workspaceId, 'agent')

    await request(app)
      .patch(`/intents/${intentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Payments' })
      .expect(403)
  })

  it('404s for an unknown intent id', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    await request(app)
      .patch(`/intents/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Payments' })
      .expect(404)
  })
})

describe('POST /intents/:id/archive', () => {
  it('archives an intent with no active subintents or published articles', async () => {
    const workspaceId = await seedWorkspace()
    const intentId = await seedIntent(workspaceId, 'Billing')
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    const res = await request(app).post(`/intents/${intentId}/archive`).set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body).toEqual({ id: intentId, name: 'Billing', archivedAt: expect.any(String) })
  })

  it('409s for the isSystem intent', async () => {
    const workspaceId = await seedWorkspace()
    const intentId = await seedIntent(workspaceId, 'Other', true)
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    await request(app).post(`/intents/${intentId}/archive`).set('Authorization', `Bearer ${token}`).expect(409)
  })

  it('409s while a non-archived subintent still points at it', async () => {
    const workspaceId = await seedWorkspace()
    const intentId = await seedIntent(workspaceId, 'Billing')
    await seedSubintent({ workspaceId, intentId, name: 'Refunds' })
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    await request(app).post(`/intents/${intentId}/archive`).set('Authorization', `Bearer ${token}`).expect(409)
  })

  it('409s while a published article still points at it', async () => {
    const workspaceId = await seedWorkspace()
    const intentId = await seedIntent(workspaceId, 'Billing')
    const { agentId, token } = await seedAgentWithRole(workspaceId, 'admin')
    const articleId = await seedArticle({ workspaceId, createdBy: agentId, title: 'Refund policy' })
    await ownerPool.query(`update article set intent_id = $1, state = 'published' where id = $2`, [intentId, articleId])

    await request(app).post(`/intents/${intentId}/archive`).set('Authorization', `Bearer ${token}`).expect(409)
  })
})
