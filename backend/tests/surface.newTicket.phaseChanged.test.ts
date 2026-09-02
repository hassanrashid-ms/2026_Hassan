import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { openNewTicket } from '../src/surface/services/newTicketService.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
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

describe('openNewTicket', () => {
  it('notifies an agent already viewing the previous ticket that it just closed', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const previousConversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'resolved',
    });

    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const agentToken = await signAgentSession({ agent_id: agentId });
    const agentClient = connectClient(server.url, { token: agentToken, role: 'agent' });
    await new Promise<void>((resolve) => agentClient.on('connect', () => resolve()));
    await new Promise<boolean>((resolve) =>
      agentClient.emit('join_conversation', { conversation_id: previousConversationId }, resolve),
    );

    const received: unknown[] = [];
    agentClient.on('conversation:phase_changed', (p: unknown) => received.push(p));

    const result = await openNewTicket({ workspaceId, playerId } as never, {});
    expect(result.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 150));
    expect(received).toEqual([{ conversation_id: previousConversationId, confirm_phase: 'none' }]);

    agentClient.close();
  });
});
