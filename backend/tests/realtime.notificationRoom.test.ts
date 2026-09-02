import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { emitNotificationNew } from '../src/shared/realtime/emit.ts';
import { getIo } from '../src/shared/realtime/socketServer.ts';
import type { NotificationView } from '@support/types';
import {
  closeOwnerPool,
  seedAgent,
  seedWorkspace,
  seedWorkspaceMember,
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

function waitFor(socket: ReturnType<typeof connectClient>, event: string): Promise<void> {
  return new Promise((resolve) => socket.on(event, () => resolve()));
}

describe('notification:new', () => {
  it('reaches the assigned agent without any explicit room join', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const agentToken = await signAgentSession({ agent_id: agentId });

    const agentClient = connectClient(server.url, { token: agentToken, role: 'agent' });
    await waitFor(agentClient, 'connect');

    const received: NotificationView[] = [];
    agentClient.on('notification:new', (n: NotificationView) => received.push(n));

    const fakeNotification: NotificationView = {
      id: 'test-id',
      workspace_id: workspaceId,
      agent_id: agentId,
      type: 'ticket_assigned',
      conversation_id: null,
      payload: {},
      read_at: null,
      created_at: new Date().toISOString(),
    };
    emitNotificationNew(getIo(), agentId, fakeNotification);

    await new Promise((r) => setTimeout(r, 150));
    expect(received).toEqual([fakeNotification]);

    agentClient.close();
  });
});
