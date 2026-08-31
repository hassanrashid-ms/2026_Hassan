import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { botConfigRouter } from '../src/agent/routers/botConfigRouter.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';
import type { TestBotTurnBodyValue } from '@support/types';

const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, botConfigRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);
beforeEach(() => {
  mockCallModel.mockReset();
  mockSearchArticleIds.mockReset();
  mockSearchArticleIds.mockResolvedValue([]);
});

async function seedAgentWithRole(
  workspaceId: string,
  role: 'agent' | 'team_lead' | 'admin',
): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name, is_admin) values ($1, 'Test Agent', $2) returning id`,
    [`${role}-${Math.random().toString(36).slice(2)}@example.test`, role === 'admin'],
  );
  const agentId = rows[0]!.id;
  if (role !== 'admin') {
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, $3)`,
      [workspaceId, agentId, role],
    );
  }
  const token = await signAgentSession({ agent_id: agentId, is_admin: role === 'admin' });
  return { agentId, token };
}

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

describe('POST /bot-config/test-turn', () => {
  it('refuses a plain agent with 403', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .post('/bot-config/test-turn')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send(baseBody())
      .expect(403);
  });

  it('returns 422 for a payload missing player_message', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const { player_message: _omit, ...invalid } = baseBody();

    await request(app)
      .post('/bot-config/test-turn')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send(invalid)
      .expect(422);
  });

  it('returns 200 with a decision for a valid payload', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'draft answer' });

    const res = await request(app)
      .post('/bot-config/test-turn')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send(baseBody())
      .expect(200);

    expect(res.body.decision).toMatchObject({ kind: 'answer', reply: 'draft answer' });
  });
});
