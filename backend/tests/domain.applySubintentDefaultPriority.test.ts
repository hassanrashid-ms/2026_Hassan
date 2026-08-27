import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applySubintentDefaultPriority } from '../src/domain/conversations/index.ts';
import { conversation } from '../src/shared/db/schema/index.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { closeDb } from '../src/shared/db/client.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedIntent,
  seedPlayer,
  seedSubintent,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

beforeEach(truncateAll);
afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

async function conversationRow(id: string) {
  const { rows } = await ownerPool.query<{ priority: string; priority_manually_set: boolean }>(
    `select priority, priority_manually_set from conversation where id = $1`,
    [id],
  );
  return rows[0]!;
}

async function eventsFor(conversationId: string) {
  const { rows } = await ownerPool.query(
    `select type, actor_id, actor_type, payload from event where conversation_id = $1 order by id`,
    [conversationId],
  );
  return rows;
}

describe('applySubintentDefaultPriority', () => {
  it('applies the subintent default priority when unset and priority differs', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const intentId = await seedIntent(workspaceId);
    const subintentId = await seedSubintent({ workspaceId, intentId, defaultPriority: 'p1' });
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p3' });

    await withWorkspace(workspaceId, (tx) =>
      applySubintentDefaultPriority(tx, {
        workspaceId,
        conversationId,
        subintentId,
        currentPriority: 'p3',
        priorityManuallySet: false,
        actorId: null,
        actorType: 'bot',
      }),
    );

    const row = await conversationRow(conversationId);
    expect(row.priority).toBe('p1');

    const events = await eventsFor(conversationId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'conversation_priority_changed',
      actor_id: null,
      actor_type: 'bot',
      payload: { from: 'p3', to: 'p1', reason: 'subintent_default' },
    });
  });

  it('does nothing when priorityManuallySet is true', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const intentId = await seedIntent(workspaceId);
    const subintentId = await seedSubintent({ workspaceId, intentId, defaultPriority: 'p1' });
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      priority: 'p4',
      priorityManuallySet: true,
    });

    await withWorkspace(workspaceId, (tx) =>
      applySubintentDefaultPriority(tx, {
        workspaceId,
        conversationId,
        subintentId,
        currentPriority: 'p4',
        priorityManuallySet: true,
        actorId: null,
        actorType: 'bot',
      }),
    );

    const row = await conversationRow(conversationId);
    expect(row.priority).toBe('p4');
    expect(await eventsFor(conversationId)).toEqual([]);
  });

  it('does nothing when the subintent has no default priority', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const intentId = await seedIntent(workspaceId);
    const subintentId = await seedSubintent({ workspaceId, intentId });
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p3' });

    await withWorkspace(workspaceId, (tx) =>
      applySubintentDefaultPriority(tx, {
        workspaceId,
        conversationId,
        subintentId,
        currentPriority: 'p3',
        priorityManuallySet: false,
        actorId: null,
        actorType: 'bot',
      }),
    );

    const row = await conversationRow(conversationId);
    expect(row.priority).toBe('p3');
    expect(await eventsFor(conversationId)).toEqual([]);
  });

  it('does nothing when the default priority equals the current priority', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const intentId = await seedIntent(workspaceId);
    const subintentId = await seedSubintent({ workspaceId, intentId, defaultPriority: 'p3' });
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p3' });

    await withWorkspace(workspaceId, (tx) =>
      applySubintentDefaultPriority(tx, {
        workspaceId,
        conversationId,
        subintentId,
        currentPriority: 'p3',
        priorityManuallySet: false,
        actorId: null,
        actorType: 'bot',
      }),
    );

    expect(await eventsFor(conversationId)).toEqual([]);
  });
});
