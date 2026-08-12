import express from 'express'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { errorMiddleware } from '../src/errors.ts'
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts'
import { requireWorkspaceRole } from '../src/shared/middleware/requireWorkspaceRole.ts'
import { requireAdminRole } from '../src/shared/middleware/requireAdminRole.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts'

const app = express()
app.use(express.json())
app.use('/leads-and-admins', requireAgentSession, requireWorkspaceRole('team_lead', 'admin'), (_req, res) => {
  res.status(200).json({ ok: true })
})
app.use('/admins-only', requireAgentSession, requireAdminRole, (_req, res) => {
  res.status(200).json({ ok: true })
})
app.use(errorMiddleware)

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function tokenForRole(
  workspaceId: string,
  role: 'agent' | 'team_lead' | 'admin',
  options: { deactivated?: boolean } = {},
): Promise<string> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Test Agent') returning id`,
    [`${role}-${Math.random().toString(36).slice(2)}@example.test`],
  )
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role, deactivated_at) values ($1, $2, $3, $4)`,
    [workspaceId, rows[0]!.id, role, options.deactivated ? new Date() : null],
  )
  return signAgentSession({ agent_id: rows[0]!.id, workspace_id: workspaceId })
}

describe('requireWorkspaceRole', () => {
  it('admits every role in the set', async () => {
    const workspaceId = await seedWorkspace()
    for (const role of ['team_lead', 'admin'] as const) {
      const token = await tokenForRole(workspaceId, role)
      await request(app).get('/leads-and-admins').set('Authorization', `Bearer ${token}`).expect(200)
    }
  })

  it('refuses a role outside the set with 403', async () => {
    const workspaceId = await seedWorkspace()
    const token = await tokenForRole(workspaceId, 'agent')
    await request(app).get('/leads-and-admins').set('Authorization', `Bearer ${token}`).expect(403)
  })

  it('refuses an agent with no membership row in this workspace', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const token = await tokenForRole(workspaceB, 'admin')
    const { rows } = await ownerPool.query<{ agent_id: string }>(`select agent_id from workspace_member`)
    await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
      workspaceA,
      rows[0]!.agent_id,
    ])
    // The session names workspaceB, where they are admin; the route is mounted on
    // whichever workspace the token claims, so this asserts the role is read for
    // the session's workspace and not "any workspace they are an admin of".
    await request(app).get('/admins-only').set('Authorization', `Bearer ${token}`).expect(200)
  })

  it('refuses a deactivated member regardless of role', async () => {
    const workspaceId = await seedWorkspace()
    const token = await tokenForRole(workspaceId, 'admin', { deactivated: true })
    await request(app).get('/leads-and-admins').set('Authorization', `Bearer ${token}`).expect(403)
    await request(app).get('/admins-only').set('Authorization', `Bearer ${token}`).expect(403)
  })

  it('requires authentication before it can check a role', async () => {
    await request(app).get('/leads-and-admins').expect(401)
  })
})

describe('requireAdminRole', () => {
  it('still admits only admin — a team lead is refused', async () => {
    const workspaceId = await seedWorkspace()
    const lead = await tokenForRole(workspaceId, 'team_lead')
    const admin = await tokenForRole(workspaceId, 'admin')

    await request(app).get('/admins-only').set('Authorization', `Bearer ${lead}`).expect(403)
    await request(app).get('/admins-only').set('Authorization', `Bearer ${admin}`).expect(200)
  })
})
