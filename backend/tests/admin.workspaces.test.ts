import { randomUUID } from 'node:crypto'
import express from 'express'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { closeAdminDb } from '../src/shared/db/adminClient.ts'
import { errorMiddleware } from '../src/errors.ts'
import { adminRouter } from '../src/admin/router.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { closeOwnerPool, ownerPool, seedAgent, seedWorkspace, seedWorkspaceMember, truncateAll } from './helpers/db.ts'

const app = express()
app.use(express.json())
app.use('/admin', adminRouter)
app.use(errorMiddleware)

afterAll(async () => {
  await closeDb()
  await closeAdminDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function adminToken(workspaceId: string): Promise<string> {
  const agentId = await seedAgent(undefined, { isAdmin: true })
  return signAgentSession({ agent_id: agentId, workspace_id: workspaceId })
}

describe('GET /admin/workspaces', () => {
  it('lists every workspace with its member count, in one call, across tenants', async () => {
    const workspaceA = await seedWorkspace({ name: 'Game A' })
    const workspaceB = await seedWorkspace({ name: 'Game B' })
    const memberAgent = await seedAgent()
    await seedWorkspaceMember({ workspaceId: workspaceA, agentId: memberAgent })
    const token = await adminToken(workspaceA)

    const res = await request(app).get('/admin/workspaces').set('Authorization', `Bearer ${token}`).expect(200)

    const byId = new Map(res.body.workspaces.map((w: any) => [w.id, w]))
    expect(byId.get(workspaceA)).toMatchObject({ name: 'Game A', member_count: 1 })
    expect(byId.get(workspaceB)).toMatchObject({ name: 'Game B', member_count: 0 })
  })
})

describe('POST /admin/workspaces', () => {
  it('creates a workspace', async () => {
    const workspaceId = await seedWorkspace()
    const token = await adminToken(workspaceId)

    const res = await request(app)
      .post('/admin/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Game', slug: 'new-game' })
      .expect(201)

    expect(res.body).toMatchObject({ name: 'New Game', slug: 'new-game', member_count: 0 })
    const { rows } = await ownerPool.query(`select * from workspace where slug = 'new-game'`)
    expect(rows).toHaveLength(1)
  })

  it('rejects a duplicate slug with 422', async () => {
    const workspaceId = await seedWorkspace({ slug: 'taken' })
    const token = await adminToken(workspaceId)

    await request(app)
      .post('/admin/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Other', slug: 'taken' })
      .expect(422)
  })

  it('refuses a non-admin agent with 403', async () => {
    const workspaceId = await seedWorkspace()
    const agentId = await seedAgent()
    const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })

    await request(app)
      .post('/admin/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nope', slug: 'nope' })
      .expect(403)
  })
})

describe('PATCH /admin/workspaces/:id', () => {
  it('renames a workspace, leaving its slug untouched', async () => {
    const workspaceId = await seedWorkspace({ name: 'Old Name', slug: 'stays-put' })
    const token = await adminToken(workspaceId)

    const res = await request(app)
      .patch(`/admin/workspaces/${workspaceId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name' })
      .expect(200)

    expect(res.body).toMatchObject({ name: 'New Name', slug: 'stays-put' })
  })

  it('returns 404 for an unknown workspace id', async () => {
    const workspaceId = await seedWorkspace()
    const token = await adminToken(workspaceId)

    await request(app)
      .patch(`/admin/workspaces/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name' })
      .expect(404)
  })
})
