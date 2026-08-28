import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyBotTurn } from '../src/domain/bot/applyBotTurn.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { closeDb } from '../src/shared/db/client.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedArticle,
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

async function conversationRow(id: string) {
  const { rows } = await ownerPool.query(
    `select status, confirm_phase, resolution_source from conversation where id = $1`,
    [id],
  );
  return rows[0];
}

async function messagesFor(conversationId: string) {
  const { rows } = await ownerPool.query(
    `select author_type, visibility, body from message where conversation_id = $1 order by seq`,
    [conversationId],
  );
  return rows;
}

async function eventsFor(conversationId: string) {
  const { rows } = await ownerPool.query(
    `select type, payload from event where conversation_id = $1 order by id`,
    [conversationId],
  );
  return rows;
}

async function setConfirmPhase(
  conversationId: string,
  phase: 'none' | 'bot_article' | 'agent_ask',
) {
  await ownerPool.query(`update conversation set confirm_phase = $2 where id = $1`, [
    conversationId,
    phase,
  ]);
}

describe('applyBotTurn — resolve and article lifecycle', () => {
  it('answer with articleId sets confirm_phase to bot_article and writes bot_article_offered', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const agentId = await seedAgent();
    const articleId = await seedArticle({
      workspaceId,
      createdBy: agentId,
      title: 'How refunds work',
    });

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(
        tx,
        { workspaceId, conversationId },
        { kind: 'answer', reply: 'try this', subintentId: null, articleId },
      ),
    );

    const row = await conversationRow(conversationId);
    expect(row.confirm_phase).toBe('bot_article');

    const events = await eventsFor(conversationId);
    expect(events.map((e) => e.type)).toEqual(['message_sent', 'bot_article_offered']);
    expect(events[1].payload).toEqual({ article_id: articleId, article_title: 'How refunds work' });
  });

  it('confirm_resolution(true) resolves the conversation, writes conversation_resolved with source bot, sets confirm_phase none', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await setConfirmPhase(conversationId, 'bot_article');

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'resolve', subintentId: null }),
    );

    const row = await conversationRow(conversationId);
    expect(row.status).toBe('resolved');
    expect(row.confirm_phase).toBe('none');
    expect(row.resolution_source).toBe('bot');

    expect(await messagesFor(conversationId)).toEqual([]);

    const events = await eventsFor(conversationId);
    expect(events.map((e) => e.type)).toEqual(['conversation_resolved']);
    expect(events[0].payload).toEqual({ source: 'bot', confirmed_by: 'player' });
  });

  it('confirm_resolution(false) [i.e. handoff(article_rejected)] writes bot_article_rejected', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await setConfirmPhase(conversationId, 'bot_article');

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(
        tx,
        { workspaceId, conversationId },
        { kind: 'handoff', reason: 'article_rejected', subintentId: null },
      ),
    );

    const row = await conversationRow(conversationId);
    expect(row.status).toBe('open');
    expect(row.confirm_phase).toBe('none');

    const events = await eventsFor(conversationId);
    expect(events.map((e) => e.type)).toEqual([
      'message_sent',
      'bot_article_rejected',
      'bot_handoff',
      'message_sent',
    ]);
    expect(events[1].payload).toEqual({});
  });
});

describe('applyBotTurn — bot_search retrieval telemetry', () => {
  it('writes one bot_search per search, before the outcome events, with snapshotted titles', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const agentId = await seedAgent();
    const articleId = await seedArticle({
      workspaceId,
      createdBy: agentId,
      title: 'How refunds work',
    });

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(
        tx,
        { workspaceId, conversationId },
        {
          kind: 'answer',
          reply: 'try this',
          subintentId: null,
          articleId,
          searches: [
            { query: 'refund policy', results: [{ id: articleId, title: 'How refunds work' }] },
            { query: 'chargeback', results: [] },
          ],
        },
      ),
    );

    const events = await eventsFor(conversationId);
    // Searches come first: the timeline must read as what the bot looked for,
    // then what it did about it.
    expect(events.map((e) => e.type)).toEqual([
      'bot_search',
      'bot_search',
      'message_sent',
      'bot_article_offered',
    ]);
    expect(events[0].payload).toEqual({
      query: 'refund policy',
      result_count: 1,
      articles: [{ article_id: articleId, article_title: 'How refunds work' }],
    });
    expect(events[1].payload).toEqual({ query: 'chargeback', result_count: 0, articles: [] });
  });

  it('records a search on a handoff, so "searched and found nothing" is distinguishable from "never searched"', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(
        tx,
        { workspaceId, conversationId },
        {
          kind: 'handoff',
          reason: 'no_article',
          subintentId: null,
          searches: [{ query: 'item not received', results: [] }],
        },
      ),
    );

    const events = await eventsFor(conversationId);
    expect(events.map((e) => e.type)).toEqual([
      'bot_search',
      'message_sent',
      'bot_handoff',
      'message_sent',
    ]);
    expect(events[0].payload).toEqual({
      query: 'item not received',
      result_count: 0,
      articles: [],
    });
  });

  it('writes no bot_search when the decision carries none — an absent event means retrieval never ran', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(
        tx,
        { workspaceId, conversationId },
        { kind: 'handoff', reason: 'no_article', subintentId: null },
      ),
    );

    const events = await eventsFor(conversationId);
    expect(events.map((e) => e.type)).not.toContain('bot_search');
  });
});
