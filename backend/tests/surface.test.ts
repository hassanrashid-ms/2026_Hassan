import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { eq } from 'drizzle-orm'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { event } from '../src/shared/db/schema/index.ts'
import { app, mintToken } from './helpers/app.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedMessage,
  seedPlayer,
  seedSession,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

const SESSION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const STARTED_AT = new Date('2026-08-04T09:12:00Z')

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function fixture(slug = 'demo-game') {
  const workspaceId = await seedWorkspace({ slug })
  const playerId = await seedPlayer(workspaceId, 'UserId7661')
  await seedSession({ workspaceId, playerId, id: SESSION_ID, startedAt: STARTED_AT })
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'UserId7661',
  })
  return { workspaceId, playerId, token }
}

async function insertSnapshot(args: {
  workspaceId: string
  sessionId?: string
  declared?: Record<string, unknown>
  raw?: Record<string, unknown>
  isMissing?: boolean
  degradedReason?: string | null
}) {
  await ownerPool.query(
    `insert into player_state_snapshot
       (workspace_id, session_id, declared, raw, is_missing, degraded_reason, captured_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      args.workspaceId,
      args.sessionId ?? SESSION_ID,
      JSON.stringify(args.declared ?? {}),
      JSON.stringify(args.raw ?? {}),
      args.isMissing ?? false,
      args.degradedReason ?? null,
      STARTED_AT,
    ],
  )
}

const bootstrap = (token: string, sessionId = SESSION_ID) =>
  request(app).get('/surface/bootstrap').query({ session_id: sessionId }).set('Authorization', `Bearer ${token}`)

describe('GET /surface/bootstrap', () => {
  it('returns the session, the player and the declared state', async () => {
    const f = await fixture()
    await insertSnapshot({
      workspaceId: f.workspaceId,
      declared: { platform: 'ios', player_level: 34 },
      raw: { ab_bucket: 'B' },
    })

    const res = await bootstrap(f.token)
    expect(res.status).toBe(200)
    expect(res.body.session).toMatchObject({ id: SESSION_ID, entry_point: 'settings_menu', ended_at: null })
    expect(res.body.session.started_at).toBe(STARTED_AT.toISOString())
    expect(res.body.player).toEqual({ external_player_id: 'UserId7661' })
    expect(res.body.player_state.availability).toBe('ok')
    expect(res.body.player_state.declared).toEqual({ platform: 'ios', player_level: 34 })
    expect(res.body.player_state.captured_at).toBe(STARTED_AT.toISOString())
    expect(res.body.unread_count).toBe(0)
  })

  it('distinguishes the three no-data states', async () => {
    // Each bootstrap asserts its status before reaching into the body: without
    // it, any non-200 reads as `body = {}` and fails as an unrelated TypeError
    // on the next property access, hiding the status that actually explains it.
    const absent = await fixture('absent-game')
    expect((await bootstrap(absent.token).expect(200)).body.player_state).toMatchObject({
      availability: 'absent',
      captured_at: null,
      declared: {},
    })

    await truncateAll()
    const missing = await fixture('missing-game')
    await insertSnapshot({ workspaceId: missing.workspaceId, isMissing: true })
    expect((await bootstrap(missing.token).expect(200)).body.player_state.availability).toBe('missing')

    await truncateAll()
    const degraded = await fixture('degraded-game')
    await insertSnapshot({
      workspaceId: degraded.workspaceId,
      declared: { platform: 'ios' },
      degradedReason: 'total_spend threw',
    })
    const res = await bootstrap(degraded.token).expect(200)
    expect(res.body.player_state.availability).toBe('degraded')
    expect(res.body.player_state.degraded_reason).toBe('total_spend threw')
  })

  it('reports the unread count alongside', async () => {
    const f = await fixture()
    const conversationId = await seedConversation({
      workspaceId: f.workspaceId,
      playerId: f.playerId,
      sessionId: SESSION_ID,
    })
    await seedMessage({ workspaceId: f.workspaceId, conversationId, seq: 1, authorType: 'agent' })
    expect((await bootstrap(f.token)).body.unread_count).toBe(1)
  })

  it('404s for another workspace session — invisible, so indistinguishable from absent', async () => {
    // victim-game owns SESSION_ID and has a snapshot on it.
    const victim = await fixture('victim-game')
    await insertSnapshot({ workspaceId: victim.workspaceId, declared: { platform: 'ios' } })

    const attackerWs = await seedWorkspace({ slug: 'attacker-game' })
    const attackerPlayer = await seedPlayer(attackerWs, 'UserId7661')
    const attackerToken = await mintToken({
      workspace_id: attackerWs,
      player_id: attackerPlayer,
      external_player_id: 'UserId7661',
    })

    const res = await bootstrap(attackerToken)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    // Nothing about the victim's session leaked into the response.
    expect(JSON.stringify(res.body)).not.toContain('ios')
    // And the victim can still read their own.
    expect((await bootstrap(victim.token)).status).toBe(200)
  })

  it('404s for another player session in the same workspace', async () => {
    const f = await fixture()
    const other = await seedPlayer(f.workspaceId, 'SomeoneElse')
    const otherToken = await mintToken({
      workspace_id: f.workspaceId,
      player_id: other,
      external_player_id: 'SomeoneElse',
    })
    await bootstrap(otherToken).expect(404)
  })

  it('404s for an unknown session and 422s for a malformed one', async () => {
    const f = await fixture()
    await bootstrap(f.token, '11111111-2222-3333-8444-555555555555').expect(404)
    await bootstrap(f.token, 'not-a-uuid').expect(422)
  })

  it('401s without a token and needs no workspace header', async () => {
    const f = await fixture()
    await request(app).get('/surface/bootstrap').query({ session_id: SESSION_ID }).expect(401)
    await bootstrap(f.token).expect(200)
  })
})

describe('POST /surface/events/article_read', () => {
  const read = (token: string, body: unknown) =>
    request(app).post('/surface/events/article_read').set('Authorization', `Bearer ${token}`).send(body as object)

  it('appends one article_read event against the session', async () => {
    const f = await fixture()
    await read(f.token, { session_id: SESSION_ID, article_id: 'a_123' }).expect(200)

    const events = await withWorkspace(f.workspaceId, async (tx) =>
      tx.select().from(event).where(eq(event.type, 'article_read')),
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.sessionId).toBe(SESSION_ID)
    expect(events[0]!.actorType).toBe('player')
    expect(events[0]!.actorId).toBe(f.playerId)
    expect(events[0]!.payload).toMatchObject({ article_id: 'a_123' })
  })

  it('records each read separately — articles read per session is a count', async () => {
    const f = await fixture()
    await read(f.token, { session_id: SESSION_ID, article_id: 'a_123' }).expect(200)
    await read(f.token, { session_id: SESSION_ID, article_id: 'a_456' }).expect(200)
    await read(f.token, { session_id: SESSION_ID, article_id: 'a_123' }).expect(200)

    const events = await withWorkspace(f.workspaceId, async (tx) =>
      tx.select().from(event).where(eq(event.type, 'article_read')),
    )
    expect(events).toHaveLength(3)
  })

  it('404s for a session that is not this player', async () => {
    const f = await fixture()
    const other = await seedPlayer(f.workspaceId, 'SomeoneElse')
    const otherToken = await mintToken({
      workspace_id: f.workspaceId,
      player_id: other,
      external_player_id: 'SomeoneElse',
    })
    await read(otherToken, { session_id: SESSION_ID, article_id: 'a_123' }).expect(404)
    const events = await withWorkspace(f.workspaceId, async (tx) => tx.select().from(event))
    expect(events).toHaveLength(0)
  })

  it('422s on a malformed body', async () => {
    const f = await fixture()
    await read(f.token, { session_id: SESSION_ID }).expect(422)
    await read(f.token, { session_id: 'nope', article_id: 'a_1' }).expect(422)
  })
})
