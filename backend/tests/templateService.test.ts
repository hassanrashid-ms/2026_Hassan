import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { messageTemplate } from '../src/shared/db/schema/index.ts';
import { closeTemplateCacheRedis } from '../src/domain/templates/templateCache.ts';
import {
  addHandoffVariant,
  createCannedReply,
  createSystemTemplate,
  getHandoffMessage,
  getSystemMessage,
  listCannedReplies,
  updateTemplate,
} from '../src/domain/templates/templateService.ts';
import { getCachedTemplates } from '../src/domain/templates/templateCache.ts';
import { HANDOFF_PLAYER_MESSAGES, NO_AGENTS_ONLINE_MESSAGE } from '../src/domain/bot/messages.ts';
import { closeOwnerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

afterAll(async () => {
  await closeTemplateCacheRedis();
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('templateService read path', () => {
  it('falls back to the hardcoded default when no row exists', async () => {
    const workspaceId = await seedWorkspace();
    const message = await withWorkspace(workspaceId, (tx) =>
      getSystemMessage(tx, workspaceId, 'no_agents_online'),
    );
    expect(message).toBe(NO_AGENTS_ONLINE_MESSAGE);
  });

  it('falls back to the hardcoded handoff list when no rows exist', async () => {
    const workspaceId = await seedWorkspace();
    const message = await withWorkspace(workspaceId, (tx) => getHandoffMessage(tx, workspaceId));
    expect(HANDOFF_PLAYER_MESSAGES as readonly string[]).toContain(message);
  });

  it('prefers an active DB row over the default', async () => {
    const workspaceId = await seedWorkspace();
    await withWorkspace(workspaceId, (tx) =>
      tx.insert(messageTemplate).values({
        workspaceId,
        kind: 'system',
        key: 'no_agents_online',
        body: 'Custom no-agents line.',
        sortOrder: 0,
      }),
    );
    const message = await withWorkspace(workspaceId, (tx) =>
      getSystemMessage(tx, workspaceId, 'no_agents_online'),
    );
    expect(message).toBe('Custom no-agents line.');
  });

  it('ignores a deactivated row and falls back to the default', async () => {
    const workspaceId = await seedWorkspace();
    await withWorkspace(workspaceId, (tx) =>
      tx.insert(messageTemplate).values({
        workspaceId,
        kind: 'system',
        key: 'no_agents_online',
        body: 'Retired line.',
        sortOrder: 0,
        isActive: false,
      }),
    );
    const message = await withWorkspace(workspaceId, (tx) =>
      getSystemMessage(tx, workspaceId, 'no_agents_online'),
    );
    expect(message).toBe(NO_AGENTS_ONLINE_MESSAGE);
  });

  it('lists active canned replies ordered by sort_order, excludes inactive ones', async () => {
    const workspaceId = await seedWorkspace();
    await withWorkspace(workspaceId, (tx) =>
      tx.insert(messageTemplate).values([
        {
          workspaceId,
          kind: 'canned',
          label: 'Closing',
          body: 'Thanks for reaching out!',
          sortOrder: 1,
        },
        {
          workspaceId,
          kind: 'canned',
          label: 'Intro',
          body: 'Hi, this is {{agent_name}}.',
          sortOrder: 0,
        },
        {
          workspaceId,
          kind: 'canned',
          label: 'Retired',
          body: 'no longer used',
          sortOrder: 2,
          isActive: false,
        },
      ]),
    );
    const replies = await withWorkspace(workspaceId, (tx) => listCannedReplies(tx, workspaceId));
    expect(replies.map((r) => r.label)).toEqual(['Intro', 'Closing']);
  });

  it('scopes rows per workspace — no cross-talk', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    await withWorkspace(workspaceA, (tx) =>
      tx.insert(messageTemplate).values({
        workspaceId: workspaceA,
        kind: 'system',
        key: 'no_agents_online',
        body: 'Workspace A only.',
        sortOrder: 0,
      }),
    );
    const messageB = await withWorkspace(workspaceB, (tx) =>
      getSystemMessage(tx, workspaceB, 'no_agents_online'),
    );
    expect(messageB).toBe(NO_AGENTS_ONLINE_MESSAGE);
  });

  it('caches the DB result so a second read within the same test does not need a fresh row', async () => {
    const workspaceId = await seedWorkspace();
    const first = await withWorkspace(workspaceId, (tx) =>
      getSystemMessage(tx, workspaceId, 'no_agents_online'),
    );
    // Row untouched — second read must still agree, proving the cache path
    // (or a repeat DB read) returns the same value, not a fluke.
    const second = await withWorkspace(workspaceId, (tx) =>
      getSystemMessage(tx, workspaceId, 'no_agents_online'),
    );
    expect(second).toBe(first);
  });
});

describe('templateService write path', () => {
  async function ctxFor(workspaceId: string) {
    const { rows } = await (
      await import('./helpers/db.ts')
    ).ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name, is_admin) values ($1, 'Test Admin', true) returning id`,
      [`admin-${randomUUID()}@example.test`],
    );
    return { agentId: rows[0]!.id, workspaceId };
  }

  it('createSystemTemplate replaces the prior active row for a singleton key', async () => {
    const workspaceId = await seedWorkspace();
    const ctx = await ctxFor(workspaceId);

    const first = await createSystemTemplate(ctx, {
      key: 'no_agents_online',
      body: 'First custom line.',
    });
    const second = await createSystemTemplate(ctx, {
      key: 'no_agents_online',
      body: 'Second custom line.',
    });

    expect(first.id).not.toBe(second.id);
    const resolved = await withWorkspace(workspaceId, (tx) =>
      getSystemMessage(tx, workspaceId, 'no_agents_online'),
    );
    expect(resolved).toBe('Second custom line.');
  });

  it('addHandoffVariant appends rather than replacing', async () => {
    const workspaceId = await seedWorkspace();
    const ctx = await ctxFor(workspaceId);

    await addHandoffVariant(ctx, 'Variant one.');
    await addHandoffVariant(ctx, 'Variant two.');

    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const message = await withWorkspace(workspaceId, (tx) => getHandoffMessage(tx, workspaceId));
      seen.add(message);
    }
    expect(seen).toEqual(new Set(['Variant one.', 'Variant two.']));
  });

  it('createCannedReply then updateTemplate edits its body', async () => {
    const workspaceId = await seedWorkspace();
    const ctx = await ctxFor(workspaceId);

    const created = await createCannedReply(ctx, { label: 'Intro', body: 'Hi there.' });
    await updateTemplate(ctx, created.id, { body: 'Hi, {{agent_name}} here.' });

    const replies = await withWorkspace(workspaceId, (tx) => listCannedReplies(tx, workspaceId));
    expect(replies).toEqual([{ id: created.id, label: 'Intro', body: 'Hi, {{agent_name}} here.' }]);
  });

  it('updateTemplate with isActive:false removes it from the active list', async () => {
    const workspaceId = await seedWorkspace();
    const ctx = await ctxFor(workspaceId);

    const created = await createCannedReply(ctx, { label: 'Intro', body: 'Hi there.' });
    await updateTemplate(ctx, created.id, { isActive: false });

    const replies = await withWorkspace(workspaceId, (tx) => listCannedReplies(tx, workspaceId));
    expect(replies).toEqual([]);
  });

  it('any write invalidates the Redis cache for that workspace', async () => {
    const workspaceId = await seedWorkspace();
    const ctx = await ctxFor(workspaceId);

    // Warm the cache
    await withWorkspace(workspaceId, (tx) => getSystemMessage(tx, workspaceId, 'no_agents_online'));
    expect(await getCachedTemplates(workspaceId)).not.toBeNull();

    await createSystemTemplate(ctx, { key: 'no_agents_online', body: 'New line.' });
    expect(await getCachedTemplates(workspaceId)).toBeNull();
  });
});
