import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { eq } from 'drizzle-orm'
import { DECLARED_FIELD_KEYS } from '@support/types'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { event, playerStateSnapshot, session } from '../src/shared/db/schema/index.ts'
import { app, mintToken } from './helpers/app.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedDeclaredFields,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

const SESSION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

const SNAPSHOT = {
  player_id: 'UserId7661',
  client_version: '6.2.01',
  platform: 'ios',
  os_version: '26.5.2',
  device_model: 'iPhone 13 Pro Max',
  locale: 'en-GB',
  player_level: 34,
  total_spend: 0.0,
  spend_tier: 'non-payer',
  account_created_at: '2026-07-27T09:12:00Z',
  last_session_at: '2026-08-03T08:40:00Z',
  extra: { ab_bucket: 'B', collection_status: 'event_in_progress' },
  degraded_reason: null,
}

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function fixture(slug = 'demo-game') {
  const workspaceId = await seedWorkspace({ slug })
  const playerId = await seedPlayer(workspaceId, 'UserId7661')
  await seedDeclaredFields(workspaceId, DECLARED_FIELD_KEYS)
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'UserId7661',
  })
  return { workspaceId, playerId, token, slug }
}

const post = (f: { token: string; slug: string }, body: unknown, headers: Record<string, string> = {}) => {
  const req = request(app)
    .post('/sdk/sessions/start')
    .set('Authorization', `Bearer ${f.token}`)
    .set('X-Support-Workspace', f.slug)
    .set('X-Support-Sdk', '1.0.2')
    .set('X-Support-Client-Version', '6.2.01')
    .set('Idempotency-Key', 'idem-1')
  for (const [k, v] of Object.entries(headers)) req.set(k, v)
  return req.send(body as object)
}

const body = (overrides: Record<string, unknown> = {}) => ({
  session_id: SESSION_ID,
  entry_point: 'settings_menu',
  started_at: '2026-08-04T09:12:00Z',
  snapshot: SNAPSHOT,
  ...overrides,
})

const rows = <T>(workspaceId: string, fn: (tx: Parameters<Parameters<typeof withWorkspace>[1]>[0]) => Promise<T>) =>
  withWorkspace(workspaceId, fn)

describe('POST /sdk/sessions/start', () => {
  it('writes the session, the split snapshot and one session_start event', async () => {
    const f = await fixture()
    const res = await post(f, body())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const sessions = await rows(f.workspaceId, async (tx) => tx.select().from(session))
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.id).toBe(SESSION_ID)
    expect(sessions[0]!.playerId).toBe(f.playerId)
    expect(sessions[0]!.entryPoint).toBe('settings_menu')
    expect(sessions[0]!.startedAt.toISOString()).toBe('2026-08-04T09:12:00.000Z')
    expect(sessions[0]!.endedAt).toBeNull()

    const snapshots = await rows(f.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))
    expect(snapshots).toHaveLength(1)
    expect(Object.keys(snapshots[0]!.declared).sort()).toEqual([...DECLARED_FIELD_KEYS].sort())
    expect(snapshots[0]!.raw).toEqual({ ab_bucket: 'B', collection_status: 'event_in_progress' })
    expect(snapshots[0]!.isMissing).toBe(false)
    expect(snapshots[0]!.degradedReason).toBeNull()
    // captured_at is the client's started_at, not now().
    expect(snapshots[0]!.capturedAt.toISOString()).toBe('2026-08-04T09:12:00.000Z')

    const events = await rows(f.workspaceId, async (tx) => tx.select().from(event))
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('session_start')
    expect(events[0]!.sessionId).toBe(SESSION_ID)
    expect(events[0]!.actorType).toBe('player')
    expect(events[0]!.actorId).toBe(f.playerId)
    expect(events[0]!.payload).toMatchObject({
      entry_point: 'settings_menu',
      idempotency_key: 'idem-1',
      sdk_version: '1.0.2',
    })
  })

  it('never logs the token in the event payload', async () => {
    const f = await fixture()
    await post(f, body()).expect(200)
    const events = await rows(f.workspaceId, async (tx) => tx.select().from(event))
    expect(JSON.stringify(events[0]!.payload)).not.toContain(f.token)
  })

  it('is idempotent: a duplicate delivery appends no second event', async () => {
    const f = await fixture()
    await post(f, body()).expect(200)
    await post(f, body()).expect(200)
    await post(f, body(), { 'Idempotency-Key': 'idem-2' }).expect(200)

    expect(await rows(f.workspaceId, async (tx) => tx.select().from(session))).toHaveLength(1)
    expect(await rows(f.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))).toHaveLength(1)
    const events = await rows(f.workspaceId, async (tx) => tx.select().from(event))
    expect(events.filter((e) => e.type === 'session_start')).toHaveLength(1)
  })

  it('does not re-split a snapshot on redelivery — promotion stays non-retroactive', async () => {
    const f = await fixture()
    await post(f, body()).expect(200)
    await seedDeclaredFields(f.workspaceId, ['ab_bucket'])
    await post(f, body()).expect(200)

    const snapshots = await rows(f.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.raw.ab_bucket).toBe('B')
    expect(snapshots[0]!.declared.ab_bucket).toBeUndefined()
  })

  it('splits against the declared set current at write time', async () => {
    const workspaceId = await seedWorkspace({ slug: 'sparse' })
    const playerId = await seedPlayer(workspaceId, 'UserId7661')
    await seedDeclaredFields(workspaceId, ['platform', 'client_version'])
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'UserId7661',
    })
    await post({ token, slug: 'sparse' }, body()).expect(200)

    const snapshots = await rows(workspaceId, async (tx) => tx.select().from(playerStateSnapshot))
    expect(Object.keys(snapshots[0]!.declared).sort()).toEqual(['client_version', 'platform'])
    expect(snapshots[0]!.raw.player_level).toBe(34)
  })

  // A malformed, empty or absent snapshot is a STATE, never a 4xx: rejecting it
  // would mean the conversations where something is broken are the ones that fail
  // to attach context.
  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty object', {}],
    ['a bare string', 'garbage'],
    ['a number', 42],
  ])('records a %s snapshot as is_missing and still returns 200', async (_label, snapshot) => {
    const f = await fixture()
    await post(f, body({ snapshot })).expect(200)

    const snapshots = await rows(f.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.isMissing).toBe(true)
    expect(snapshots[0]!.declared).toEqual({})
    expect(snapshots[0]!.raw).toEqual({})
    // The session still exists — a broken snapshot never costs us the visit.
    expect(await rows(f.workspaceId, async (tx) => tx.select().from(session))).toHaveLength(1)
  })

  it('records degraded_reason when the provider partially threw', async () => {
    const f = await fixture()
    await post(
      f,
      body({
        snapshot: {
          platform: 'ios',
          client_version: '6.2.01',
          player_level: 34,
          degraded_reason: 'total_spend threw',
        },
      }),
    ).expect(200)
    const snapshots = await rows(f.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))
    expect(snapshots[0]!.degradedReason).toBe('total_spend threw')
    expect(snapshots[0]!.isMissing).toBe(false)
  })

  it('accepts an unknown entry_point and unknown request fields', async () => {
    const f = await fixture()
    await post(f, body({ entry_point: 'brand_new_screen', invented_later: { nested: true } })).expect(200)
    const sessions = await rows(f.workspaceId, async (tx) => tx.select().from(session))
    expect(sessions[0]!.entryPoint).toBe('brand_new_screen')
  })

  it('falls back to now() for an absurd started_at rather than storing it', async () => {
    const f = await fixture()
    await post(f, body({ started_at: '2099-01-01T00:00:00Z' })).expect(200)
    const sessions = await rows(f.workspaceId, async (tx) => tx.select().from(session))
    expect(sessions[0]!.startedAt.getFullYear()).toBeLessThan(2030)
  })

  it('422s only when session_id is unusable', async () => {
    const f = await fixture()
    await post(f, body({ session_id: 'not-a-uuid' })).expect(422)
    await post(f, { entry_point: 'settings_menu' }).expect(422)
  })

  it('413s on a body over the limit', async () => {
    const f = await fixture()
    const huge = { ...body(), snapshot: { ...SNAPSHOT, extra: { blob: 'x'.repeat(70_000) } } }
    await post(f, huge).expect(413)
  })

  it('401s without a token and 403s on a workspace header mismatch', async () => {
    const f = await fixture()
    await seedWorkspace({ slug: 'other-game' })
    await request(app).post('/sdk/sessions/start').send(body()).expect(401)
    await post({ token: f.token, slug: 'other-game' }, body()).expect(403)
  })

  it('refuses a session_id belonging to another workspace, writing nothing there', async () => {
    const victim = await fixture('victim-game')
    await post(victim, body()).expect(200)

    const attacker = await fixture('attacker-game')
    const res = await post(attacker, body())
    expect(res.status).toBe(200) // still 200: the SDK must never be told anything useful

    // The victim's session and snapshot are untouched.
    const victimSessions = await rows(victim.workspaceId, async (tx) => tx.select().from(session))
    expect(victimSessions[0]!.playerId).toBe(victim.playerId)
    const victimSnapshots = await rows(victim.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))
    expect(victimSnapshots).toHaveLength(1)

    // Nothing was written into the attacker's workspace but an incident.
    const attackerSessions = await rows(attacker.workspaceId, async (tx) => tx.select().from(session))
    expect(attackerSessions).toHaveLength(0)
    const attackerSnapshots = await rows(attacker.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))
    expect(attackerSnapshots).toHaveLength(0)
    const attackerEvents = await rows(attacker.workspaceId, async (tx) => tx.select().from(event))
    expect(attackerEvents).toHaveLength(1)
    expect(attackerEvents[0]!.type).toBe('sdk_incident')
    expect(attackerEvents[0]!.payload).toMatchObject({ kind: 'session_id_not_ours' })

    // And the whole row count is still one session, globally.
    const { rows: all } = await ownerPool.query('select count(*)::int as n from session')
    expect(all[0]!.n).toBe(1)
  })

  it('refuses a session_id belonging to another player in the same workspace', async () => {
    const f = await fixture()
    const other = await seedPlayer(f.workspaceId, 'SomeoneElse')
    await ownerPool.query(
      `insert into session (id, workspace_id, player_id, entry_point, started_at)
       values ($1, $2, $3, 'settings_menu', now())`,
      [SESSION_ID, f.workspaceId, other],
    )

    await post(f, body()).expect(200)
    const sessions = await rows(f.workspaceId, async (tx) =>
      tx.select().from(session).where(eq(session.id, SESSION_ID)),
    )
    expect(sessions[0]!.playerId).toBe(other)
    expect(await rows(f.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))).toHaveLength(0)
  })

  // Locks the whole chain — splitSnapshot -> drizzle .values() -> Postgres jsonb ->
  // read back out of the driver — which is where the null-prototype/drizzle bug
  // actually lived. JSON.parse is required, not an object literal: JSON.parse
  // creates __proto__ as an ordinary own data property, whereas a JS object literal
  // `{ __proto__: 'x' }` is special-cased by the parser to merely set the
  // prototype, silently discarding the string, and would prove nothing here.
  it('round-trips a wire __proto__ key through drizzle and jsonb without dropping it', async () => {
    const f = await fixture()
    const snapshot = JSON.parse('{"platform":"ios","__proto__":"malicious-payload"}')
    await post(f, body({ snapshot })).expect(200)

    const { rows: dbRows } = await ownerPool.query(
      'select declared, raw from player_state_snapshot where session_id = $1',
      [SESSION_ID],
    )
    const row = dbRows[0]!

    // A bare `.hasOwnProperty()` on a value read back from the pg driver is exactly
    // the kind of thing that could throw if the driver ever handed back something
    // prototype-less, so go through Object.prototype explicitly.
    expect(Object.prototype.hasOwnProperty.call(row.raw, '__proto__')).toBe(true)
    expect(row.raw.__proto__).toBe('malicious-payload')
    expect(row.declared.platform).toBe('ios')
  })
})
