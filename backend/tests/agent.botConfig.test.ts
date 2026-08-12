import { createServer } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { errorMiddleware } from '../src/errors.ts'
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts'
import { botConfigRouter } from '../src/agent/routers/botConfigRouter.ts'
import { DEFAULT_BOT_PROMPT, DEFAULT_BOT_RULES, buildSystemPrompt } from '../src/domain/bot/defaultPrompt.ts'
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts'

// Standalone app carrying just this router behind the real session and role
// middleware — same rationale as agent.taxonomy.test.ts: it keeps this suite off
// the shared app wiring.
const app = express()
app.use(express.json())
app.use(requireAgentSession, botConfigRouter)
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
): Promise<{ agentId: string; token: string }> {
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

describe('GET /bot-config', () => {
  it('resolves an absent row to the off state on the defaults', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    const res = await request(app).get('/bot-config').set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body).toEqual({
      is_provisioned: false,
      prompt: DEFAULT_BOT_PROMPT,
      rules: DEFAULT_BOT_RULES,
      system_prompt: buildSystemPrompt(DEFAULT_BOT_PROMPT, DEFAULT_BOT_RULES),
      is_prompt_customized: false,
      is_rules_customized: false,
      updated_at: null,
    })
  })

  it('reports a stored prompt verbatim and marks only that field customised', async () => {
    const workspaceId = await seedWorkspace()
    await ownerPool.query(
      `insert into bot_config (workspace_id, is_provisioned, prompt) values ($1, true, 'Custom prompt')`,
      [workspaceId],
    )
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    const res = await request(app).get('/bot-config').set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.is_provisioned).toBe(true)
    expect(res.body.prompt).toBe('Custom prompt')
    expect(res.body.rules).toBe(DEFAULT_BOT_RULES)
    expect(res.body.is_prompt_customized).toBe(true)
    expect(res.body.is_rules_customized).toBe(false)
    expect(res.body.system_prompt).toBe(buildSystemPrompt('Custom prompt', DEFAULT_BOT_RULES))
    expect(typeof res.body.updated_at).toBe('string')
  })

  // The matrix row is "See bot config" — Team Lead ✓, Admin ✓.
  it('admits a team lead, who may see the config but not edit it', async () => {
    const workspaceId = await seedWorkspace()
    await ownerPool.query(`insert into bot_config (workspace_id, prompt) values ($1, 'Custom prompt')`, [workspaceId])
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead')

    const res = await request(app).get('/bot-config').set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.prompt).toBe('Custom prompt')
  })

  it('refuses a plain agent with 403', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'agent')

    await request(app).get('/bot-config').set('Authorization', `Bearer ${token}`).expect(403)
  })

  it('refuses an unauthenticated request with 401', async () => {
    await request(app).get('/bot-config').expect(401)
  })

  it('never leaks another workspace config', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    await ownerPool.query(`insert into bot_config (workspace_id, is_provisioned, prompt) values ($1, true, 'B prompt')`, [
      workspaceB,
    ])
    const { token } = await seedAgentWithRole(workspaceA, 'admin')

    const res = await request(app).get('/bot-config').set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.prompt).toBe(DEFAULT_BOT_PROMPT)
    expect(res.body.is_provisioned).toBe(false)
  })
})

describe('POST /bot-config', () => {
  it('creates the row on a first save and returns the resolved view', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_provisioned: true, prompt: 'Custom prompt' })
      .expect(200)

    expect(res.body.is_provisioned).toBe(true)
    expect(res.body.prompt).toBe('Custom prompt')
    expect(res.body.rules).toBe(DEFAULT_BOT_RULES)
    expect(res.body.is_prompt_customized).toBe(true)
    expect(res.body.is_rules_customized).toBe(false)

    const { rows } = await ownerPool.query<{ prompt: string | null; is_provisioned: boolean }>(
      `select prompt, is_provisioned from bot_config where workspace_id = $1`,
      [workspaceId],
    )
    expect(rows[0]).toEqual({ prompt: 'Custom prompt', is_provisioned: true })
  })

  it('writes one audit row per changed field, attributed to the caller', async () => {
    const workspaceId = await seedWorkspace()
    const { agentId, token } = await seedAgentWithRole(workspaceId, 'admin')

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_provisioned: true, prompt: 'Custom prompt' })
      .expect(200)

    const { rows } = await ownerPool.query<{ field: string; actor_id: string }>(
      `select field, actor_id from change_log
        where entity_type = 'bot_config' and entity_id = $1 order by field`,
      [workspaceId],
    )
    expect(rows.map((row) => row.field)).toEqual(['is_provisioned', 'prompt'])
    expect(rows.every((row) => row.actor_id === agentId)).toBe(true)
  })

  it('leaves an omitted field alone and audits nothing for it', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: 'First', rules: 'Rule one' })
      .expect(200)
    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: 'Second' })
      .expect(200)

    expect(res.body.prompt).toBe('Second')
    expect(res.body.rules).toBe('Rule one')

    const { rows } = await ownerPool.query<{ field: string }>(
      `select field from change_log where entity_type = 'bot_config' and entity_id = $1`,
      [workspaceId],
    )
    expect(rows.filter((row) => row.field === 'rules')).toHaveLength(1)
  })

  it('treats explicit null as a reset to the default and audits it', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    await request(app).post('/bot-config').set('Authorization', `Bearer ${token}`).send({ prompt: 'Custom' }).expect(200)
    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: null })
      .expect(200)

    expect(res.body.prompt).toBe(DEFAULT_BOT_PROMPT)
    expect(res.body.is_prompt_customized).toBe(false)

    const { rows } = await ownerPool.query<{ before_value: unknown; after_value: unknown }>(
      `select before_value, after_value from change_log
        where entity_type = 'bot_config' and entity_id = $1 and field = 'prompt'
        order by changed_at desc, id desc limit 1`,
      [workspaceId],
    )
    expect(rows[0]).toEqual({ before_value: 'Custom', after_value: null })
  })

  it('is an upsert — a second save does not error', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_provisioned: true })
      .expect(200)
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_provisioned: false })
      .expect(200)

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*)::text as count from bot_config where workspace_id = $1`,
      [workspaceId],
    )
    expect(rows[0]!.count).toBe('1')
  })

  it('rejects a whitespace-only value with 422 naming the offending column', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ rules: '   ' })
      .expect(422)

    expect(res.body.error.message).toContain('rules')

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*)::text as count from bot_config where workspace_id = $1`,
      [workspaceId],
    )
    expect(rows[0]!.count).toBe('0')
  })

  it('rejects an empty body and an unknown key with 422', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    await request(app).post('/bot-config').set('Authorization', `Bearer ${token}`).send({}).expect(422)
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ provisioned: true })
      .expect(422)
  })

  // Editing is Admin-only in the matrix, so a Team Lead who CAN read the config is
  // still refused here. This is the case that proves read and write are separate
  // gates rather than one copy-pasted middleware.
  it('refuses a team lead with 403 and writes nothing', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead')

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: 'Lead tried to edit' })
      .expect(403)

    await request(app).get('/bot-config').set('Authorization', `Bearer ${token}`).expect(200)

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*)::text as count from bot_config where workspace_id = $1`,
      [workspaceId],
    )
    expect(rows[0]!.count).toBe('0')
  })

  it('refuses a plain agent with 403 and writes nothing', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'agent')

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_provisioned: true })
      .expect(403)

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*)::text as count from bot_config where workspace_id = $1`,
      [workspaceId],
    )
    expect(rows[0]!.count).toBe('0')
  })

  it('writes no audit row when the caller was refused', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead')

    await request(app).post('/bot-config').set('Authorization', `Bearer ${token}`).send({ prompt: 'x' }).expect(403)

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*)::text as count from change_log where entity_id = $1`,
      [workspaceId],
    )
    expect(rows[0]!.count).toBe('0')
  })

  it('writes only the caller workspace row', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceA, 'admin')

    await request(app).post('/bot-config').set('Authorization', `Bearer ${token}`).send({ prompt: 'A' }).expect(200)

    const { rows } = await ownerPool.query<{ workspace_id: string }>(`select workspace_id from bot_config`)
    expect(rows.map((row) => row.workspace_id)).toEqual([workspaceA])
    expect(rows.map((row) => row.workspace_id)).not.toContain(workspaceB)
  })
})

describe('GET /bot-config/history', () => {
  it('returns an empty trail before anything is saved', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    const res = await request(app).get('/bot-config/history').set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body).toEqual({ entries: [], next_cursor: null })
  })

  it('returns the trail newest-first with column names, actor and null semantics', async () => {
    const workspaceId = await seedWorkspace()
    const { agentId, token } = await seedAgentWithRole(workspaceId, 'admin')

    await request(app).post('/bot-config').set('Authorization', `Bearer ${token}`).send({ prompt: 'First' }).expect(200)
    await request(app).post('/bot-config').set('Authorization', `Bearer ${token}`).send({ prompt: null }).expect(200)

    const res = await request(app).get('/bot-config/history').set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.entries).toHaveLength(2)
    expect(res.body.entries[0]).toEqual({
      id: expect.any(String),
      field: 'prompt',
      before_value: 'First',
      after_value: null,
      actor: { id: agentId, display_name: 'Test Agent', email: expect.any(String) },
      changed_at: expect.any(String),
    })
    // The first-ever set: before is null, and that is a different fact from the clear above.
    expect(res.body.entries[1].before_value).toBeNull()
    expect(res.body.entries[1].after_value).toBe('First')
    expect(res.body.next_cursor).toBeNull()
  })

  it('pages with limit and next_cursor', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_provisioned: true, prompt: 'First', rules: 'Rule one' })
      .expect(200)

    const first = await request(app)
      .get('/bot-config/history?limit=2')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(first.body.entries).toHaveLength(2)
    expect(first.body.next_cursor).toEqual(expect.any(String))

    const second = await request(app)
      .get(`/bot-config/history?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(second.body.entries).toHaveLength(1)
    expect(second.body.next_cursor).toBeNull()

    const ids = [...first.body.entries, ...second.body.entries].map((entry: { id: string }) => entry.id)
    expect(new Set(ids).size).toBe(3)
  })

  it('rejects a bad limit and an undecodable cursor with 422', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    await request(app).get('/bot-config/history?limit=0').set('Authorization', `Bearer ${token}`).expect(422)
    await request(app).get('/bot-config/history?limit=201').set('Authorization', `Bearer ${token}`).expect(422)
    await request(app).get('/bot-config/history?cursor=not-a-cursor!!').set('Authorization', `Bearer ${token}`).expect(422)
  })

  it('never returns another workspace trail', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const { token: tokenB } = await seedAgentWithRole(workspaceB, 'admin')
    await request(app).post('/bot-config').set('Authorization', `Bearer ${tokenB}`).send({ prompt: 'B' }).expect(200)
    const { token: tokenA } = await seedAgentWithRole(workspaceA, 'admin')

    const res = await request(app).get('/bot-config/history').set('Authorization', `Bearer ${tokenA}`).expect(200)

    expect(res.body.entries).toEqual([])
  })

  // Filed under "See bot config" — a Team Lead who can read the current prompt is
  // not kept from reading the previous one.
  it('admits a team lead', async () => {
    const workspaceId = await seedWorkspace()
    const { token: adminToken } = await seedAgentWithRole(workspaceId, 'admin')
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ prompt: 'First' })
      .expect(200)
    const { token: leadToken } = await seedAgentWithRole(workspaceId, 'team_lead')

    const res = await request(app).get('/bot-config/history').set('Authorization', `Bearer ${leadToken}`).expect(200)

    expect(res.body.entries).toHaveLength(1)
  })

  it('refuses a plain agent with 403', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'agent')

    await request(app).get('/bot-config/history').set('Authorization', `Bearer ${token}`).expect(403)
  })
})
