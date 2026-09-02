import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pickEligibleAgent } from '../src/domain/routing/pickEligibleAgent.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { incrementPresence, closePresenceRedis } from '../src/shared/realtime/presence.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
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

function pick(workspaceId: string) {
  return withWorkspace(workspaceId, (tx) => pickEligibleAgent(tx, workspaceId));
}

describe('pickEligibleAgent', () => {
  it('returns the agentId when an eligible online agent exists', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);

    const result = await pick(workspaceId);
    expect(result).toEqual({ agentId });
  });

  it('reports no_active_agents when the workspace has no active member', async () => {
    const workspaceId = await seedWorkspace();

    const result = await pick(workspaceId);
    expect(result).toEqual({ agentId: null, reason: 'no_active_agents' });
  });

  it('reports no_active_agents when the only member is deactivated', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, deactivatedAt: new Date() });
    await incrementPresence(agentId);

    const result = await pick(workspaceId);
    expect(result).toEqual({ agentId: null, reason: 'no_active_agents' });
  });

  it('reports all_at_capacity when every active agent is at their ticket cap', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = (
      await ownerPool.query<{ id: string }>(
        `insert into player (id, workspace_id, external_id) values (gen_random_uuid(), $1, 'p1') returning id`,
        [workspaceId],
      )
    ).rows[0]!.id;
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);
    await ownerPool.query(`update workspace set max_assigned_tickets = 1 where id = $1`, [
      workspaceId,
    ]);
    await ownerPool.query(
      `insert into conversation (id, workspace_id, player_id, number, status, assigned_agent_id)
       values (gen_random_uuid(), $1, $2, 1, 'open', $3)`,
      [workspaceId, playerId, agentId],
    );

    const result = await pick(workspaceId);
    expect(result).toEqual({ agentId: null, reason: 'all_at_capacity' });
  });

  it('reports none_online when an eligible agent exists under cap but nobody is online', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });

    const result = await pick(workspaceId);
    expect(result).toEqual({ agentId: null, reason: 'none_online' });
  });
});
