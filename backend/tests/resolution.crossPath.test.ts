import { createServer } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts'
import { app, mintToken } from './helpers/app.ts'
import { applyBotTurn } from '../src/domain/bot/applyBotTurn.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { HANDOFF_PLAYER_MESSAGES } from '../src/domain/bot/messages.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts'

// Mounted the same way surface.resolutionAnswer.test.ts mounts its player
// routes, but via the full app (helpers/app.ts) so /surface/messages — needed
// for the reopen tests — is available in the same file.
beforeAll(() => {
  createSocketServer(createServer())
})

afterAll(async () => {
  await closeSocketServer()
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function conversationRow(id: string) {
  const { rows } = await ownerPool.query<{
    status: string
    confirm_phase: string
    resolution_source: string | null
    assigned_agent_id: string | null
  }>(`select status, confirm_phase, resolution_source, assigned_agent_id from conversation where id = $1`, [id])
  return rows[0]
}

async function eventsFor(conversationId: string) {
  const { rows } = await ownerPool.query(
    `select type, actor_type, payload from event where conversation_id = $1 order by id`,
    [conversationId],
  )
  return rows
}

async function setConfirmPhase(conversationId: string, phase: 'none' | 'bot_article' | 'agent_ask') {
  await ownerPool.query(`update conversation set confirm_phase = $2 where id = $1`, [conversationId, phase])
}

async function fixture() {
  const workspaceId = await seedWorkspace()
  const playerId = await seedPlayer(workspaceId)
  const token = await mintToken({ workspace_id: workspaceId, player_id: playerId, external_player_id: 'p-1' })
  return { workspaceId, playerId, token }
}

describe('resolution confirmation — cross-path', () => {
  it('the same handler produces different sources from the same Yes', async () => {
    const { workspaceId, playerId: playerA, token: tokenA } = await fixture()
    const playerB = await seedPlayer(workspaceId)
    const tokenB = await mintToken({ workspace_id: workspaceId, player_id: playerB, external_player_id: 'p-2' })

    const conversationA = await seedConversation({ workspaceId, playerId: playerA })
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [conversationA])
    await setConfirmPhase(conversationA, 'bot_article')

    const conversationB = await seedConversation({ workspaceId, playerId: playerB })
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [conversationB])
    await setConfirmPhase(conversationB, 'agent_ask')

    const resA = await request(app).post('/surface/resolution-answer').set('Authorization', `Bearer ${tokenA}`).send({ helped: true })
    const resB = await request(app).post('/surface/resolution-answer').set('Authorization', `Bearer ${tokenB}`).send({ helped: true })

    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)

    const rowA = await conversationRow(conversationA)
    const rowB = await conversationRow(conversationB)
    expect(rowA?.status).toBe('resolved')
    expect(rowB?.status).toBe('resolved')

    const eventsA = await eventsFor(conversationA)
    const eventsB = await eventsFor(conversationB)
    expect(eventsA.map((e) => e.type)).toEqual(['conversation_resolved'])
    // The agent path also posts the player's answer; the bot path must not, or
    // a tap would stop matching the model's own confirm_resolution tool.
    expect(eventsB.map((e) => e.type)).toEqual(['message_sent', 'conversation_resolved'])
    expect(eventsA[0]?.payload).toEqual({ source: 'bot', confirmed_by: 'player' })
    expect(eventsB.at(-1)?.payload).toEqual({ source: 'agent', confirmed_by: 'player' })
  })

  it('a tap and the model tool converge on identical rows and events for bot_article', async () => {
    const { workspaceId, playerId: playerA, token: tokenA } = await fixture()
    const playerB = await seedPlayer(workspaceId)

    const conversationA = await seedConversation({ workspaceId, playerId: playerA })
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [conversationA])
    await setConfirmPhase(conversationA, 'bot_article')

    const conversationB = await seedConversation({ workspaceId, playerId: playerB })
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [conversationB])
    await setConfirmPhase(conversationB, 'bot_article')

    const resA = await request(app).post('/surface/resolution-answer').set('Authorization', `Bearer ${tokenA}`).send({ helped: true })
    expect(resA.status).toBe(200)

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(tx, { workspaceId, conversationId: conversationB }, { kind: 'resolve', subintentId: null }),
    )

    const rowA = await conversationRow(conversationA)
    const rowB = await conversationRow(conversationB)
    expect({ status: rowA?.status, confirm_phase: rowA?.confirm_phase, resolution_source: rowA?.resolution_source }).toEqual({
      status: rowB?.status,
      confirm_phase: rowB?.confirm_phase,
      resolution_source: rowB?.resolution_source,
    })

    const eventsA = await eventsFor(conversationA)
    const eventsB = await eventsFor(conversationB)
    expect(eventsA).toEqual(eventsB)
  })

  it('No on bot_article still produces spec 4 handoff(article_rejected) — regression', async () => {
    const { workspaceId, playerId: playerA, token: tokenA } = await fixture()
    const playerB = await seedPlayer(workspaceId)

    // A single active agent so assignOnHandoff is deterministic across both
    // conversations — the point of this test is that the two paths write the
    // same assigned_agent_id, not that load-balancing behaves.
    const agentId = await seedAgent()
    await seedWorkspaceMember({ workspaceId, agentId })

    const conversationA = await seedConversation({ workspaceId, playerId: playerA })
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [conversationA])
    await setConfirmPhase(conversationA, 'bot_article')

    const conversationB = await seedConversation({ workspaceId, playerId: playerB })
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [conversationB])
    await setConfirmPhase(conversationB, 'bot_article')

    const resA = await request(app).post('/surface/resolution-answer').set('Authorization', `Bearer ${tokenA}`).send({ helped: false })
    expect(resA.status).toBe(200)

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(tx, { workspaceId, conversationId: conversationB }, { kind: 'handoff', reason: 'article_rejected', subintentId: null }),
    )

    const rowA = await conversationRow(conversationA)
    const rowB = await conversationRow(conversationB)
    expect({ status: rowA?.status, confirm_phase: rowA?.confirm_phase, assigned_agent_id: rowA?.assigned_agent_id }).toEqual({
      status: rowB?.status,
      confirm_phase: rowB?.confirm_phase,
      assigned_agent_id: rowB?.assigned_agent_id,
    })
    expect(rowA?.assigned_agent_id).toBe(agentId)

    const { rows: messagesA } = await ownerPool.query(
      `select author_type, visibility, body from message where conversation_id = $1 order by seq`,
      [conversationA],
    )
    const { rows: messagesB } = await ownerPool.query(
      `select author_type, visibility, body from message where conversation_id = $1 order by seq`,
      [conversationB],
    )
    // Convergence is on shape and provenance, not on the literal string. The
    // handoff line is drawn at random from HANDOFF_PLAYER_MESSAGES, so the two
    // paths legitimately land on different wording — and because both draw from
    // the same pool with the same distribution, the player still cannot infer
    // which path produced their message, which is the property this asserts.
    // Pinning byte-equality here would only be asserting that the RNG returned
    // the same index twice.
    expect(messagesA.map((m) => ({ ...m, body: undefined }))).toEqual(messagesB.map((m) => ({ ...m, body: undefined })))
    expect(messagesA).toEqual([{ author_type: 'system', visibility: 'public', body: expect.toBeOneOf([...HANDOFF_PLAYER_MESSAGES]) }])
    expect(messagesB).toEqual([{ author_type: 'system', visibility: 'public', body: expect.toBeOneOf([...HANDOFF_PLAYER_MESSAGES]) }])

    const eventsA = await eventsFor(conversationA)
    const eventsB = await eventsFor(conversationB)
    expect(eventsA).toEqual(eventsB)
    expect(eventsA.map((e) => e.type)).toEqual(['message_sent', 'bot_article_rejected', 'bot_handoff'])
  })

  it('a reopen after an agent-triggered resolution keeps the previous owner', async () => {
    const { workspaceId, playerId, token } = await fixture()
    const agentId = await seedAgent()
    await seedWorkspaceMember({ workspaceId, agentId })

    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'awaiting_player', assigned_agent_id = $2 where id = $1`, [
      conversationId,
      agentId,
    ])
    await setConfirmPhase(conversationId, 'agent_ask')

    const answerRes = await request(app)
      .post('/surface/resolution-answer')
      .set('Authorization', `Bearer ${token}`)
      .send({ helped: true })
    expect(answerRes.status).toBe(200)

    const resolvedRow = await conversationRow(conversationId)
    expect(resolvedRow?.status).toBe('resolved')
    expect(resolvedRow?.resolution_source).toBe('agent')
    expect(resolvedRow?.assigned_agent_id).toBe(agentId)

    const messageRes = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'actually it broke again' })
    expect(messageRes.status).toBe(200)

    const reopenedRow = await conversationRow(conversationId)
    expect(reopenedRow?.status).toBe('open')
    expect(reopenedRow?.assigned_agent_id).toBe(agentId)
    expect(reopenedRow?.resolution_source).toBe(null)
  })

  it('a reopen keeps nobody when the previous owner was deactivated', async () => {
    const { workspaceId, playerId, token } = await fixture()
    const agentId = await seedAgent()
    await seedWorkspaceMember({ workspaceId, agentId })

    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'awaiting_player', assigned_agent_id = $2 where id = $1`, [
      conversationId,
      agentId,
    ])
    await setConfirmPhase(conversationId, 'agent_ask')

    const answerRes = await request(app)
      .post('/surface/resolution-answer')
      .set('Authorization', `Bearer ${token}`)
      .send({ helped: true })
    expect(answerRes.status).toBe(200)

    await ownerPool.query(`update agent set status = 'deactivated' where id = $1`, [agentId])

    const messageRes = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'actually it broke again' })
    expect(messageRes.status).toBe(200)

    const reopenedRow = await conversationRow(conversationId)
    expect(reopenedRow?.status).toBe('open')
    // No active agent exists (the previous owner is deactivated), so
    // assignOnHandoff's null result wins, not the old owner.
    expect(reopenedRow?.assigned_agent_id).toBe(null)
    expect(reopenedRow?.resolution_source).toBe(null)
  })
})
