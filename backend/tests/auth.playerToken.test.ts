import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { player } from '../src/shared/db/schema/index.ts'
import { generateWorkspaceSecret } from '../src/shared/auth/workspaceSecret.ts'
import { verifyPlayerToken } from '../src/shared/auth/playerToken.ts'
import { closeOwnerPool, seedWorkspace, truncateAll } from './helpers/db.ts'

const app = createApp()

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function workspaceWithSecret(slug = 'demo-game', disabledAt: Date | null = null) {
  const { secret, secretHash } = generateWorkspaceSecret(slug)
  const id = await seedWorkspace({ slug, secretHash, disabledAt })
  return { id, secret }
}

describe('POST /auth/player-token', () => {
  it('mints a 15-minute token and upserts the player', async () => {
    const ws = await workspaceWithSecret()

    const res = await request(app)
      .post('/auth/player-token')
      .set('Authorization', `Bearer ${ws.secret}`)
      .send({ external_player_id: 'UserId7661' })

    expect(res.status).toBe(200)
    expect(res.body.expires_in).toBe(900)

    const claims = await verifyPlayerToken(res.body.token)
    expect(claims.workspace_id).toBe(ws.id)
    expect(claims.external_player_id).toBe('UserId7661')

    const players = await withWorkspace(ws.id, async (tx) =>
      tx.select().from(player).where(eq(player.externalId, 'UserId7661')),
    )
    expect(players).toHaveLength(1)
    expect(players[0]?.id).toBe(claims.player_id)
  })

  it('is idempotent on repeat calls and bumps last_seen_at', async () => {
    const ws = await workspaceWithSecret()
    const call = () =>
      request(app)
        .post('/auth/player-token')
        .set('Authorization', `Bearer ${ws.secret}`)
        .send({ external_player_id: 'UserId7661' })

    const first = await call()
    const before = (await withWorkspace(ws.id, async (tx) => tx.select().from(player)))[0]!
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await call()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const after = await withWorkspace(ws.id, async (tx) => tx.select().from(player))
    expect(after).toHaveLength(1)
    expect(after[0]!.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime())
    expect(after[0]!.firstSeenAt.getTime()).toBe(before.firstSeenAt.getTime())
  })

  it('keeps two workspaces players apart even for the same external id', async () => {
    const a = await workspaceWithSecret('game-a')
    const b = await workspaceWithSecret('game-b')
    for (const ws of [a, b]) {
      await request(app)
        .post('/auth/player-token')
        .set('Authorization', `Bearer ${ws.secret}`)
        .send({ external_player_id: 'SharedId' })
        .expect(200)
    }
    const inA = await withWorkspace(a.id, async (tx) => tx.select().from(player))
    const inB = await withWorkspace(b.id, async (tx) => tx.select().from(player))
    expect(inA).toHaveLength(1)
    expect(inB).toHaveLength(1)
    expect(inA[0]!.id).not.toBe(inB[0]!.id)
  })

  it('401s on a missing, malformed or wrong secret', async () => {
    const ws = await workspaceWithSecret()
    const body = { external_player_id: 'UserId7661' }

    await request(app).post('/auth/player-token').send(body).expect(401)
    await request(app).post('/auth/player-token').set('Authorization', 'Bearer nonsense').send(body).expect(401)
    await request(app).post('/auth/player-token').set('Authorization', ws.secret).send(body).expect(401)
    await request(app)
      .post('/auth/player-token')
      .set('Authorization', `Bearer sk_demo-game.${'w'.repeat(43)}`)
      .send(body)
      .expect(401)
  })

  it('404s for an unknown workspace and for a disabled one', async () => {
    const unknown = generateWorkspaceSecret('never-existed')
    await request(app)
      .post('/auth/player-token')
      .set('Authorization', `Bearer ${unknown.secret}`)
      .send({ external_player_id: 'UserId7661' })
      .expect(404)

    const disabled = await workspaceWithSecret('retired-game', new Date())
    await request(app)
      .post('/auth/player-token')
      .set('Authorization', `Bearer ${disabled.secret}`)
      .send({ external_player_id: 'UserId7661' })
      .expect(404)
  })

  it('422s on a malformed external_player_id', async () => {
    const ws = await workspaceWithSecret()
    for (const bad of [{}, { external_player_id: '' }, { external_player_id: 'has space' }, { external_player_id: 'a'.repeat(200) }]) {
      await request(app).post('/auth/player-token').set('Authorization', `Bearer ${ws.secret}`).send(bad).expect(422)
    }
  })

  it('400s on an unparseable body', async () => {
    const ws = await workspaceWithSecret()
    await request(app)
      .post('/auth/player-token')
      .set('Authorization', `Bearer ${ws.secret}`)
      .set('Content-Type', 'application/json')
      .send('{ not json')
      .expect(400)
  })

  it('never echoes the secret back', async () => {
    const ws = await workspaceWithSecret()
    const res = await request(app)
      .post('/auth/player-token')
      .set('Authorization', 'Bearer sk_demo-game.wrong')
      .send({ external_player_id: 'UserId7661' })
    expect(JSON.stringify(res.body)).not.toContain('wrong')
  })
})
