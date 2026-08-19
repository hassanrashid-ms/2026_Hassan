import express from 'express'
import { createServer } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FormField } from '@support/types'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { errorMiddleware } from '../src/errors.ts'
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts'
import { formsRouter } from '../src/agent/routers/formsRouter.ts'
import {
  archiveForm,
  createForm,
  getForm,
  publishForm,
  setFormSubintents,
  updateForm,
} from '../src/agent/services/formsService.ts'
import type { AgentContext } from '../src/shared/middleware/requireAgentSession.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedForm,
  seedFormVersion,
  seedIntent,
  seedSubintent,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

const app = express()
app.use(express.json())
app.use(requireAgentSession, formsRouter)
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

async function seedAgentWithRole(
  workspaceId: string,
  role: 'agent' | 'team_lead' | 'admin',
): Promise<{ agentId: string; token: string; ctx: AgentContext }> {
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
  return { agentId, token, ctx: { agentId, workspaceId } }
}

const FIELDS: FormField[] = [
  { key: 'order_id', label: 'Order ID', type: 'short_text', isRequired: true, position: 0 },
]

describe('formsService', () => {
  it('does not auto-fork when the latest version is a draft — edits it in place', async () => {
    const workspaceId = await seedWorkspace()
    const { ctx } = await seedAgentWithRole(workspaceId, 'admin')
    const created = await createForm(ctx, 'Refund')
    expect(created.ok).toBe(true)

    await updateForm(ctx, created.id, { fields: FIELDS })
    const after = await getForm(ctx, created.id)
    expect(after!.draft!.version).toBe(1)
    expect(after!.draft!.fields).toEqual(FIELDS)

    await updateForm(ctx, created.id, { fields: [] })
    const after2 = await getForm(ctx, created.id)
    expect(after2!.draft!.version).toBe(1)
    expect(after2!.draft!.fields).toEqual([])
  })

  it('auto-forks a new draft only when the latest version is published', async () => {
    const workspaceId = await seedWorkspace()
    const { ctx } = await seedAgentWithRole(workspaceId, 'admin')
    const created = await createForm(ctx, 'Refund')
    await updateForm(ctx, created.id, { fields: FIELDS })
    const published = await publishForm(ctx, created.id)
    expect(published.ok).toBe(true)

    const updated = await updateForm(ctx, created.id, { fields: [] })
    expect(updated.ok).toBe(true)
    if (!updated.ok) throw new Error('unreachable')
    expect(updated.form.published!.version).toBe(1)
    expect(updated.form.draft!.version).toBe(2)
    expect(updated.form.draft!.fields).toEqual([])
  })

  it('rejects a field list containing attachment or time', async () => {
    const workspaceId = await seedWorkspace()
    const { ctx } = await seedAgentWithRole(workspaceId, 'admin')
    const created = await createForm(ctx, 'Refund')

    const withAttachment: FormField[] = [
      { key: 'proof', label: 'Proof', type: 'attachment', isRequired: false, position: 0 },
    ]
    const result = await updateForm(ctx, created.id, { fields: withAttachment })
    expect(result).toEqual({ ok: false, reason: 'forbidden_field_type' })
  })

  it('publish rejects when the draft is empty', async () => {
    const workspaceId = await seedWorkspace()
    const { ctx } = await seedAgentWithRole(workspaceId, 'admin')
    const created = await createForm(ctx, 'Refund')

    const result = await publishForm(ctx, created.id)
    expect(result).toEqual({ ok: false, reason: 'empty_draft' })
  })

  it('publish rejects when there is no draft to publish', async () => {
    const workspaceId = await seedWorkspace()
    const { ctx } = await seedAgentWithRole(workspaceId, 'admin')
    const created = await createForm(ctx, 'Refund')
    await updateForm(ctx, created.id, { fields: FIELDS })
    await publishForm(ctx, created.id)

    // Latest version is now published with no draft forked yet.
    const result = await publishForm(ctx, created.id)
    expect(result).toEqual({ ok: false, reason: 'no_draft' })
  })

  it('archive is idempotent', async () => {
    const workspaceId = await seedWorkspace()
    const { ctx } = await seedAgentWithRole(workspaceId, 'admin')
    const created = await createForm(ctx, 'Refund')

    const first = await archiveForm(ctx, created.id)
    expect(first.ok).toBe(true)
    const second = await archiveForm(ctx, created.id)
    expect(second.ok).toBe(true)
  })

  it('setFormSubintents clears the old mapping and applies the new set atomically', async () => {
    const workspaceId = await seedWorkspace()
    const { ctx } = await seedAgentWithRole(workspaceId, 'admin')
    const intentId = await seedIntent(workspaceId)
    const formA = await createForm(ctx, 'Form A')
    const formB = await createForm(ctx, 'Form B')
    const s1 = await seedSubintent({ workspaceId, intentId })
    const s2 = await seedSubintent({ workspaceId, intentId })

    const first = await setFormSubintents(ctx, formA.id, [s1, s2])
    expect(first.ok).toBe(true)

    // Re-mapping s1 to form B must clear it from form A (a subintent maps to at most one form).
    const second = await setFormSubintents(ctx, formB.id, [s1])
    expect(second.ok).toBe(true)

    const formAAfter = await getForm(ctx, formA.id)
    const formBAfter = await getForm(ctx, formB.id)
    expect(formAAfter!.mappedSubintents.map((s) => s.id)).toEqual([s2])
    expect(formBAfter!.mappedSubintents.map((s) => s.id)).toEqual([s1])
  })

  it('rejects a cross-workspace subintent id', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const { ctx } = await seedAgentWithRole(workspaceA, 'admin')
    const intentB = await seedIntent(workspaceB)
    const foreignSubintent = await seedSubintent({ workspaceId: workspaceB, intentId: intentB })
    const formA = await createForm(ctx, 'Form A')

    const result = await setFormSubintents(ctx, formA.id, [foreignSubintent])
    expect(result).toEqual({ ok: false, reason: 'invalid_subintent_ids', invalidIds: [foreignSubintent] })
  })

  it('a subintent never ends up mapped to two forms', async () => {
    const workspaceId = await seedWorkspace()
    const { ctx } = await seedAgentWithRole(workspaceId, 'admin')
    const intentId = await seedIntent(workspaceId)
    const formA = await createForm(ctx, 'Form A')
    const formB = await createForm(ctx, 'Form B')
    const s1 = await seedSubintent({ workspaceId, intentId })

    await setFormSubintents(ctx, formA.id, [s1])
    await setFormSubintents(ctx, formB.id, [s1])

    const { rows } = await ownerPool.query<{ form_id: string }>(`select form_id from subintent where id = $1`, [s1])
    expect(rows[0]!.form_id).toBe(formB.id)
  })
})

describe('forms RLS/tenancy', () => {
  it('a form id from workspace B is invisible to workspace A GET /forms/:id', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const formIdB = await seedForm({ workspaceId: workspaceB })
    const { token } = await seedAgentWithRole(workspaceA, 'admin')

    await request(app).get(`/forms/${formIdB}`).set('Authorization', `Bearer ${token}`).expect(404)
  })

  it('setFormSubintents rejects a subintent id from another workspace via HTTP', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const intentB = await seedIntent(workspaceB)
    const foreignSubintent = await seedSubintent({ workspaceId: workspaceB, intentId: intentB })
    const { token } = await seedAgentWithRole(workspaceA, 'admin')
    const formIdA = await seedForm({ workspaceId: workspaceA })

    await request(app)
      .patch(`/forms/${formIdA}/subintents`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentIds: [foreignSubintent] })
      .expect(422)
  })
})

describe('forms permissions', () => {
  it('an Agent gets 403 on every route', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'agent')
    const formId = await seedForm({ workspaceId })
    await seedFormVersion({ workspaceId, formId, version: 1, fields: [] })

    await request(app).get('/forms').set('Authorization', `Bearer ${token}`).expect(403)
    await request(app).post('/forms').set('Authorization', `Bearer ${token}`).send({ name: 'X' }).expect(403)
    await request(app).get(`/forms/${formId}`).set('Authorization', `Bearer ${token}`).expect(403)
    await request(app).patch(`/forms/${formId}`).set('Authorization', `Bearer ${token}`).send({ name: 'Y' }).expect(403)
    await request(app).post(`/forms/${formId}/publish`).set('Authorization', `Bearer ${token}`).expect(403)
    await request(app).post(`/forms/${formId}/archive`).set('Authorization', `Bearer ${token}`).expect(403)
    await request(app)
      .patch(`/forms/${formId}/subintents`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentIds: [] })
      .expect(403)
  })

  it('a Team Lead gets 403 on publish and archive only, 200 elsewhere', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead')

    const createRes = await request(app)
      .post('/forms')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Team Lead Form' })
      .expect(201)
    const formId = createRes.body.id as string

    await request(app).get('/forms').set('Authorization', `Bearer ${token}`).expect(200)
    await request(app).get(`/forms/${formId}`).set('Authorization', `Bearer ${token}`).expect(200)
    await request(app)
      .patch(`/forms/${formId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fields: FIELDS })
      .expect(200)
    await request(app)
      .patch(`/forms/${formId}/subintents`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subintentIds: [] })
      .expect(200)

    await request(app).post(`/forms/${formId}/publish`).set('Authorization', `Bearer ${token}`).expect(403)
    await request(app).post(`/forms/${formId}/archive`).set('Authorization', `Bearer ${token}`).expect(403)
  })
})
