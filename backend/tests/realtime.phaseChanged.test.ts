import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { emitPhaseChanged } from '../src/shared/realtime/emit.ts'
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

describe('conversation:phase_changed', () => {
  it('reaches both the player room and the agents room', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    const playerToken = await mintToken({ workspace_id: workspaceId, player_id: playerId, external_player_id: 'p1' })
    const agentToken = await signAgentSession({ agent_id: 'agent-1', workspace_id: workspaceId })

    const playerClient = connectClient(server.url, { token: playerToken, role: 'player' })
    const agentClient = connectClient(server.url, { token: agentToken, role: 'agent' })

    await Promise.all([waitFor(playerClient, 'connect'), waitFor(agentClient, 'connect')])

    const join = (socket: ReturnType<typeof connectClient>) =>
      new Promise<boolean>((resolve) => socket.emit('join_conversation', { conversation_id: conversationId }, resolve))

    expect(await join(playerClient)).toBe(true)
    expect(await join(agentClient)).toBe(true)

    const received: string[] = []
    playerClient.on('conversation:phase_changed', (p: { confirm_phase: string }) => received.push(`player:${p.confirm_phase}`))
    agentClient.on('conversation:phase_changed', (p: { confirm_phase: string }) => received.push(`agent:${p.confirm_phase}`))

    emitPhaseChanged(getIo(), conversationId, { conversation_id: conversationId, confirm_phase: 'agent_ask' })

    await new Promise((r) => setTimeout(r, 150))
    expect(received.sort()).toEqual(['agent:agent_ask', 'player:agent_ask'])

    playerClient.close()
    agentClient.close()
  })
})
