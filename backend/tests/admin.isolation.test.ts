import express from 'express'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { closeAdminDb } from '../src/shared/db/adminClient.ts'
import { errorMiddleware } from '../src/errors.ts'
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts'
import { requireAdminAccess } from '../src/shared/middleware/requireAdminAccess.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { closeOwnerPool, seedAgent, seedWorkspace, truncateAll } from './helpers/db.ts'

const app = express()
app.use(express.json())
app.use('/admin/probe', requireAgentSession, requireAdminAccess, (_req, res) => {
  res.status(200).json({ ok: true })
})
app.use(errorMiddleware)

afterAll(async () => {
  await closeDb()
  await closeAdminDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

describe('requireAdminAccess', () => {
  it('admits a globally is_admin agent', async () => {
    const workspaceId = await seedWorkspace()
    const agentId = await seedAgent(undefined, { isAdmin: true })
    const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })
    await request(app).get('/admin/probe').set('Authorization', `Bearer ${token}`).expect(200)
  })

  it('refuses a non-admin agent with 403', async () => {
    const workspaceId = await seedWorkspace()
    const agentId = await seedAgent()
    const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })
    await request(app).get('/admin/probe').set('Authorization', `Bearer ${token}`).expect(403)
  })

  it('requires authentication before it can check the flag', async () => {
    await request(app).get('/admin/probe').expect(401)
  })
})
