import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { applyBotTurn } from '../src/domain/bot/applyBotTurn.ts';
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

describe('bot handoff notifications', () => {
  it('notifies the picked agent with via: bot_handoff when handoff assigns someone', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'bot_active' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    // Marks the agent online in Redis presence, the same fixture
    // routing.pickEligibleAgent.test.ts uses — pickEligibleAgent (called
    // transitively by assignOnHandoff) only selects agents Redis reports online.
    await incrementPresence(agentId);

    const result = await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(
        tx,
        { workspaceId, conversationId },
        { kind: 'handoff', reason: 'asked_for_person', subintentId: null, searches: [] },
      ),
    );

    expect(result.notification).toMatchObject({
      agent_id: agentId,
      conversation_id: conversationId,
      payload: { via: 'bot_handoff' },
    });

    const { rows } = await ownerPool.query(
      `select agent_id, payload from notification where conversation_id = $1`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_id: agentId, payload: { via: 'bot_handoff' } });
  });

  it('does not notify anyone when no agent is online', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'bot_active' });

    const result = await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(
        tx,
        { workspaceId, conversationId },
        { kind: 'handoff', reason: 'asked_for_person', subintentId: null, searches: [] },
      ),
    );

    expect(result.notification).toBeNull();
    const { rows } = await ownerPool.query(
      `select 1 from notification where conversation_id = $1`,
      [conversationId],
    );
    expect(rows).toHaveLength(0);
  });
});
