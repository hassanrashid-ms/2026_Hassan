import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { getIo } from '../src/shared/realtime/socketServer.ts';
import { emitInboxChanged } from '../src/shared/realtime/emit.ts';
import {
  closeOwnerPool,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';
import { connectClient, startRealtimeServer } from './helpers/realtime.ts';

let server: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeEach(async () => {
  await truncateAll();
  server = await startRealtimeServer();
});

afterEach(async () => {
  await server.close();
});

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

function waitFor(socket: ReturnType<typeof connectClient>, event: string): Promise<unknown> {
  return new Promise((resolve) => socket.once(event, resolve));
}

/**
 * An admin's JWT carries no workspace_id (Task 1) and no workspace_member row
 * exists for them anywhere (admin-dashboard model) — the handshake now
 * resolves every workspace for an admin and joins all of their inbox rooms,
 * with no per-connection workspaceId needed at all. See
 * 2026-08-25-global-inbox-workspace-decoupling-design.md section 1.
 */
describe('admin socket auth', () => {
  it('joins every workspace inbox room automatically, with no workspaceId in handshake auth', async () => {
    const workspaceId = await seedWorkspace();
    const token = await signAgentSession({ agent_id: randomUUID(), is_admin: true });

    const socket = connectClient(server.url, { token, role: 'agent' });
    await waitFor(socket, 'connect');

    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });

    const received = waitFor(socket, 'conversation:changed');
    emitInboxChanged(getIo(), workspaceId, conversationId, 'open');
    expect(await received).toEqual({
      conversation_id: conversationId,
      status: 'open',
      workspace_id: workspaceId,
    });

    socket.close();
  });

  it('an admin socket receives conversation:changed for any workspace, having joined both automatically', async () => {
    await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const token = await signAgentSession({ agent_id: randomUUID(), is_admin: true });

    const socket = connectClient(server.url, { token, role: 'agent' });
    await waitFor(socket, 'connect');

    const events: unknown[] = [];
    socket.on('conversation:changed', (payload: unknown) => events.push(payload));

    const playerB = await seedPlayer(workspaceB);
    const conversationId = await seedConversation({
      workspaceId: workspaceB,
      playerId: playerB,
      status: 'open',
    });
    emitInboxChanged(getIo(), workspaceB, conversationId, 'escalated');
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(events).toEqual([
      { conversation_id: conversationId, status: 'escalated', workspace_id: workspaceB },
    ]);

    socket.close();
  });
});
