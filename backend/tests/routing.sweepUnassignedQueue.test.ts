import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepUnassignedQueue } from '../src/domain/routing/sweepUnassignedQueue.ts';
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

async function assignedAgentIds(conversationIds: string[]) {
  const { rows } = await ownerPool.query<{ id: string; assigned_agent_id: string }>(
    `select id, assigned_agent_id from conversation where id = any($1) order by created_at`,
    [conversationIds],
  );
  return rows.map((r) => r.assigned_agent_id);
}

describe('sweepUnassignedQueue', () => {
  it('drains the whole queue, interleaving across two online agents rather than filling one first', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentA = await seedAgent('a-agent@example.test');
    const agentB = await seedAgent('b-agent@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: agentA });
    await seedWorkspaceMember({ workspaceId, agentId: agentB });
    await incrementPresence(agentA);
    await incrementPresence(agentB);
    await ownerPool.query(`update workspace set max_assigned_tickets = 10 where id = $1`, [
      workspaceId,
    ]);

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        await seedConversation({
          workspaceId,
          playerId,
          status: 'open',
          createdAt: new Date(2026, 0, i + 1),
        }),
      );
    }

    const result = await sweepUnassignedQueue(workspaceId);
    expect(result.assignedCount).toBe(4);
    expect(result.remainingCount).toBe(0);
    expect(result.stopReason).toBe('queue_empty');

    const owners = await assignedAgentIds(ids);
    expect(owners.every((id) => id !== null)).toBe(true);
    // Interleaved, not dumped on one agent: each agent got at least one, and
    // consecutive assignments alternate because liveCount is re-read every
    // iteration — agentA (lower id, wins the first tie) gets ticket 1,
    // agentB then has fewer live tickets and wins ticket 2, and so on.
    expect(new Set(owners).size).toBe(2);
    expect(owners[0]).not.toBe(owners[1]);
  });

  it('stops once no eligible agent remains, leaving the rest of the queue untouched', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);
    await ownerPool.query(`update workspace set max_assigned_tickets = 1 where id = $1`, [
      workspaceId,
    ]);

    const first = await seedConversation({ workspaceId, playerId, status: 'open' });
    const second = await seedConversation({ workspaceId, playerId, status: 'open' });

    const result = await sweepUnassignedQueue(workspaceId);
    expect(result.assignedCount).toBe(1);
    expect(result.assignments[0]!.conversationId).toBe(first);
    expect(result.remainingCount).toBe(1);
    expect(result.stopReason).toBe('all_at_capacity');

    const owners = await assignedAgentIds([second]);
    expect(owners[0]).toBeNull();
  });

  it('returns zero assigned when the queue starts empty', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);

    const result = await sweepUnassignedQueue(workspaceId);
    expect(result).toEqual({
      assignedCount: 0,
      assignments: [],
      remainingCount: 0,
      stopReason: 'queue_empty',
    });
  });

  it('reports none_online when the workspace has an eligible agent under cap but nobody online', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await seedConversation({ workspaceId, playerId, status: 'open' });

    const result = await sweepUnassignedQueue(workspaceId);
    expect(result.assignedCount).toBe(0);
    expect(result.remainingCount).toBe(1);
    expect(result.stopReason).toBe('none_online');
  });

  it('never sweeps another workspace', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const playerB = await seedPlayer(workspaceB);
    const agentB = await seedAgent();
    await seedWorkspaceMember({ workspaceId: workspaceB, agentId: agentB });
    await incrementPresence(agentB);
    const conversationId = await seedConversation({
      workspaceId: workspaceB,
      playerId: playerB,
      status: 'open',
    });

    const result = await sweepUnassignedQueue(workspaceA);
    expect(result).toEqual({
      assignedCount: 0,
      assignments: [],
      remainingCount: 0,
      stopReason: 'queue_empty',
    });
    const owners = await assignedAgentIds([conversationId]);
    expect(owners[0]).toBeNull();
  });
});
