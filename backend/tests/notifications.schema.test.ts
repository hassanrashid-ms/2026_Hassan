import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { notification } from '../src/shared/db/schema/index.ts';
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

describe('notification table', () => {
  it('inserts and reads back a row scoped to its workspace, invisible from another', async () => {
    const workspaceId = await seedWorkspace();
    const otherWorkspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const agentId = await seedAgent();

    const inserted = await withWorkspace(workspaceId, async (tx) => {
      const [row] = await tx
        .insert(notification)
        .values({
          workspaceId,
          agentId,
          type: 'ticket_assigned',
          conversationId,
          payload: { ticket_number: 1, priority: 'p3', via: 'claim' },
        })
        .returning();
      return row!;
    });

    const visibleInOwnWorkspace = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(notification).where(eq(notification.id, inserted.id)),
    );
    expect(visibleInOwnWorkspace).toHaveLength(1);

    const visibleInOtherWorkspace = await withWorkspace(otherWorkspaceId, (tx) =>
      tx.select().from(notification).where(eq(notification.id, inserted.id)),
    );
    expect(visibleInOtherWorkspace).toHaveLength(0);
  });
});
