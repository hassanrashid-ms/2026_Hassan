import { createServer } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/shared/db/client.ts'
import { errorMiddleware } from '../src/errors.ts'
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts'
import { articlesRouter } from '../src/agent/routers/articlesRouter.ts'
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts'
import { deleteArticleObject, upsertArticleObject } from '../src/shared/weaviate/articlesIndex.ts'

vi.mock('../src/shared/weaviate/articlesIndex.ts', () => ({
  upsertArticleObject: vi.fn().mockResolvedValue(undefined),
  deleteArticleObject: vi.fn().mockResolvedValue(undefined),
}))

const app = express()
app.use(express.json())
app.use(requireAgentSession, articlesRouter)
app.use(errorMiddleware)

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
  vi.mocked(upsertArticleObject).mockClear()
  vi.mocked(deleteArticleObject).mockClear()
})

async function seedAgent(workspaceId: string): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Test Agent') returning id`,
    [`agent-${Math.random().toString(36).slice(2)}@example.test`],
  )
  const agentId = rows[0]!.id
  await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
    workspaceId,
    agentId,
  ])
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })
  return { agentId, token }
}

describe('POST /articles', () => {
  it('creates a draft', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgent(workspaceId)

    const res = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'How to reset your password', body: 'Go to settings...' })
      .expect(201)

    expect(res.body).toMatchObject({ title: 'How to reset your password', state: 'draft', intent_id: null })
  })

  it('404s when intent_id belongs to another workspace', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [workspaceB],
    )
    const { token } = await seedAgent(workspaceA)

    await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', body: 'Y', intent_id: rows[0]!.id })
      .expect(404)
  })

  it('persists keywords on create and update', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgent(workspaceId)

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', body: 'Y', keywords: ['refund', 'billing'] })
      .expect(201)
    expect(created.body.keywords).toEqual(['refund', 'billing'])

    const patched = await request(app)
      .patch(`/articles/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ keywords: ['refund'] })
      .expect(200)
    expect(patched.body.keywords).toEqual(['refund'])
  })

  it('defaults keywords to an empty array when omitted', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgent(workspaceId)

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', body: 'Y' })
      .expect(201)
    expect(created.body.keywords).toEqual([])
  })
})

describe('draft -> publish -> archive', () => {
  it('walks the full state machine', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgent(workspaceId)

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', body: 'Y' })
      .expect(201)
    const id = created.body.id as string

    const patched = await request(app)
      .patch(`/articles/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Updated title' })
      .expect(200)
    expect(patched.body.title).toBe('Updated title')

    const published = await request(app).post(`/articles/${id}/publish`).set('Authorization', `Bearer ${token}`).expect(200)
    expect(published.body.state).toBe('published')
    expect(published.body.published_by).toBeTruthy()
    expect(published.body.published_at).toBeTruthy()

    await request(app)
      .patch(`/articles/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Should fail' })
      .expect(409)

    await request(app).post(`/articles/${id}/publish`).set('Authorization', `Bearer ${token}`).expect(409)

    const archived = await request(app).post(`/articles/${id}/archive`).set('Authorization', `Bearer ${token}`).expect(200)
    expect(archived.body.state).toBe('archived')
  })

  it('refuses to publish empty title or body with 409', async () => {
    const workspaceId = await seedWorkspace()
    const { agentId } = await seedAgent(workspaceId)
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into article (workspace_id, title, body, created_by) values ($1, ' ', ' ', $2) returning id`,
      [workspaceId, agentId],
    )
    const { token } = await seedAgent(workspaceId)

    await request(app).post(`/articles/${rows[0]!.id}/publish`).set('Authorization', `Bearer ${token}`).expect(409)
  })

  it('archive succeeds from any state, unlike patch and publish', async () => {
    const workspaceId = await seedWorkspace()
    const { agentId } = await seedAgent(workspaceId)
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into article (workspace_id, title, body, state, created_by, published_at)
       values ($1, 'X', 'Y', 'published', $2, now()) returning id`,
      [workspaceId, agentId],
    )
    const { token } = await seedAgent(workspaceId)

    await request(app).post(`/articles/${rows[0]!.id}/archive`).set('Authorization', `Bearer ${token}`).expect(200)
  })

  it('upserts the Weaviate object on publish and deletes it on archive', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgent(workspaceId)

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', body: 'Y', keywords: ['k'] })
      .expect(201)
    const id = created.body.id as string

    await request(app).post(`/articles/${id}/publish`).set('Authorization', `Bearer ${token}`).expect(200)
    expect(upsertArticleObject).toHaveBeenCalledWith(
      expect.objectContaining({ id, title: 'X', body: 'Y', keywords: ['k'] }),
    )

    await request(app).post(`/articles/${id}/archive`).set('Authorization', `Bearer ${token}`).expect(200)
    expect(deleteArticleObject).toHaveBeenCalledWith(id)
  })

  it('does not advance state when the Weaviate publish call fails', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgent(workspaceId)
    vi.mocked(upsertArticleObject).mockRejectedValueOnce(new Error('weaviate unreachable'))

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', body: 'Y' })
      .expect(201)
    const id = created.body.id as string

    await request(app).post(`/articles/${id}/publish`).set('Authorization', `Bearer ${token}`).expect(500)

    const { rows } = await ownerPool.query<{ state: string }>(`select state from article where id = $1`, [id])
    expect(rows[0]!.state).toBe('draft')
  })
})

describe('workspace isolation', () => {
  it('GET /articles/:id 404s for another workspace article', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const { agentId } = await seedAgent(workspaceB)
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into article (workspace_id, title, body, created_by) values ($1, 'X', 'Y', $2) returning id`,
      [workspaceB, agentId],
    )
    const { token } = await seedAgent(workspaceA)

    await request(app).get(`/articles/${rows[0]!.id}`).set('Authorization', `Bearer ${token}`).expect(404)
  })
})
