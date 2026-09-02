import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { notifyAgent } from '../src/domain/notifications/notifyAgent.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

beforeEach(truncateAll);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

describe('notifyAgent', () => {
  it('inserts a ticket_assigned notification with a snapshotted payload', async () => {
    const workspaceId = await seedWorkspace({ name: 'Wanderlust Kingdoms', slug: 'wanderlust' });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p2' });
    const agentId = await seedAgent();

    const view = await withWorkspace(workspaceId, (tx) =>
      notifyAgent(tx, { workspaceId, agentId, conversationId, via: 'claim' }),
    );

    expect(view.workspace_id).toBe(workspaceId);
    expect(view.agent_id).toBe(agentId);
    expect(view.conversation_id).toBe(conversationId);
    expect(view.type).toBe('ticket_assigned');
    expect(view.read_at).toBeNull();
    expect(view.payload).toMatchObject({
      priority: 'p2',
      via: 'claim',
      workspace_name: 'Wanderlust Kingdoms',
      workspace_slug: 'wanderlust',
    });
    expect(typeof (view.payload as { ticket_number: number }).ticket_number).toBe('number');
  });
});
