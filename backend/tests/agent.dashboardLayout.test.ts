import express from 'express'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts'
import { errorMiddleware } from '../src/errors.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { analyticsRouter } from '../src/agent/routers/analyticsRouter.ts'
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts'

const app = express()
app.use(express.json())
app.use(requireAgentSession, analyticsRouter)
app.use(errorMiddleware)

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function setupAgent(workspaceId: string, email = 'agent1@example.test') {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Test Agent') returning id`,
    [email],
  )
  const agentId = rows[0]!.id
  await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
    workspaceId,
    agentId,
  ])
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })
  return { agentId, token }
}

describe('GET /agent/analytics/layout', () => {
  it('returns the default layout when the agent has no saved row', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await setupAgent(workspaceId)

    const res = await request(app).get('/analytics/layout').set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.layout.items.length).toBeGreaterThan(0)
  })
})

describe('PUT /agent/analytics/layout', () => {
  it('round-trips a saved layout', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await setupAgent(workspaceId)
    const layout = { items: [{ i: 'volume-series', x: 0, y: 0, w: 4, h: 2 }], visibleTileIds: ['volume-series'] }

    await request(app).put('/analytics/layout').set('Authorization', `Bearer ${token}`).send({ layout }).expect(200)
    const res = await request(app).get('/analytics/layout').set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.layout).toEqual(layout)
  })

  it("does not affect another agent's layout in the same workspace", async () => {
    const workspaceId = await seedWorkspace()
    const agentA = await setupAgent(workspaceId, 'agent1@example.test')
    const agentB = await setupAgent(workspaceId, 'agent2@example.test')

    const layoutA = { items: [{ i: 'x', x: 0, y: 0, w: 1, h: 1 }], visibleTileIds: ['x'] }
    await request(app).put('/analytics/layout').set('Authorization', `Bearer ${agentA.token}`).send({ layout: layoutA }).expect(200)

    const resB = await request(app).get('/analytics/layout').set('Authorization', `Bearer ${agentB.token}`).expect(200)
    expect(resB.body.layout).not.toEqual(layoutA)
  })
})
