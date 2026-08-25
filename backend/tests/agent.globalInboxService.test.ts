import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { getGlobalInbox } from '../src/agent/services/globalInboxService.ts';
import type { AgentContext } from '../src/shared/middleware/requireAgentSession.ts';
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

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('getGlobalInbox', () => {
  it('merges active tickets from every active membership, tagging each with its workspace', async () => {
    const workspaceA = await seedWorkspace({ slug: 'ws-a' });
    const workspaceB = await seedWorkspace({ slug: 'ws-b' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId: workspaceA, agentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId: workspaceB, agentId, role: 'agent' });
    const playerA = await seedPlayer(workspaceA);
    const playerB = await seedPlayer(workspaceB);
    const convA = await seedConversation({ workspaceId: workspaceA, playerId: playerA, status: 'open' });
    const convB = await seedConversation({
      workspaceId: workspaceB,
      playerId: playerB,
      status: 'escalated',
    });

    const ctx: AgentContext = { agentId, workspaceId: '', isAdmin: false };
    const result = await getGlobalInbox(ctx);

    expect(result.failed_workspaces).toEqual([]);
    expect(result.conversations.map((c) => c.id)).toEqual(expect.arrayContaining([convA, convB]));
    const rowA = result.conversations.find((c) => c.id === convA)!;
    expect(rowA.workspace).toEqual({ id: workspaceA, slug: 'ws-a' });
  });

  it('excludes resolved and closed conversations', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const playerId = await seedPlayer(workspaceId);
    await seedConversation({ workspaceId, playerId, status: 'resolved' });
    await seedConversation({ workspaceId, playerId, status: 'closed' });
    const open = await seedConversation({ workspaceId, playerId, status: 'open' });

    const ctx: AgentContext = { agentId, workspaceId: '', isAdmin: false };
    const result = await getGlobalInbox(ctx);

    expect(result.conversations.map((c) => c.id)).toEqual([open]);
  });

  it('gives an admin every workspace, not just memberships', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const adminId = await seedAgent(undefined, { isAdmin: true });
    const playerA = await seedPlayer(workspaceA);
    const playerB = await seedPlayer(workspaceB);
    const convA = await seedConversation({ workspaceId: workspaceA, playerId: playerA, status: 'open' });
    const convB = await seedConversation({ workspaceId: workspaceB, playerId: playerB, status: 'open' });

    const ctx: AgentContext = { agentId: adminId, workspaceId: '', isAdmin: true };
    const result = await getGlobalInbox(ctx);

    expect(result.conversations.map((c) => c.id)).toEqual(expect.arrayContaining([convA, convB]));
  });

  it('excludes a workspace whose query fails, and reports it in failed_workspaces', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const playerId = await seedPlayer(workspaceId);
    await seedConversation({ workspaceId, playerId, status: 'open' });

    // Simulate a transient failure for this workspace's query by revoking the
    // app role's SELECT on conversation just for this test, then restoring it.
    await ownerPool.query(`revoke select on conversation from support_app`);
    try {
      const ctx: AgentContext = { agentId, workspaceId: '', isAdmin: false };
      const result = await getGlobalInbox(ctx);
      expect(result.conversations).toEqual([]);
      expect(result.failed_workspaces).toEqual([workspaceId]);
    } finally {
      await ownerPool.query(`grant select on conversation to support_app`);
    }
  });
});
