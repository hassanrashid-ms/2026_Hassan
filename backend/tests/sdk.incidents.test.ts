import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/db/client.ts'
import { withWorkspace } from '../src/db/withWorkspace.ts'
import { event } from '../src/db/schema/index.ts'
import { app, mintToken } from './helpers/app.ts'
import { closeOwnerPool, seedPlayer, seedSession, seedWorkspace, truncateAll } from './helpers/db.ts'

const SESSION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function fixture(slug = 'demo-game') {
  const workspaceId = await seedWorkspace({ slug })
  const playerId = await seedPlayer(workspaceId, 'UserId7661')
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'UserId7661',
  })
  return { workspaceId, playerId, token, slug }
}

const post = (f: { token: string; slug: string }, body: unknown) =>
  request(app)
    .post('/sdk/incidents')
    .set('Authorization', `Bearer ${f.token}`)
    .set('X-Support-Workspace', f.slug)
    .set('X-Support-Sdk', '1.0.2')
    .send(body as object)

const events = (workspaceId: string) => withWorkspace(workspaceId, async (tx) => tx.select().from(event))

describe('POST /sdk/incidents', () => {
  it('appends one system-actor sdk_incident with the reported detail', async () => {
    const f = await fixture()
    await seedSession({ workspaceId: f.workspaceId, playerId: f.playerId, id: SESSION_ID })

    const res = await post(f, {
      incident_id: 'c7a2ffff-4f89-11d3-9a0c-0305e82c3301',
      session_id: SESSION_ID,
      kind: 'token_timeout',
      detail: '5s elapsed, no response',
      sdk_version: '1.0.2',
      client_version: '6.2.01',
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const rows = await events(f.workspaceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('sdk_incident')
    expect(rows[0]!.actorType).toBe('system')
    expect(rows[0]!.actorId).toBeNull()
    expect(rows[0]!.sessionId).toBe(SESSION_ID)
    expect(rows[0]!.payload).toMatchObject({
      kind: 'token_timeout',
      detail: '5s elapsed, no response',
      sdk_version: '1.0.2',
      client_version: '6.2.01',
      incident_id: 'c7a2ffff-4f89-11d3-9a0c-0305e82c3301',
    })
  })

  it('accepts a null session_id — the SDK may fail before a session exists', async () => {
    const f = await fixture()
    await post(f, { session_id: null, kind: 'webview_init_failed' }).expect(200)
    const rows = await events(f.workspaceId)
    expect(rows[0]!.sessionId).toBeNull()
    expect(rows[0]!.payload).toMatchObject({ kind: 'webview_init_failed' })
  })

  it('accepts an unknown kind and an absent everything-else', async () => {
    const f = await fixture()
    await post(f, { kind: 'something_the_server_has_never_heard_of' }).expect(200)
    await post(f, {}).expect(200)
    const rows = await events(f.workspaceId)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.payload.kind)).toContain('unknown')
  })

  it('does not point at a session it cannot see — FK checks bypass RLS', async () => {
    const victim = await fixture('victim-game')
    await seedSession({ workspaceId: victim.workspaceId, playerId: victim.playerId, id: SESSION_ID })

    const attacker = await fixture('attacker-game')
    await post(attacker, { session_id: SESSION_ID, kind: 'token_timeout' }).expect(200)

    const rows = await events(attacker.workspaceId)
    expect(rows).toHaveLength(1)
    // The column is null; the claimed id survives in the payload for triage.
    expect(rows[0]!.sessionId).toBeNull()
    expect(rows[0]!.payload).toMatchObject({ unresolved_session_id: SESSION_ID })
  })

  it('does not point at another player session in the same workspace', async () => {
    const f = await fixture()
    const other = await seedPlayer(f.workspaceId, 'SomeoneElse')
    await seedSession({ workspaceId: f.workspaceId, playerId: other, id: SESSION_ID })
    await post(f, { session_id: SESSION_ID, kind: 'token_timeout' }).expect(200)
    const rows = await events(f.workspaceId)
    expect(rows[0]!.sessionId).toBeNull()
  })

  it('truncates an abusive detail rather than rejecting the report', async () => {
    const f = await fixture()
    await post(f, { kind: 'stack_overflow', detail: 'x'.repeat(50_000) }).expect(200)
    const rows = await events(f.workspaceId)
    expect((rows[0]!.payload.detail as string).length).toBeLessThanOrEqual(2000)
  })

  it('400s on an unparseable body — the only 4xx it has', async () => {
    const f = await fixture()
    await request(app)
      .post('/sdk/incidents')
      .set('Authorization', `Bearer ${f.token}`)
      .set('X-Support-Workspace', f.slug)
      .set('Content-Type', 'application/json')
      .send('{ not json')
      .expect(400)
  })

  it('401s without a token', async () => {
    await request(app).post('/sdk/incidents').send({ kind: 'token_timeout' }).expect(401)
  })
})
