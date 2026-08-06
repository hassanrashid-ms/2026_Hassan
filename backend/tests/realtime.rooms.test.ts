import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { agentRoom, playerRoom } from '../src/shared/realtime/rooms.ts'
import { getIo } from '../src/shared/realtime/socketServer.ts'
import { mintToken } from './helpers/app.ts'
import { closeOwnerPool, seedConversation, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'
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

describe('socket rooms stay separated by audience', () => {
  it('an agent socket in conv:{id}:agents never receives an emit intended for conv:{id}:player, and vice versa', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    const playerToken = await mintToken({ workspace_id: workspaceId, player_id: playerId, external_player_id: 'p1' })
    const agentToken = await signAgentSession({ agent_id: 'agent-1', workspace_id: workspaceId })

    const playerSocket = connectClient(server.url, { token: playerToken, role: 'player' })
    const agentSocket = connectClient(server.url, { token: agentToken, role: 'agent' })

    await Promise.all([waitFor(playerSocket, 'connect'), waitFor(agentSocket, 'connect')])

    const join = (socket: ReturnType<typeof connectClient>) =>
      new Promise<boolean>((resolve) => socket.emit('join_conversation', { conversation_id: conversationId }, resolve))

    expect(await join(playerSocket)).toBe(true)
    expect(await join(agentSocket)).toBe(true)

    const playerReceived: unknown[] = []
    const agentReceived: unknown[] = []
    playerSocket.on('message:new', (payload: unknown) => playerReceived.push(payload))
    agentSocket.on('message:new', (payload: unknown) => agentReceived.push(payload))

    getIo().to(playerRoom(conversationId)).emit('message:new', { scope: 'player-only' })
    getIo().to(agentRoom(conversationId)).emit('message:new', { scope: 'agent-only' })

    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(playerReceived).toEqual([{ scope: 'player-only' }])
    expect(agentReceived).toEqual([{ scope: 'agent-only' }])

    playerSocket.close()
    agentSocket.close()
  })

  it('a player cannot join a conversation that is not theirs', async () => {
    const workspaceId = await seedWorkspace()
    const ownerId = await seedPlayer(workspaceId, 'owner')
    const otherId = await seedPlayer(workspaceId, 'other')
    const conversationId = await seedConversation({ workspaceId, playerId: ownerId })

    const otherToken = await mintToken({ workspace_id: workspaceId, player_id: otherId, external_player_id: 'other' })
    const socket = connectClient(server.url, { token: otherToken, role: 'player' })
    await waitFor(socket, 'connect')

    const allowed = await new Promise<boolean>((resolve) =>
      socket.emit('join_conversation', { conversation_id: conversationId }, resolve),
    )
    expect(allowed).toBe(false)
    socket.close()
  })
})
