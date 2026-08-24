import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { postMessage } from '../src/domain/conversations/index.ts';
import { nextInactivityDueAt } from '../src/domain/conversations/resolutionCycle.ts';
import { resolutionCycle } from '../src/shared/db/schema/index.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedArticle,
  seedConversation,
  seedPlayer,
  seedResolutionCycle,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('postMessage', () => {
  it('bumps message_seq, inserts the message, and appends a message_sent event', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    const posted = await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'player',
        actorId: playerId,
        body: 'hi there',
      }),
    );

    expect(posted.seq).toBe(1);
    expect(posted.body).toBe('hi there');
    expect(posted.deliveryState).toBe('sent');
  });

  it('never produces a duplicate seq under concurrent sends into the same conversation', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_unused, i) =>
        withWorkspace(workspaceId, (tx) =>
          postMessage(tx, {
            workspaceId,
            conversationId,
            authorType: 'player',
            actorId: playerId,
            body: `msg ${i}`,
          }),
        ),
      ),
    );

    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  /**
   * The player and agent routes reject an empty body at their Zod schemas, so
   * anything empty reaching here is server-side code posting with nothing to
   * say — which is what put blank `bot` bubbles in front of players. Refused at
   * the choke point rather than at each caller, and it must not consume a seq.
   */
  it.each([
    ['empty', ''],
    ['whitespace only', '   \n\t '],
  ])('refuses to post a %s body, and does not burn a seq doing it', async (_label, body) => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    await expect(
      withWorkspace(workspaceId, (tx) =>
        postMessage(tx, { workspaceId, conversationId, authorType: 'bot', actorId: null, body }),
      ),
    ).rejects.toThrow(/refusing to post an empty bot message/);

    const after = await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'bot',
        actorId: null,
        body: 'a real reply',
      }),
    );
    expect(after.seq).toBe(1);
  });

  it('persists article_id when given one, and leaves it null when not', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const agentId = await seedAgent();
    const articleId = await seedArticle({ workspaceId, createdBy: agentId });

    const cited = await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'bot',
        actorId: null,
        body: 'Refunds take 48 hours.',
        articleId,
      }),
    );
    const uncited = await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'bot',
        actorId: null,
        body: 'Anything else?',
      }),
    );

    // The returned row, not just the database: PostedMessageRow is what both
    // serializers read, so a column that persisted but did not come back through
    // .returning() would still reach the client as null.
    expect(cited.articleId).toBe(articleId);
    expect(uncited.articleId).toBeNull();

    const { rows } = await ownerPool.query(
      `select article_id from message where conversation_id = $1 order by seq`,
      [conversationId],
    );
    expect(rows).toEqual([{ article_id: articleId }, { article_id: null }]);
  });
});

describe('postMessage inactivity clock touch', () => {
  const NOW = new Date('2026-08-18T12:00:00Z');

  async function fixture(status: 'open' | 'awaiting_player' | 'bot_active' | 'escalated') {
    const workspaceId = await seedWorkspace({ slug: `ws-${status}` });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status });
    await seedResolutionCycle({ workspaceId, conversationId });
    return { workspaceId, playerId, conversationId };
  }

  const due = (workspaceId: string, conversationId: string) =>
    withWorkspace(workspaceId, async (tx) => {
      const [row] = await tx
        .select({ dueAt: resolutionCycle.inactivityDueAt })
        .from(resolutionCycle)
        .where(eq(resolutionCycle.conversationId, conversationId));
      return row!.dueAt;
    });

  it('pushes the due date one window out on a public message in open', async () => {
    const { workspaceId, playerId, conversationId } = await fixture('open');
    await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'player',
        actorId: playerId,
        body: 'still broken',
        now: NOW,
      }),
    );
    expect((await due(workspaceId, conversationId))!.toISOString()).toBe(
      nextInactivityDueAt(NOW).toISOString(),
    );
  });

  it('touches on awaiting_player too', async () => {
    const { workspaceId, conversationId } = await fixture('awaiting_player');
    await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'system',
        actorId: null,
        body: 'Did this solve it?',
        now: NOW,
      }),
    );
    expect((await due(workspaceId, conversationId))!.toISOString()).toBe(
      nextInactivityDueAt(NOW).toISOString(),
    );
  });

  it('does not touch while the bot owns the conversation', async () => {
    const { workspaceId, playerId, conversationId } = await fixture('bot_active');
    await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'player',
        actorId: playerId,
        body: 'hi',
        now: NOW,
      }),
    );
    expect(await due(workspaceId, conversationId)).toBeNull();
  });

  it('does not touch while escalated', async () => {
    const { workspaceId, conversationId } = await fixture('escalated');
    await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'system',
        actorId: null,
        body: 'note',
        now: NOW,
      }),
    );
    expect(await due(workspaceId, conversationId)).toBeNull();
  });

  it('does not touch on an internal note', async () => {
    const { workspaceId, conversationId } = await fixture('open');
    await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'agent',
        actorId: null,
        body: 'internal only',
        visibility: 'internal',
        now: NOW,
      }),
    );
    expect(await due(workspaceId, conversationId)).toBeNull();
  });
});
