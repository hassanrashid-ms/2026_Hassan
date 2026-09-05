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
import { runTestBotTurn } from '../src/domain/bot/botTestTurn.ts';
import type { TestBotTurnBodyValue } from '@support/types';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedForm,
  seedFormVersion,
  seedIntent,
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

function baseBody(overrides: Partial<TestBotTurnBodyValue> = {}): TestBotTurnBodyValue {
  return {
    config: {
      prompt: 'You are a test bot. {{subintents}} {{articles}}',
      rules: [],
      tools_config: [
        { tool: 'search_articles', enabled: true },
        { tool: 'classify', enabled: true },
        { tool: 'answer_from_article', enabled: true },
        { tool: 'confirm_resolution', enabled: true },
        { tool: 'player_declared_resolved', enabled: true },
      ],
      limits_config: [
        { key: 'max_bot_messages', value: 8 },
        { key: 'max_tool_calls_per_turn', value: 6 },
        { key: 'max_articles_per_turn', value: 3 },
        { key: 'max_unhelped_replies', value: 3 },
      ],
    },
    subintent_id: null,
    confirm_phase: 'none',
    history: [],
    player_message: 'Hello',
    ...overrides,
  };
}

describe('runTestBotTurn', () => {
  it('answers using the draft config, not any persisted row', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent(workspaceId);

    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'draft answer' });

    const decision = await runTestBotTurn({ agentId, workspaceId, isAdmin: true }, baseBody());

    expect(decision).toMatchObject({ kind: 'answer', reply: 'draft answer' });
  });

  it('writes no rows to conversation, message, or event', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent(workspaceId);

    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'draft answer' });

    await runTestBotTurn({ agentId, workspaceId, isAdmin: true }, baseBody());

    const counts = await ownerPool.query<{ table_name: string; n: string }>(
      `select 'conversation' as table_name, count(*)::text as n from conversation where workspace_id = $1
       union all
       select 'message', count(*)::text from message m join conversation c on c.id = m.conversation_id where c.workspace_id = $1
       union all
       select 'event', count(*)::text from event where workspace_id = $1`,
      [workspaceId],
    );
    for (const row of counts.rows) {
      expect(Number(row.n), `${row.table_name} should have 0 rows`).toBe(0);
    }
  });

  it('carries prior turns from history into the model transcript, oldest first', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent(workspaceId);

    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'ok' });

    await runTestBotTurn(
      { agentId, workspaceId, isAdmin: true },
      baseBody({
        history: [
          { author_type: 'player', body: 'first message' },
          { author_type: 'bot', body: 'first reply' },
        ],
        player_message: 'second message',
      }),
    );

    const [conversationMessages] = mockCallModel.mock.calls[0]!;
    const bodies = conversationMessages.map((m: { content: string }) => m.content);
    expect(bodies).toContain('first message');
    expect(bodies).toContain('first reply');
    expect(bodies).toContain('second message');
  });

  it('resolves and attaches a published form when the handoff subintent has one', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent(workspaceId);
    const intentId = await seedIntent(workspaceId);
    const formId = await seedForm({ workspaceId, name: 'Purchase receipt' });
    await seedFormVersion({
      workspaceId,
      formId,
      version: 1,
      fields: [
        {
          key: 'store',
          label: 'Store',
          type: 'choice',
          isRequired: true,
          position: 0,
          options: ['A', 'B'],
        },
      ],
      publishedAt: new Date(),
    });
    const subintentId = await seedSubintent({ workspaceId, intentId, formId });

    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 't1', name: 'handoff', arguments: '{"reason":"no_article"}' }],
      text: null,
    });

    const decision = await runTestBotTurn(
      { agentId, workspaceId, isAdmin: true },
      baseBody({ subintent_id: subintentId }),
    );

    expect(decision).toMatchObject({
      kind: 'handoff',
      reason: 'no_article',
      subintent_id: subintentId,
      form: { form_id: formId, form_name: 'Purchase receipt', version: 1 },
    });
  });

  it('returns form: null when the handoff subintent has no published form', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent(workspaceId);
    const intentId = await seedIntent(workspaceId);
    const subintentId = await seedSubintent({ workspaceId, intentId });

    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 't1', name: 'handoff', arguments: '{"reason":"no_article"}' }],
      text: null,
    });

    const decision = await runTestBotTurn(
      { agentId, workspaceId, isAdmin: true },
      baseBody({ subintent_id: subintentId }),
    );

    expect(decision).toMatchObject({ kind: 'handoff', form: null });
  });

  it('never attaches a form when the handoff reason is asked_for_person, even with a published form', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent(workspaceId);
    const intentId = await seedIntent(workspaceId);
    const formId = await seedForm({ workspaceId, name: 'Purchase receipt' });
    await seedFormVersion({
      workspaceId,
      formId,
      version: 1,
      fields: [
        {
          key: 'store',
          label: 'Store',
          type: 'choice',
          isRequired: true,
          position: 0,
          options: ['A', 'B'],
        },
      ],
      publishedAt: new Date(),
    });
    const subintentId = await seedSubintent({ workspaceId, intentId, formId });

    mockCallModel.mockResolvedValueOnce({
      toolCalls: [{ id: 't1', name: 'handoff', arguments: '{"reason":"asked_for_person"}' }],
      text: null,
    });

    const decision = await runTestBotTurn(
      { agentId, workspaceId, isAdmin: true },
      baseBody({ subintent_id: subintentId }),
    );

    expect(decision).toMatchObject({ kind: 'handoff', reason: 'asked_for_person', form: null });
  });
});
