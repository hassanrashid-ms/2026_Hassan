import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCallModel, mockSearchArticleIds } = vi.hoisted(() => ({
  mockCallModel: vi.fn(),
  mockSearchArticleIds: vi.fn(),
}));

vi.mock('../src/domain/bot/openaiClient.ts', () => ({
  callModel: mockCallModel,
  ModelTimeoutError: class ModelTimeoutError extends Error {},
  ModelRefusalError: class ModelRefusalError extends Error {},
}));

vi.mock('../src/shared/weaviate/articlesIndex.ts', () => ({
  searchArticleIds: mockSearchArticleIds,
}));

import { closeDb } from '../src/shared/db/client.ts';
import type { BotTurnInput } from '../src/domain/bot/botTurn.ts';
import { toolLoopDecider } from '../src/domain/bot/toolLoop.ts';
import { ModelRefusalError, ModelTimeoutError } from '../src/domain/bot/openaiClient.ts';
import { LIMIT_CATALOG } from '../src/domain/bot/limitsCatalog.ts';

const byKey = new Map(LIMIT_CATALOG.map((l) => [l.key, l.defaultValue]));
const MAX_TOOL_CALLS_PER_TURN = byKey.get('max_tool_calls_per_turn')!;
const MAX_BOT_MESSAGES = byKey.get('max_bot_messages')!;
const MAX_ARTICLES_PER_TURN = byKey.get('max_articles_per_turn')!;
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

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);
beforeEach(() => {
  mockCallModel.mockReset();
  mockSearchArticleIds.mockReset();
  mockSearchArticleIds.mockResolvedValue([]);
});

function baseInput(
  overrides: Partial<BotTurnInput> & { workspaceId: string; conversationId: string },
): BotTurnInput {
  return {
    subintentId: null,
    confirmPhase: 'none',
    botMessageCount: 0,
    unhelpedReplyCount: 0,
    lastPlayerMessageAt: null,
    history: [],
    ...overrides,
  };
}

async function fixture() {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({ workspaceId, playerId });
  return { workspaceId, conversationId };
}

async function seedArticle(
  workspaceId: string,
  overrides: Partial<{ title: string; body: string; state: string; intentId: string | null }> = {},
) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'A') returning id`,
    [`a-${Math.random().toString(36).slice(2)}@example.test`],
  );
  const agentId = rows[0]!.id;
  const { rows: articleRows } = await ownerPool.query<{ id: string }>(
    `insert into article (workspace_id, intent_id, title, body, state, created_by, published_at)
     values ($1, $2, $3, $4, $5::article_state, $6, case when $5::text = 'published' then now() else null end) returning id`,
    [
      workspaceId,
      overrides.intentId ?? null,
      overrides.title ?? 'How to reset your password',
      overrides.body ?? 'Go to settings and tap reset.',
      overrides.state ?? 'published',
      agentId,
    ],
  );
  return articleRows[0]!.id;
}

describe('toolLoopDecider', () => {
  it('a greeting with no tool call produces one bot message, no classification, no event', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'Hi! How can I help?' });
    const input = baseInput({ workspaceId, conversationId });
    const decision = await toolLoopDecider(input);
    expect(decision).toEqual({ kind: 'answer', reply: 'Hi! How can I help?', subintentId: null });
  });

  /**
   * The model's own words reach the player, not a canned pointer. This used to
   * return a fixed "Here's an article that might help." while the article
   * itself had no delivery mechanism at all — the player was promised something
   * and shown nothing, then asked whether it had helped.
   */
  it('search_articles then answer_from_article delivers the model answer with articleId and would set bot_article', async () => {
    const { workspaceId, conversationId } = await fixture();
    const articleId = await seedArticle(workspaceId, {
      title: 'Refund policy',
      body: 'Refunds are issued to the original payment method within 14 days of the purchase.',
    });
    mockSearchArticleIds.mockResolvedValueOnce([articleId]);

    const answer =
      'Refunds are issued to the original payment method within 14 days of the purchase.';
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 't1', name: 'search_articles', arguments: '{"query":"refund"}' }],
      text: null,
    });
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [
        {
          id: 't2',
          name: 'answer_from_article',
          arguments: JSON.stringify({ article_id: articleId, answer }),
        },
      ],
      text: null,
    });

    const input = baseInput({ workspaceId, conversationId });
    const decision = await toolLoopDecider(input);
    expect(decision).toEqual({
      kind: 'answer',
      reply: answer,
      subintentId: null,
      articleId,
      grounding: { score: 1, ungrounded: [] },
      // The turn's retrieval record rides on the decision so applyBotTurn can
      // write it in the same transaction as the outcome it explains.
      searches: [{ query: 'refund', results: [{ id: articleId, title: 'Refund policy' }] }],
    });
  });

  it('answer_from_article with an id not returned by search_articles this turn is rejected and the loop continues', async () => {
    const { workspaceId, conversationId } = await fixture();

    mockCallModel.mockResolvedValueOnce({
      toolCalls: [
        {
          id: 't1',
          name: 'answer_from_article',
          arguments: '{"article_id":"never-searched","answer":"Tap reset."}',
        },
      ],
      text: null,
    });
    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'ok, anything else?' });

    const input = baseInput({ workspaceId, conversationId });
    const decision = await toolLoopDecider(input);
    expect(decision).toEqual({ kind: 'answer', reply: 'ok, anything else?', subintentId: null });
    expect(mockCallModel).toHaveBeenCalledTimes(2);
  });

  it('classify twice in one turn resolves once; the second call is ignored', async () => {
    const { workspaceId, conversationId } = await fixture();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const subintentIdA = await seedSubintent({ workspaceId, intentId, name: 'A Refund' });
    await seedSubintent({ workspaceId, intentId, name: 'B Missing item' });

    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 't1', name: 'classify', arguments: '{"subintent_index":0}' }],
      text: null,
    });
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 't2', name: 'classify', arguments: '{"subintent_index":1}' }],
      text: null,
    });
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 't3', name: 'handoff', arguments: '{"reason":"asked_for_person"}' }],
      text: null,
    });

    const input = baseInput({ workspaceId, conversationId });
    const decision = await toolLoopDecider(input);
    expect(decision).toEqual({
      kind: 'handoff',
      reason: 'asked_for_person',
      subintentId: subintentIdA,
    });
  });

  it('handoff from a turn where classify was never called leaves subintentId null', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 't1', name: 'handoff', arguments: '{"reason":"asked_for_person"}' }],
      text: null,
    });
    const input = baseInput({ workspaceId, conversationId });
    const decision = await toolLoopDecider(input);
    expect(decision).toEqual({ kind: 'handoff', reason: 'asked_for_person', subintentId: null });
  });

  it('confirm_resolution is absent from the tool set when confirm_phase is none, present when bot_article', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'ok' });
    const input = baseInput({ workspaceId, conversationId, confirmPhase: 'none' });
    await toolLoopDecider(input);
    const toolNames = mockCallModel.mock.calls[0]![1].map((t: any) => t.function.name);
    expect(toolNames).not.toContain('confirm_resolution');

    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'ok' });
    const input2 = baseInput({ workspaceId, conversationId, confirmPhase: 'bot_article' });
    await toolLoopDecider(input2);
    const toolNames2 = mockCallModel.mock.calls[1]![1].map((t: any) => t.function.name);
    expect(toolNames2).toContain('confirm_resolution');
  });

  it('a model that calls search_articles forever stops at the tool-call budget and returns handoff(unsure)', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel.mockResolvedValue({
      toolCalls: [{ id: 't', name: 'search_articles', arguments: '{"query":"x"}' }],
      text: null,
    });
    const input = baseInput({ workspaceId, conversationId });
    const decision = await toolLoopDecider(input);
    // Only MAX_ARTICLES_PER_TURN searches actually run: that caps the searches,
    // while MAX_TOOL_CALLS_PER_TURN caps the calls that count — the calls past
    // the search cap are still spent, they just do no retrieval. A
    // budget-forced handoff still carries what it managed to search for.
    expect(decision).toEqual({
      kind: 'handoff',
      reason: 'unsure',
      subintentId: null,
      searches: Array.from({ length: MAX_ARTICLES_PER_TURN }, () => ({ query: 'x', results: [] })),
    });
    expect(mockCallModel).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_TURN);
  });

  /**
   * The budget must not be the thing that ends an ordinary turn. `classify` →
   * `search_articles` → `answer_from_article` is the happy path, and it has to survive
   * a model that spends a call or two imperfectly on the way — at four, a second
   * classify or a second search was enough to force handoff('unsure') on a
   * question an article answered.
   */
  it('leaves room for the classify → search → answer path even after two wasted calls', async () => {
    const { workspaceId, conversationId } = await fixture();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'A Refund' });
    const articleId = await seedArticle(workspaceId, {
      title: 'Refund policy',
      body: 'Refunds reach the original payment method.',
    });
    mockSearchArticleIds.mockResolvedValue([articleId]);

    // Two calls burned on a repeated classify, then the real work.
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 'c1', name: 'classify', arguments: '{"subintent_index":0}' }],
      text: null,
    });
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 'c2', name: 'classify', arguments: '{"subintent_index":0}' }],
      text: null,
    });
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 's1', name: 'search_articles', arguments: '{"query":"refund"}' }],
      text: null,
    });
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 's2', name: 'search_articles', arguments: '{"query":"refund again"}' }],
      text: null,
    });
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [
        {
          id: 'o1',
          name: 'answer_from_article',
          arguments: JSON.stringify({
            article_id: articleId,
            answer: 'Refunds reach the original payment method.',
          }),
        },
      ],
      text: null,
    });

    const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId }));
    expect(decision.kind).toBe('answer');
    expect(decision).toMatchObject({ articleId, subintentId });
  });

  it('with 8 bot messages present, callModel is never called and the result is handoff(turn_cap)', async () => {
    const { workspaceId, conversationId } = await fixture();
    const decision = await toolLoopDecider(
      baseInput({ workspaceId, conversationId, botMessageCount: MAX_BOT_MESSAGES }),
    );
    expect(decision).toEqual({ kind: 'handoff', reason: 'turn_cap', subintentId: null });
    expect(mockCallModel).not.toHaveBeenCalled();
  });

  it('a refusal produces invalid_response and is not retried (throws once, caller does not catch-and-retry internally)', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel.mockRejectedValueOnce(new ModelRefusalError('nope'));
    const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId }));
    expect(decision).toEqual({ kind: 'unavailable', reason: 'invalid_response' });
    expect(mockCallModel).toHaveBeenCalledTimes(1);
  });

  /**
   * Regression: the empty-bubble bug. `reply: response.text ?? ''` posted a
   * zero-length `bot` message whenever the model returned neither a tool call
   * nor any text — the player saw a blank bubble, and nothing in the events
   * recorded a failure, because as far as the system was concerned the bot had
   * answered. Observed live on a player who said "hi".
   */
  it.each([
    ['null text', null],
    ['empty string', ''],
    ['whitespace only', '   \n  '],
  ])(
    'no tool call and %s produces invalid_response, never an empty answer',
    async (_label, text) => {
      const { workspaceId, conversationId } = await fixture();
      mockCallModel.mockResolvedValueOnce({ toolCalls: [], text });
      const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId }));
      expect(decision).toEqual({ kind: 'unavailable', reason: 'invalid_response' });
    },
  );

  /**
   * Regression: the model sometimes writes a tool call's payload as plain
   * content instead of actually invoking the tool (no toolCalls array), and
   * that raw JSON was posted straight to the player as if it were prose.
   */
  it('no tool call and a JSON-object reply produces invalid_response, never the raw JSON as an answer', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [],
      text: '{"article_id":"a1","answer":"Here is how to fix it."}',
    });
    const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId }));
    expect(decision).toEqual({ kind: 'unavailable', reason: 'invalid_response' });
  });

  it('trims a reply that has content, and keeps it', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: '  What do you need help with?  ' });
    const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId }));
    expect(decision).toEqual({
      kind: 'answer',
      reply: 'What do you need help with?',
      subintentId: null,
    });
  });

  /**
   * The prompt asks for the article's own wording; these assert the seam that
   * makes it true when the prompt is not obeyed. Precedent for not trusting the
   * prompt alone: the handoff instruction asked the model to *say* it was
   * transferring and it wrote the sentence instead of calling the tool.
   */
  describe('grounding the answer in the cited article', () => {
    const ARTICLE_BODY =
      'If a purchase did not arrive, restart the game and open the shop. Your items are restored automatically. Contact support if they are still missing after the restart.';

    async function answering(answer: string, overrides: { body?: string } = {}) {
      const { workspaceId, conversationId } = await fixture();
      const articleId = await seedArticle(workspaceId, {
        title: 'Missing purchase',
        body: overrides.body ?? ARTICLE_BODY,
      });
      mockSearchArticleIds.mockResolvedValue([articleId]);
      mockCallModel.mockResolvedValueOnce({
        toolCalls: [
          { id: 's1', name: 'search_articles', arguments: '{"query":"missing purchase"}' },
        ],
        text: null,
      });
      mockCallModel.mockResolvedValueOnce({
        toolCalls: [
          {
            id: 'a1',
            name: 'answer_from_article',
            arguments: JSON.stringify({ article_id: articleId, answer }),
          },
        ],
        text: null,
      });
      return { workspaceId, conversationId, articleId };
    }

    it("passes an answer rebuilt from the article's own sentences", async () => {
      const answer = 'Restart the game and open the shop — your items are restored automatically.';
      const { workspaceId, conversationId, articleId } = await answering(answer);
      const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId }));
      expect(decision).toMatchObject({ kind: 'answer', reply: answer, articleId });
    });

    /**
     * The damaging case, and the reason a prompt is not enough: a timeframe the
     * article never states reads exactly like one it does, and the player plans
     * around it.
     */
    it('refuses an answer that invents a fact the article does not contain, and asks for a rewrite', async () => {
      const { workspaceId, conversationId } = await answering(
        'Restart the game and open the shop. Our billing team will wire your compensation within 48 hours.',
      );
      mockCallModel.mockResolvedValueOnce({
        toolCalls: [{ id: 'h1', name: 'handoff', arguments: '{"reason":"no_article"}' }],
        text: null,
      });

      const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId }));
      expect(decision).toMatchObject({ kind: 'handoff', reason: 'no_article' });

      // The rejection has to name the offending words: the model has already
      // read the rule and produced this anyway, so restating it teaches nothing.
      const rejection = mockCallModel.mock.calls[2]![0].at(-1);
      expect(rejection.content).toContain('rejected');
      expect(rejection.content).toMatch(/compensation|billing|48/);
      expect(rejection.content).toContain("article's own wording");
    });

    it("allows the answer to speak the player's own words back to them", async () => {
      // "treasure quest" is nowhere in the article — it is the player's name for
      // their problem, and refusing it would forbid addressing them by their
      // own situation, which is the whole point of rewriting per player.
      const { workspaceId, conversationId } = await fixture();
      const articleId = await seedArticle(workspaceId, {
        title: 'Missing purchase',
        body: ARTICLE_BODY,
      });
      mockSearchArticleIds.mockResolvedValue([articleId]);
      await ownerPool.query(
        `insert into message (workspace_id, conversation_id, seq, author_type, body, visibility)
         values ($1, $2, 1, 'player', $3, 'public')`,
        [workspaceId, conversationId, 'i ordered treasure quest but didnt receive it'],
      );
      const answer =
        'For your treasure quest order, restart the game and open the shop — items are restored automatically.';
      mockCallModel.mockResolvedValueOnce({
        toolCalls: [
          { id: 's1', name: 'search_articles', arguments: '{"query":"missing purchase"}' },
        ],
        text: null,
      });
      mockCallModel.mockResolvedValueOnce({
        toolCalls: [
          {
            id: 'a1',
            name: 'answer_from_article',
            arguments: JSON.stringify({ article_id: articleId, answer }),
          },
        ],
        text: null,
      });

      const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId }));
      expect(decision).toMatchObject({ kind: 'answer', reply: answer, articleId });
    });

    it.each([
      ['empty', ''],
      ['whitespace only', '   \n '],
    ])('an %s answer is invalid_response, never a blank bubble', async (_label, answer) => {
      const { workspaceId, conversationId } = await answering(answer);
      const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId }));
      expect(decision).toMatchObject({ kind: 'unavailable', reason: 'invalid_response' });
    });

    it('a missing answer argument is invalid_response', async () => {
      const { workspaceId, conversationId } = await fixture();
      const articleId = await seedArticle(workspaceId, {
        title: 'Missing purchase',
        body: ARTICLE_BODY,
      });
      mockSearchArticleIds.mockResolvedValue([articleId]);
      mockCallModel.mockResolvedValueOnce({
        toolCalls: [{ id: 's1', name: 'search_articles', arguments: '{"query":"x"}' }],
        text: null,
      });
      mockCallModel.mockResolvedValueOnce({
        toolCalls: [
          {
            id: 'a1',
            name: 'answer_from_article',
            arguments: JSON.stringify({ article_id: articleId }),
          },
        ],
        text: null,
      });
      const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId }));
      expect(decision).toMatchObject({ kind: 'unavailable', reason: 'invalid_response' });
    });

    /**
     * Provenance, not just plausibility: an answer written from article B while
     * citing article A would make `bot_article_offered` a lie, and every metric
     * built on it wrong.
     */
    it('scores against the cited article only, not everything the turn retrieved', async () => {
      const { workspaceId, conversationId } = await fixture();
      const cited = await seedArticle(workspaceId, {
        title: 'Missing purchase',
        body: ARTICLE_BODY,
      });
      const other = await seedArticle(workspaceId, {
        title: 'Season pass',
        body: 'The season pass grants a cosmetic aura, doubled quest rewards and a weekly banner slot.',
      });
      mockSearchArticleIds.mockResolvedValue([cited, other]);
      mockCallModel.mockResolvedValueOnce({
        toolCalls: [{ id: 's1', name: 'search_articles', arguments: '{"query":"x"}' }],
        text: null,
      });
      mockCallModel.mockResolvedValueOnce({
        toolCalls: [
          {
            id: 'a1',
            name: 'answer_from_article',
            // Every content word is grounded — in the wrong article.
            arguments: JSON.stringify({
              article_id: cited,
              answer:
                'The season pass grants a cosmetic aura, doubled quest rewards and a weekly banner slot.',
            }),
          },
        ],
        text: null,
      });
      mockCallModel.mockResolvedValueOnce({
        toolCalls: [{ id: 'h1', name: 'handoff', arguments: '{"reason":"no_article"}' }],
        text: null,
      });

      const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId }));
      expect(decision).toMatchObject({ kind: 'handoff', reason: 'no_article' });
    });
  });

  it('an unparseable tool argument produces invalid_response', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 't', name: 'classify', arguments: '{not json' }],
      text: null,
    });
    const decision = await toolLoopDecider(baseInput({ workspaceId, conversationId }));
    expect(decision).toEqual({ kind: 'unavailable', reason: 'invalid_response' });
  });

  it('a network error throws rather than returning unavailable', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(toolLoopDecider(baseInput({ workspaceId, conversationId }))).rejects.toThrow(
      'ECONNRESET',
    );
  });

  it('a timeout throws rather than returning unavailable', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel.mockRejectedValueOnce(new ModelTimeoutError());
    await expect(toolLoopDecider(baseInput({ workspaceId, conversationId }))).rejects.toThrow(
      ModelTimeoutError,
    );
  });

  it('confirm_resolution(true) exits resolve', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 't', name: 'confirm_resolution', arguments: '{"helped":true}' }],
      text: null,
    });
    const decision = await toolLoopDecider(
      baseInput({ workspaceId, conversationId, confirmPhase: 'bot_article' }),
    );
    expect(decision).toEqual({ kind: 'resolve', subintentId: null });
  });

  it('confirm_resolution(false) exits handoff(article_rejected)', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 't', name: 'confirm_resolution', arguments: '{"helped":false}' }],
      text: null,
    });
    const decision = await toolLoopDecider(
      baseInput({ workspaceId, conversationId, confirmPhase: 'bot_article' }),
    );
    expect(decision).toEqual({ kind: 'handoff', reason: 'article_rejected', subintentId: null });
  });
});

function playerMessage(body: string): BotTurnInput['history'][number] {
  return {
    id: 'm1',
    seq: 1,
    author_type: 'player',
    body,
    delivery_state: 'delivered',
    read_at: null,
    created_at: new Date().toISOString(),
    article_id: null,
    attachment: null,
    form_field_key: null,
  };
}

describe('player_declared_resolved', () => {
  it('a quoted_text that is a verbatim substring of the latest player message exits confirm_player_resolution', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [
        {
          id: 't',
          name: 'player_declared_resolved',
          arguments: '{"quoted_text":"that fixed it, please close this ticket"}',
        },
      ],
      text: null,
    });
    const decision = await toolLoopDecider(
      baseInput({
        workspaceId,
        conversationId,
        confirmPhase: 'none',
        history: [playerMessage('Thanks, that fixed it, please close this ticket!')],
      }),
    );
    expect(decision).toEqual({
      kind: 'confirm_player_resolution',
      subintentId: null,
      quotedText: 'that fixed it, please close this ticket',
    });
  });

  it('is case-insensitive but still requires the quote to actually appear in what the player wrote', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [
        { id: 't', name: 'player_declared_resolved', arguments: '{"quoted_text":"CLOSE THIS"}' },
      ],
      text: null,
    });
    const decision = await toolLoopDecider(
      baseInput({
        workspaceId,
        conversationId,
        confirmPhase: 'none',
        history: [playerMessage('please close this now')],
      }),
    );
    expect(decision).toEqual({
      kind: 'confirm_player_resolution',
      subintentId: null,
      quotedText: 'CLOSE THIS',
    });
  });

  /**
   * The server-enforced half of the guard. A model that hallucinates or
   * paraphrases what the player said, rather than quoting it verbatim, must
   * not be able to move confirm_phase — this is what makes the guard more
   * than a prompt request. The rejected call costs one loop iteration; the
   * model is told why and given the chance to answer normally instead.
   */
  it('rejects a quoted_text not actually present in the player\'s latest message, and continues the turn', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel
      .mockResolvedValueOnce({
        toolCalls: [
          {
            id: 't1',
            name: 'player_declared_resolved',
            arguments: '{"quoted_text":"this is totally resolved"}',
          },
        ],
        text: null,
      })
      .mockResolvedValueOnce({ toolCalls: [], text: 'Sure, happy to help with anything else!' });

    const decision = await toolLoopDecider(
      baseInput({
        workspaceId,
        conversationId,
        confirmPhase: 'none',
        history: [playerMessage('ok thanks, thats good to know')],
      }),
    );
    expect(decision).toEqual({
      kind: 'answer',
      reply: 'Sure, happy to help with anything else!',
      subintentId: null,
    });
    expect(mockCallModel).toHaveBeenCalledTimes(2);
  });

  it('rejects when there is no player message in history at all', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel
      .mockResolvedValueOnce({
        toolCalls: [
          { id: 't1', name: 'player_declared_resolved', arguments: '{"quoted_text":"resolved"}' },
        ],
        text: null,
      })
      .mockResolvedValueOnce({ toolCalls: [], text: 'How can I help?' });

    const decision = await toolLoopDecider(
      baseInput({ workspaceId, conversationId, confirmPhase: 'none', history: [] }),
    );
    expect(decision).toEqual({ kind: 'answer', reply: 'How can I help?', subintentId: null });
  });

  it('throws InvalidResponseError-style unavailable on a missing quoted_text argument', async () => {
    const { workspaceId, conversationId } = await fixture();
    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 't', name: 'player_declared_resolved', arguments: '{}' }],
      text: null,
    });
    const decision = await toolLoopDecider(
      baseInput({
        workspaceId,
        conversationId,
        confirmPhase: 'none',
        history: [playerMessage('this is resolved')],
      }),
    );
    expect(decision).toEqual({ kind: 'unavailable', reason: 'invalid_response' });
  });
});
