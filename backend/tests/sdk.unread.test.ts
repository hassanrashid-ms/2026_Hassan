import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { app, mintToken } from './helpers/app.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedMessage,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

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

const get = (f: { token: string; slug: string }) =>
  request(app).get('/sdk/unread').set('Authorization', `Bearer ${f.token}`).set('X-Support-Workspace', f.slug)

describe('GET /sdk/unread', () => {
  it('returns zero when the player has no conversations', async () => {
    const f = await fixture()
    const res = await get(f)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ unread_count: 0 })
  })

  it('counts public non-player messages that are not yet read', async () => {
    const f = await fixture()
    const conversationId = await seedConversation({ workspaceId: f.workspaceId, playerId: f.playerId })
    await seedMessage({ workspaceId: f.workspaceId, conversationId, seq: 1, authorType: 'agent', deliveryState: 'sent' })
    await seedMessage({ workspaceId: f.workspaceId, conversationId, seq: 2, authorType: 'bot', deliveryState: 'delivered' })

    const res = await get(f)
    expect(res.body).toEqual({ unread_count: 2 })
  })

  it('excludes the player own messages, read messages and internal notes', async () => {
    const f = await fixture()
    const conversationId = await seedConversation({ workspaceId: f.workspaceId, playerId: f.playerId })
    await seedMessage({ workspaceId: f.workspaceId, conversationId, seq: 1, authorType: 'player', deliveryState: 'sent' })
    await seedMessage({ workspaceId: f.workspaceId, conversationId, seq: 2, authorType: 'agent', deliveryState: 'read' })
    await seedMessage({
      workspaceId: f.workspaceId,
      conversationId,
      seq: 3,
      authorType: 'agent',
      visibility: 'internal',
      deliveryState: 'sent',
    })
    await seedMessage({ workspaceId: f.workspaceId, conversationId, seq: 4, authorType: 'system', deliveryState: 'sent' })

    const res = await get(f)
    // Only the system message counts: player-authored, read and internal are all out.
    expect(res.body).toEqual({ unread_count: 1 })
  })

  it('never counts another player messages, even in the same workspace', async () => {
    const f = await fixture()
    const other = await seedPlayer(f.workspaceId, 'SomeoneElse')
    const theirs = await seedConversation({ workspaceId: f.workspaceId, playerId: other })
    await seedMessage({ workspaceId: f.workspaceId, conversationId: theirs, seq: 1, authorType: 'agent' })

    const res = await get(f)
    expect(res.body).toEqual({ unread_count: 0 })
  })

  it('never counts another workspace messages', async () => {
    const a = await fixture('game-a')
    const b = await fixture('game-b')
    const theirs = await seedConversation({ workspaceId: b.workspaceId, playerId: b.playerId })
    await seedMessage({ workspaceId: b.workspaceId, conversationId: theirs, seq: 1, authorType: 'agent' })

    expect((await get(a)).body).toEqual({ unread_count: 0 })
    expect((await get(b)).body).toEqual({ unread_count: 1 })
  })

  it('counts only the current conversation, not closed history', async () => {
    const f = await fixture()
    // A ticket the player deliberately ended, still holding unread agent
    // messages, plus the fresh one they opened after it. Counting both would
    // badge the player forever for a thread they closed.
    const closed = await seedConversation({ workspaceId: f.workspaceId, playerId: f.playerId })
    await seedMessage({ workspaceId: f.workspaceId, conversationId: closed, seq: 1, authorType: 'agent' })
    await seedMessage({ workspaceId: f.workspaceId, conversationId: closed, seq: 2, authorType: 'agent' })
    await ownerPool.query(`update conversation set status = 'closed' where id = $1`, [closed])

    const current = await seedConversation({ workspaceId: f.workspaceId, playerId: f.playerId })
    await seedMessage({ workspaceId: f.workspaceId, conversationId: current, seq: 1, authorType: 'agent' })

    expect((await get(f)).body).toEqual({ unread_count: 1 })
  })

  it('401s without a token and 403s on a workspace mismatch', async () => {
    const f = await fixture()
    await seedWorkspace({ slug: 'other-game' })
    await request(app).get('/sdk/unread').expect(401)
    await request(app)
      .get('/sdk/unread')
      .set('Authorization', `Bearer ${f.token}`)
      .set('X-Support-Workspace', 'other-game')
      .expect(403)
  })
})
