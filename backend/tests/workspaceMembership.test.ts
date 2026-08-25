import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import {
  listActiveMembershipsForAgent,
  listAllWorkspaces,
} from '../src/shared/db/workspaceMembership.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('listActiveMembershipsForAgent', () => {
  it('returns only the active memberships for this specific agent, across workspaces', async () => {
    const workspaceA = await seedWorkspace({ slug: 'ws-a', name: 'Workspace A' });
    const workspaceB = await seedWorkspace({ slug: 'ws-b', name: 'Workspace B' });
    const workspaceC = await seedWorkspace({ slug: 'ws-c', name: 'Workspace C' });
    const agentId = await seedAgent();
    const otherAgentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId: workspaceA, agentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId: workspaceB, agentId, role: 'team_lead' });
    await seedWorkspaceMember({
      workspaceId: workspaceC,
      agentId,
      role: 'agent',
      deactivatedAt: new Date(),
    });
    await seedWorkspaceMember({ workspaceId: workspaceA, agentId: otherAgentId, role: 'agent' });

    const rows = await listActiveMembershipsForAgent(agentId);

    expect(rows).toEqual(
      expect.arrayContaining([
        { workspaceId: workspaceA, workspaceSlug: 'ws-a', workspaceName: 'Workspace A', role: 'agent' },
        {
          workspaceId: workspaceB,
          workspaceSlug: 'ws-b',
          workspaceName: 'Workspace B',
          role: 'team_lead',
        },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it('returns an empty list for an agent with zero memberships', async () => {
    const agentId = await seedAgent();
    expect(await listActiveMembershipsForAgent(agentId)).toEqual([]);
  });
});

describe('listAllWorkspaces', () => {
  it('returns every workspace regardless of membership', async () => {
    const workspaceA = await seedWorkspace({ slug: 'ws-x' });
    const workspaceB = await seedWorkspace({ slug: 'ws-y' });

    const rows = await listAllWorkspaces();

    expect(rows.map((r) => r.workspaceId)).toEqual(
      expect.arrayContaining([workspaceA, workspaceB]),
    );
  });
});
