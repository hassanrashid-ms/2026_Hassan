import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { getIo } from '../src/shared/realtime/socketServer.ts';
import { emitInboxChanged } from '../src/shared/realtime/emit.ts';
import { connectClient, startRealtimeServer } from './helpers/realtime.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

let realtime: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeEach(truncateAll);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

function waitFor(socket: ReturnType<typeof connectClient>, event: string): Promise<unknown> {
  return new Promise((resolve) => socket.on(event, resolve));
}

describe('agent socket joins one inbox room per active membership', () => {
  it('receives conversation:changed for a second workspace it belongs to, with no rejoin needed', async () => {
    realtime = await startRealtimeServer();
    try {
      const workspaceA = await seedWorkspace();
      const workspaceB = await seedWorkspace();
      const agentId = await seedAgent();
      await seedWorkspaceMember({ workspaceId: workspaceA, agentId, role: 'agent' });
      await seedWorkspaceMember({ workspaceId: workspaceB, agentId, role: 'agent' });
      const playerB = await seedPlayer(workspaceB);
      const conversationId = await seedConversation({
        workspaceId: workspaceB,
        playerId: playerB,
        status: 'open',
      });
      const token = await signAgentSession({ agent_id: agentId });

      const socket = connectClient(realtime.url, { token, role: 'agent' });
      await waitFor(socket, 'connect');

      const events: unknown[] = [];
      socket.on('conversation:changed', (payload: unknown) => events.push(payload));

      emitInboxChanged(getIo(), workspaceB, conversationId, 'escalated');
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(events).toEqual([
        { conversation_id: conversationId, status: 'escalated', workspace_id: workspaceB },
      ]);

      socket.close();
    } finally {
      await realtime.close();
    }
  });

  it('an admin socket receives conversation:changed for any workspace, with no auth.workspaceId supplied', async () => {
    realtime = await startRealtimeServer();
    try {
      const workspaceId = await seedWorkspace();
      const adminId = await seedAgent(undefined, { isAdmin: true });
      const playerId = await seedPlayer(workspaceId);
      const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
      const token = await signAgentSession({ agent_id: adminId, is_admin: true });

      const socket = connectClient(realtime.url, { token, role: 'agent' });
      await waitFor(socket, 'connect');

      const events: unknown[] = [];
      socket.on('conversation:changed', (payload: unknown) => events.push(payload));

      emitInboxChanged(getIo(), workspaceId, conversationId, 'open');
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(events).toEqual([
        { conversation_id: conversationId, status: 'open', workspace_id: workspaceId },
      ]);

      socket.close();
    } finally {
      await realtime.close();
    }
  });
});
