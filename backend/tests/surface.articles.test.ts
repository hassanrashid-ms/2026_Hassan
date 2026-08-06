import express from 'express'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/shared/db/client.ts'
import { errorMiddleware } from '../src/errors.ts'
import { requirePlayerToken } from '../src/shared/middleware/requirePlayerToken.ts'
import { articlesRouter } from '../src/surface/routers/articlesRouter.ts'
import { closeOwnerPool, ownerPool, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'
import { mintToken } from './helpers/app.ts'

const app = express()
app.use(express.json())
app.use(requirePlayerToken, articlesRouter)
app.use(errorMiddleware)

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function fixture() {
  const workspaceId = await seedWorkspace()
  const playerId = await seedPlayer(workspaceId)
  const token = await mintToken({ workspace_id: workspaceId, player_id: playerId, external_player_id: 'p-1' })
  return { workspaceId, playerId, token }
}

async function seedArticle(workspaceId: string, overrides: Partial<{ title: string; body: string; state: string; intentId: string | null }> = {}) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'A') returning id`,
    [`a-${Math.random().toString(36).slice(2)}@example.test`],
  )
  const agentId = rows[0]!.id
  const { rows: articleRows } = await ownerPool.query<{ id: string }>(
    `insert into article (workspace_id, intent_id, title, body, state, created_by, published_at)
     values ($1, $2, $3, $4, $5::article_state, $6, case when $5::text = 'published' then now() else null end) returning id`,
    [
      workspaceId,
      overrides.intentId ?? null,
      overrides.title ?? 'How to reset your password',
      overrides.body ?? 'Go to settings and tap reset.',
      overrides.state ?? 'published',
      agentId,
    ],
  )
  return articleRows[0]!.id
}

describe('GET /articles', () => {
  it('returns only published articles', async () => {
    const { workspaceId, token } = await fixture()
    await seedArticle(workspaceId, { state: 'published', title: 'Published one' })
    await seedArticle(workspaceId, { state: 'draft', title: 'Draft one' })

    const res = await request(app).get('/articles').set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.articles).toHaveLength(1)
    expect(res.body.articles[0].title).toBe('Published one')
  })

  it('filters by keyword across title and body', async () => {
    const { workspaceId, token } = await fixture()
    await seedArticle(workspaceId, { title: 'Refund policy', body: 'We refund within 30 days.' })
    await seedArticle(workspaceId, { title: 'Password reset', body: 'Tap reset.' })

    const res = await request(app).get('/articles').query({ q: 'refund' }).set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.articles).toHaveLength(1)
    expect(res.body.articles[0].title).toBe('Refund policy')
  })

  it('returns an empty list, never an error, when nothing matches', async () => {
    const { token } = await fixture()

    const res = await request(app).get('/articles').query({ q: 'nonexistent' }).set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.articles).toEqual([])
  })
})

describe('GET /articles/:id', () => {
  it('returns a published article', async () => {
    const { workspaceId, token } = await fixture()
    const id = await seedArticle(workspaceId, { state: 'published' })

    const res = await request(app).get(`/articles/${id}`).set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.id).toBe(id)
  })

  it('404s for a draft article', async () => {
    const { workspaceId, token } = await fixture()
    const id = await seedArticle(workspaceId, { state: 'draft' })

    await request(app).get(`/articles/${id}`).set('Authorization', `Bearer ${token}`).expect(404)
  })

  it('404s for another workspace article — invisible under RLS', async () => {
    const other = await seedWorkspace()
    const id = await seedArticle(other, { state: 'published' })
    const { token } = await fixture()

    await request(app).get(`/articles/${id}`).set('Authorization', `Bearer ${token}`).expect(404)
  })
})
