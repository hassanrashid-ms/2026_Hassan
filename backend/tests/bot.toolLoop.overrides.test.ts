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
import { resolved } from '../src/domain/bot/botConfig.ts';
import { closeOwnerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

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

function baseInput(workspaceId: string, conversationId: string): BotTurnInput {
  return {
    workspaceId,
    conversationId,
    subintentId: null,
    confirmPhase: 'none',
    botMessageCount: 0,
    unhelpedReplyCount: 0,
    lastPlayerMessageAt: null,
    history: [],
  };
}

describe('toolLoopDecider with overrides', () => {
  it('answers from an overridden prompt that a persisted config could never produce, and never queries the message table', async () => {
    const workspaceId = await seedWorkspace();
    // A conversation id with no row anywhere — proves buildMessages never
    // reaches the DB for transcript or config when both are overridden.
    const conversationId = '00000000-0000-0000-0000-000000000000';

    mockCallModel.mockResolvedValueOnce({
      toolCalls: [],
      text: 'MARKER_FROM_OVERRIDDEN_PROMPT',
    });

    const config = resolved(
      true,
      'You always reply with exactly: MARKER_FROM_OVERRIDDEN_PROMPT',
      [],
      [],
      [
        { key: 'max_bot_messages', value: 8 },
        { key: 'max_tool_calls_per_turn', value: 6 },
        { key: 'max_articles_per_turn', value: 3 },
        { key: 'max_unhelped_replies', value: 3 },
      ],
    );

    const decision = await toolLoopDecider(baseInput(workspaceId, conversationId), {
      config,
      transcript: [{ role: 'user', body: 'hello' }],
    });

    expect(decision).toMatchObject({ kind: 'answer', reply: 'MARKER_FROM_OVERRIDDEN_PROMPT' });
  });

  it('falls back to the persisted config and DB transcript when overrides is omitted, unchanged from today', async () => {
    const workspaceId = await seedWorkspace();
    const conversationId = '00000000-0000-0000-0000-000000000001';

    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'default path reply' });

    const decision = await toolLoopDecider(baseInput(workspaceId, conversationId));

    expect(decision).toMatchObject({ kind: 'answer', reply: 'default path reply' });
  });
});
