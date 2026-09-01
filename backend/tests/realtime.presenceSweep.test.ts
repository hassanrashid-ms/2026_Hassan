// backend/tests/realtime.presenceSweep.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closePresenceRedis } from '../src/shared/realtime/presence.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { connectClient, startRealtimeServer } from './helpers/realtime.ts';
import {
  closeOwnerPool,
  ownerPool,
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
  await realtime?.close();
  await closePresenceRedis();
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

async function conversationRow(id: string) {
  const { rows } = await ownerPool.query(`select assigned_agent_id from conversation where id = $1`, [
    id,
  ]);
  return rows[0];
}

describe('presence-online triggers a sweep', () => {
  it('assigns a waiting unassigned ticket to the agent who just connected', async () => {
    realtime = await startRealtimeServer();

    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const token = await signAgentSession({ agent_id: agentId });

    const socket = connectClient(realtime.url, { token, role: 'agent' });
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    // The sweep is fire-and-forget off the connect handler; give it a beat.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const row = await conversationRow(conversationId);
    expect(row.assigned_agent_id).toBe(agentId);

    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
});
