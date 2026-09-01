// backend/tests/routing.assignNextTicket.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { assignNextTicket } from '../src/domain/routing/assignNextTicket.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { incrementPresence, closePresenceRedis } from '../src/shared/realtime/presence.ts';
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
  await closeOwnerPool();
  await closePresenceRedis();
});

async function conversationRow(id: string) {
  const { rows } = await ownerPool.query(
    `select status, assigned_agent_id from conversation where id = $1`,
    [id],
  );
  return rows[0];
}
async function eventsFor(id: string) {
  const { rows } = await ownerPool.query(
    `select type, payload from event where conversation_id = $1 order by id`,
    [id],
  );
  return rows;
}

describe('assignNextTicket', () => {
  it('assigns the highest-priority unassigned conversation to the eligible agent', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);

    const low = await seedConversation({ workspaceId, playerId, status: 'open', priority: 'p3' });
    const high = await seedConversation({ workspaceId, playerId, status: 'open', priority: 'p1' });

    const result = await assignNextTicket(workspaceId);
    expect(result).toEqual({ conversationId: high, agentId, status: 'open' });

    const row = await conversationRow(high);
    expect(row.assigned_agent_id).toBe(agentId);
    const stillUnassigned = await conversationRow(low);
    expect(stillUnassigned.assigned_agent_id).toBeNull();
  });

  it('breaks a priority tie by age — oldest first', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);

    const older = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      priority: 'p2',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      priority: 'p2',
      createdAt: new Date('2026-01-02T00:00:00Z'),
    });

    const result = await assignNextTicket(workspaceId);
    expect(result?.conversationId).toBe(older);
  });

  it('writes a conversation_assigned event', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });

    await assignNextTicket(workspaceId);

    const events = await eventsFor(conversationId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('conversation_assigned');
    expect(events[0].payload).toMatchObject({ agent_id: agentId, via: 'sweep' });
  });

  it('returns null and assigns nothing when the queue is empty', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);

    const result = await assignNextTicket(workspaceId);
    expect(result).toBeNull();
  });

  it('returns null and leaves the conversation unassigned when no agent is eligible', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });

    const result = await assignNextTicket(workspaceId);
    expect(result).toBeNull();
    const row = await conversationRow(conversationId);
    expect(row.assigned_agent_id).toBeNull();
  });

  it('never selects an awaiting_player conversation — it is not in the unassigned queue', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);
    // awaiting_player always has an owner in practice, but the query must not
    // pick one up even if assigned_agent_id were somehow null.
    await ownerPool.query(
      `insert into conversation (id, workspace_id, player_id, number, status, assigned_agent_id)
       select gen_random_uuid(), $1, $2, (select ticket_seq + 1 from workspace where id = $1), 'awaiting_player', null`,
      [workspaceId, playerId],
    );

    const result = await assignNextTicket(workspaceId);
    expect(result).toBeNull();
  });
});
