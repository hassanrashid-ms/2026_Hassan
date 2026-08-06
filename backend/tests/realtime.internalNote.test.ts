import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/shared/db/client.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { mintToken } from './helpers/app.ts'
import { closeOwnerPool, ownerPool, seedConversation, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'
import { connectClient, startRealtimeServer } from './helpers/realtime.ts'

let server: Awaited<ReturnType<typeof startRealtimeServer>>

beforeEach(async () => {
  await truncateAll()
  server = await startRealtimeServer()
})

afterEach(async () => {
  await server.close()
})

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

function waitFor(socket: ReturnType<typeof connectClient>, event: string): Promise<void> {
  return new Promise((resolve) => socket.on(event, () => resolve()))
}

describe('internal notes never reach the player room', () => {
  it('posting an internal note through sendAgentMessage end-to-end never emits to conv:{id}:player', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agent-note@example.test', 'Agent Note') returning id`,
    )
    const agentId = rows[0]!.id
    await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
      workspaceId,
      agentId,
    ])
    await ownerPool.query(`update conversation set assigned_agent_id = $2 where id = $1`, [conversationId, agentId])
    const agentToken = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })

    const playerToken = await mintToken({ workspace_id: workspaceId, player_id: playerId, external_player_id: 'p1' })
    const playerSocket = connectClient(server.url, { token: playerToken, role: 'player' })
    await waitFor(playerSocket, 'connect')
    await new Promise<boolean>((resolve) =>
      playerSocket.emit('join_conversation', { conversation_id: conversationId }, resolve),
    )

    const playerReceived: unknown[] = []
    playerSocket.on('message:new', (payload: unknown) => playerReceived.push(payload))

    await request(server.url)
      .post('/agent/messages')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ conversation_id: conversationId, body: 'internal only', visibility: 'internal' })
      .expect(200)

    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(playerReceived).toEqual([])
    playerSocket.close()
  })
})
