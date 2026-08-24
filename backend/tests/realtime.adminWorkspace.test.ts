import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { inboxRoom } from '../src/shared/realtime/rooms.ts'
import { getIo } from '../src/shared/realtime/socketServer.ts'
import { closeOwnerPool, seedWorkspace, truncateAll } from './helpers/db.ts'
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

function waitFor(socket: ReturnType<typeof connectClient>, event: string): Promise<unknown> {
  return new Promise((resolve) => socket.once(event, resolve))
}

/**
 * Mirrors resolveConsoleWorkspace's REST behavior (see
 * 2026-08-21-superadmin-workspace-console-access-design.md) for the socket
 * handshake: an admin token carries no workspace_id, so the connection must
 * supply one, and it's checked against a real workspace before being trusted.
 */
describe('admin socket auth', () => {
  it('joins the inbox room for a workspace supplied via handshake auth', async () => {
    const workspaceId = await seedWorkspace()
    const token = await signAgentSession({ agent_id: randomUUID(), is_admin: true })

    const socket = connectClient(server.url, { token, role: 'agent', workspaceId })
    await waitFor(socket, 'connect')

    // No direct way to read a socket's own room membership from the client,
    // so prove it the same way realtime.rooms.test.ts does: emit into the
    // room and confirm this socket receives it.
    const received = waitFor(socket, 'ping_probe')
    getIo().to(inboxRoom(workspaceId)).emit('ping_probe', { ok: true })
    expect(await received).toEqual({ ok: true })

    socket.close()
  })

  it('rejects an admin connection with no workspaceId in handshake auth', async () => {
    const token = await signAgentSession({ agent_id: randomUUID(), is_admin: true })
    const socket = connectClient(server.url, { token, role: 'agent' })
    const err = (await waitFor(socket, 'connect_error')) as Error
    expect(err.message).toBe('unauthorized')
    socket.close()
  })

  it('rejects an admin connection whose workspaceId does not name a real workspace', async () => {
    const token = await signAgentSession({ agent_id: randomUUID(), is_admin: true })
    const socket = connectClient(server.url, { token, role: 'agent', workspaceId: randomUUID() })
    const err = (await waitFor(socket, 'connect_error')) as Error
    expect(err.message).toBe('unauthorized')
    socket.close()
  })

  it('ignores handshake workspaceId for a regular agent — their own claim wins', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const token = await signAgentSession({ agent_id: randomUUID(), workspace_id: workspaceA })

    const socket = connectClient(server.url, { token, role: 'agent', workspaceId: workspaceB })
    await waitFor(socket, 'connect')

    const received = waitFor(socket, 'ping_probe')
    getIo().to(inboxRoom(workspaceA)).emit('ping_probe', { from: 'A' })
    expect(await received).toEqual({ from: 'A' })

    socket.close()
  })
})
