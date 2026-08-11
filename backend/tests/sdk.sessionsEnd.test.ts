import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { eq } from 'drizzle-orm'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { event, session } from '../src/shared/db/schema/index.ts'
import { app, mintToken } from './helpers/app.ts'
import { closeOwnerPool, seedPlayer, seedSession, seedWorkspace, truncateAll } from './helpers/db.ts'

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
  return { workspaceId, playerId, token, slug }
}

const post = (f: { token: string; slug: string }, body: unknown) =>
  request(app)
    .post('/sdk/sessions/end')
    .set('Authorization', `Bearer ${f.token}`)
    .set('X-Support-Workspace', f.slug)
    .send(body as object)

const body = (overrides: Record<string, unknown> = {}) => ({
  session_id: SESSION_ID,
  duration_ms: 184200,
  conversation_created: false,
  articles_read: ['a_123', 'a_456'],
  ...overrides,
})

describe('POST /sdk/sessions/end', () => {
  it('sets ended_at, marks it client-ended and appends one session_end event', async () => {
    const f = await fixture()
    const res = await post(f, body())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const sessions = await withWorkspace(f.workspaceId, async (tx) => tx.select().from(session))
    expect(sessions[0]!.endedAt).not.toBeNull()
    expect(sessions[0]!.endedBy).toBe('client')
    // started_at is never rewritten: the denominator counts by started_at.
    expect(sessions[0]!.startedAt.toISOString()).toBe(STARTED_AT.toISOString())

    const events = await withWorkspace(f.workspaceId, async (tx) =>
      tx.select().from(event).where(eq(event.type, 'session_end')),
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.sessionId).toBe(SESSION_ID)
    expect(events[0]!.actorType).toBe('player')
    expect(events[0]!.payload).toMatchObject({
      ended_by: 'client',
      duration_ms_reported: 184200,
      conversation_created_reported: false,
      articles_read_reported: ['a_123', 'a_456'],
    })
    expect(typeof events[0]!.payload.duration_ms_derived).toBe('number')
  })

  it('derives the duration from the timestamps rather than trusting the client', async () => {
    const f = await fixture()
    await post(f, body({ duration_ms: 1 })).expect(200)
    const events = await withWorkspace(f.workspaceId, async (tx) =>
      tx.select().from(event).where(eq(event.type, 'session_end')),
    )
    const derived = events[0]!.payload.duration_ms_derived as number
    expect(derived).toBeGreaterThan(1)
    expect(events[0]!.payload.duration_ms_reported).toBe(1)
  })

  it('is idempotent: a redelivered end does not move ended_at or append a second event', async () => {
    const f = await fixture()
    await post(f, body()).expect(200)
    const first = await withWorkspace(f.workspaceId, async (tx) => tx.select().from(session))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await post(f, body()).expect(200)

    const second = await withWorkspace(f.workspaceId, async (tx) => tx.select().from(session))
    expect(second[0]!.endedAt!.getTime()).toBe(first[0]!.endedAt!.getTime())
    const events = await withWorkspace(f.workspaceId, async (tx) =>
      tx.select().from(event).where(eq(event.type, 'session_end')),
    )
    expect(events).toHaveLength(1)
  })

  it('200s and writes nothing for a session that does not exist', async () => {
    const f = await fixture()
    await post(f, body({ session_id: '11111111-2222-3333-8444-555555555555' })).expect(200)
    const events = await withWorkspace(f.workspaceId, async (tx) => tx.select().from(event))
    expect(events).toHaveLength(0)
  })

  it('200s and writes nothing for another workspace session', async () => {
    const victim = await fixture('victim-game')
    const attacker = await seedWorkspace({ slug: 'attacker-game' })
    const attackerPlayer = await seedPlayer(attacker, 'UserId7661')
    const token = await mintToken({
      workspace_id: attacker,
      player_id: attackerPlayer,
      external_player_id: 'UserId7661',
    })

    await post({ token, slug: 'attacker-game' }, body()).expect(200)

    const victimSessions = await withWorkspace(victim.workspaceId, async (tx) => tx.select().from(session))
    expect(victimSessions[0]!.endedAt).toBeNull()
    expect(victimSessions[0]!.endedBy).toBeNull()
  })

  it('accepts an end with every untrusted field absent or wrong-typed', async () => {
    const f = await fixture()
    await post(f, { session_id: SESSION_ID }).expect(200)
    const events = await withWorkspace(f.workspaceId, async (tx) =>
      tx.select().from(event).where(eq(event.type, 'session_end')),
    )
    expect(events[0]!.payload).toMatchObject({
      duration_ms_reported: null,
      conversation_created_reported: null,
      articles_read_reported: [],
    })
  })

  it('422s only when session_id is unusable', async () => {
    const f = await fixture()
    await post(f, body({ session_id: 'nope' })).expect(422)
    await post(f, {}).expect(422)
  })
})
