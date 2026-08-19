import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { app, mintToken } from './helpers/app.ts'
import { closeOwnerPool, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function setup(slug = 'demo-game') {
  const workspaceId = await seedWorkspace({ slug })
  const playerId = await seedPlayer(workspaceId, 'UserId7661')
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'UserId7661',
  })
  return { workspaceId, playerId, token, slug }
}

// /sdk/_whoami is test-only introspection (mounted only under NODE_ENV=test) — it
// is the only route that echoes back the full PlayerContext, which the two tests
// below need to assert on. Every other test here only checks a status code, so it
// exercises the real route, GET /sdk/unread, instead.
const whoami = (token: string | null, headers: Record<string, string> = {}) => {
  const req = request(app).get('/sdk/_whoami')
  if (token) req.set('Authorization', `Bearer ${token}`)
  for (const [key, value] of Object.entries(headers)) req.set(key, value)
  return req
}

const call = (token: string | null, headers: Record<string, string> = {}) => {
  const req = request(app).get('/sdk/unread')
  if (token) req.set('Authorization', `Bearer ${token}`)
  for (const [key, value] of Object.entries(headers)) req.set(key, value)
  return req
}

describe('requirePlayerToken', () => {
  it('resolves the player from the token and the slug from the database', async () => {
    const { workspaceId, playerId, token } = await setup()
    const res = await whoami(token, {
      'X-Support-Workspace': 'demo-game',
      'X-Support-Sdk': '1.0.2',
      'X-Support-Client-Version': '6.2.01',
      'Idempotency-Key': 'idem-1',
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      workspaceId,
      playerId,
      externalPlayerId: 'UserId7661',
      workspaceSlug: 'demo-game',
      sdkVersion: '1.0.2',
      clientVersion: '6.2.01',
      idempotencyKey: 'idem-1',
    })
  })

  it('401s with no token, a malformed header, a bad signature or an expired token', async () => {
    const { token } = await setup()
    await call(null, { 'X-Support-Workspace': 'demo-game' }).expect(401)
    await request(app).get('/sdk/unread').set('Authorization', token).expect(401)
    await call(`${token}tampered`, { 'X-Support-Workspace': 'demo-game' }).expect(401)

    const expired = await mintToken(
      { workspace_id: 'x', player_id: 'y', external_player_id: 'z' },
      -10,
    )
    await call(expired, { 'X-Support-Workspace': 'demo-game' }).expect(401)
  })

  it('401s when the token names a workspace that no longer exists', async () => {
    const token = await mintToken({
      workspace_id: '00000000-0000-0000-0000-000000000000',
      player_id: '00000000-0000-0000-0000-000000000001',
      external_player_id: 'ghost',
    })
    await call(token, { 'X-Support-Workspace': 'demo-game' }).expect(401)
  })

  it('401s when the token names a disabled workspace', async () => {
    const workspaceId = await seedWorkspace({ slug: 'retired', disabledAt: new Date() })
    const playerId = await seedPlayer(workspaceId, 'UserId7661')
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'UserId7661',
    })
    await call(token, { 'X-Support-Workspace': 'retired' }).expect(401)
  })
})

describe('requireSdkHeaders', () => {
  it('403s when X-Support-Workspace disagrees with the token claim', async () => {
    const { token } = await setup()
    await seedWorkspace({ slug: 'other-game' })
    const res = await call(token, { 'X-Support-Workspace': 'other-game' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('workspace_mismatch')
  })

  it('403s when X-Support-Workspace is absent — a misconfigured build must fail loudly', async () => {
    const { token } = await setup()
    await call(token).expect(403)
  })

  it('compares the slug case-insensitively and ignores surrounding whitespace', async () => {
    const { token } = await setup()
    await call(token, { 'X-Support-Workspace': ' Demo-Game ' }).expect(200)
  })

  it('treats the three informational headers as optional', async () => {
    const { token } = await setup()
    const res = await whoami(token, { 'X-Support-Workspace': 'demo-game' })
    expect(res.status).toBe(200)
    expect(res.body.sdkVersion).toBeNull()
    expect(res.body.clientVersion).toBeNull()
    expect(res.body.idempotencyKey).toBeNull()
  })
})
