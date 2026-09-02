// backend/tests/notifications.sweep.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { assignNextTicket } from '../src/domain/routing/assignNextTicket.ts';
import { closePresenceRedis, incrementPresence } from '../src/shared/realtime/presence.ts';
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

beforeEach(truncateAll);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
  await closePresenceRedis();
});

describe('assignNextTicket notifications', () => {
  it('notifies the picked agent with via: sweep', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    // Same Redis presence fixture routing.pickEligibleAgent.test.ts uses —
    // assignNextTicket's agent selection only considers Redis-online agents.
    await incrementPresence(agentId);

    const outcome = await assignNextTicket(workspaceId);
    expect(outcome.assigned).toBe(true);
    if (!outcome.assigned) return;
    expect(outcome.result.notification).toMatchObject({
      agent_id: agentId,
      conversation_id: conversationId,
      payload: { via: 'sweep' },
    });

    const { rows } = await ownerPool.query(
      `select agent_id, payload from notification where conversation_id = $1`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_id: agentId, payload: { via: 'sweep' } });
  });
});
