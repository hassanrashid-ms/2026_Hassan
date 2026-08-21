import express from 'express'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { errorMiddleware } from '../src/errors.ts'
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts'
import { requireWorkspaceRole } from '../src/shared/middleware/requireWorkspaceRole.ts'
import { requireAdminRole } from '../src/shared/middleware/requireAdminRole.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { closeOwnerPool, ownerPool, seedAgent, seedWorkspace, truncateAll } from './helpers/db.ts'

const app = express()
app.use(express.json())
app.use('/leads-and-admins', requireAgentSession, requireWorkspaceRole('team_lead'), (_req, res) => {
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
  role: 'agent' | 'team_lead',
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
    for (const role of ['team_lead'] as const) {
      const token = await tokenForRole(workspaceId, role)
      await request(app).get('/leads-and-admins').set('Authorization', `Bearer ${token}`).expect(200)
    }
  })

  it('refuses a role outside the set with 403', async () => {
    const workspaceId = await seedWorkspace()
    const token = await tokenForRole(workspaceId, 'agent')
    await request(app).get('/leads-and-admins').set('Authorization', `Bearer ${token}`).expect(403)
  })

  it('refuses a deactivated team lead', async () => {
    const workspaceId = await seedWorkspace()
    const token = await tokenForRole(workspaceId, 'team_lead', { deactivated: true })
    await request(app).get('/leads-and-admins').set('Authorization', `Bearer ${token}`).expect(403)
  })

  it('requires authentication before it can check a role', async () => {
    await request(app).get('/leads-and-admins').expect(401)
  })
})

describe('requireAdminRole (global)', () => {
  it('admits a globally is_admin agent regardless of which workspace their session names', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const adminId = await seedAgent(undefined, { isAdmin: true })
    // Session names workspace A; is_admin is global, so this must still pass —
    // unlike the old per-workspace admin, no workspace_member row exists at all.
    const token = await signAgentSession({ agent_id: adminId, workspace_id: workspaceA })
    await request(app).get('/admins-only').set('Authorization', `Bearer ${token}`).expect(200)
    // Same agent, session naming the OTHER workspace — still admitted, because
    // the flag is global, not tied to either workspace.
    const tokenB = await signAgentSession({ agent_id: adminId, workspace_id: workspaceB })
    await request(app).get('/admins-only').set('Authorization', `Bearer ${tokenB}`).expect(200)
  })

  it('refuses a non-admin agent', async () => {
    const workspaceId = await seedWorkspace()
    const agentId = await seedAgent()
    const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })
    await request(app).get('/admins-only').set('Authorization', `Bearer ${token}`).expect(403)
  })
})
