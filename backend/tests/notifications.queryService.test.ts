import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { notifyAgent } from '../src/domain/notifications/notifyAgent.ts';
import {
  listNotificationsForAgent,
  markAllNotificationsRead,
  markNotificationRead,
} from '../src/domain/notifications/notificationsQueryService.ts';
import {
  closeOwnerPool,
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
});

describe('notificationsQueryService', () => {
  it('lists notifications across every workspace the agent belongs to, newest first', async () => {
    const wsA = await seedWorkspace({ name: 'Game A' });
    const wsB = await seedWorkspace({ name: 'Game B' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId: wsA, agentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId: wsB, agentId, role: 'agent' });

    const playerA = await seedPlayer(wsA);
    const convA = await seedConversation({ workspaceId: wsA, playerId: playerA });
    const playerB = await seedPlayer(wsB);
    const convB = await seedConversation({ workspaceId: wsB, playerId: playerB });

    await withWorkspace(wsA, (tx) =>
      notifyAgent(tx, { workspaceId: wsA, agentId, conversationId: convA, via: 'claim' }),
    );
    await withWorkspace(wsB, (tx) =>
      notifyAgent(tx, { workspaceId: wsB, agentId, conversationId: convB, via: 'sweep' }),
    );

    const { notifications, unread_count } = await listNotificationsForAgent({
      agentId,
      workspaceId: '',
      isAdmin: false,
    });

    expect(notifications).toHaveLength(2);
    expect(unread_count).toBe(2);
    expect(new Set(notifications.map((n) => n.workspace_id))).toEqual(new Set([wsA, wsB]));
  });

  it('marks one notification read without affecting others, across workspaces', async () => {
    const wsA = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId: wsA, agentId, role: 'agent' });
    const playerA = await seedPlayer(wsA);
    const convA = await seedConversation({ workspaceId: wsA, playerId: playerA });

    const view = await withWorkspace(wsA, (tx) =>
      notifyAgent(tx, { workspaceId: wsA, agentId, conversationId: convA, via: 'claim' }),
    );

    const ok = await markNotificationRead({ agentId, workspaceId: '', isAdmin: false }, view.id);
    expect(ok).toBe(true);

    const { notifications, unread_count } = await listNotificationsForAgent({
      agentId,
      workspaceId: '',
      isAdmin: false,
    });
    expect(unread_count).toBe(0);
    expect(notifications[0]!.read_at).not.toBeNull();
  });

  it('marks all unread notifications read across every workspace', async () => {
    const wsA = await seedWorkspace();
    const wsB = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId: wsA, agentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId: wsB, agentId, role: 'agent' });
    const playerA = await seedPlayer(wsA);
    const convA = await seedConversation({ workspaceId: wsA, playerId: playerA });
    const playerB = await seedPlayer(wsB);
    const convB = await seedConversation({ workspaceId: wsB, playerId: playerB });
    await withWorkspace(wsA, (tx) =>
      notifyAgent(tx, { workspaceId: wsA, agentId, conversationId: convA, via: 'claim' }),
    );
    await withWorkspace(wsB, (tx) =>
      notifyAgent(tx, { workspaceId: wsB, agentId, conversationId: convB, via: 'sweep' }),
    );

    const updated = await markAllNotificationsRead({ agentId, workspaceId: '', isAdmin: false });
    expect(updated).toBe(2);

    const { unread_count } = await listNotificationsForAgent({
      agentId,
      workspaceId: '',
      isAdmin: false,
    });
    expect(unread_count).toBe(0);
  });
});
