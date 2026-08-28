import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts';
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

// A standalone app carrying just this router, gated by the real middleware —
// the same pattern agent.conversations.test.ts uses.
const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, conversationsRouter);
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

async function setupAgent(workspaceId: string, displayName = 'Sam Rivera') {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, $2) returning id`,
    [`a-${Math.abs(displayName.length)}-${workspaceId.slice(0, 8)}@example.test`, displayName],
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  );
  const token = await signAgentSession({ agent_id: agentId });
  return { agentId, token };
}

describe('GET /agent/conversations/:id', () => {
  it('returns the header row for a conversation in this workspace', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId, 'player-77');
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body).toMatchObject({
      id: conversationId,
      number: 1,
      player: { id: playerId, external_player_id: 'player-77' },
      status: 'bot_active',
      subintent: null,
      assigned_agent: null,
      resolution_source: null,
      resolved_by_agent_name: null,
    });
    expect(typeof res.body.created_at).toBe('string');
  });

  it('names the intent and subintent when the conversation is classified', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const intentId = await seedIntent(workspaceId, 'Billing');
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Refund request' });
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set subintent_id = $1 where id = $2`, [
      subintentId,
      conversationId,
    ]);
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.subintent).toEqual({
      subintent_id: subintentId,
      intent_name: 'Billing',
      subintent_name: 'Refund request',
    });
  });

  it('names the resolving agent only when resolution_source is agent', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAgent(workspaceId, 'Sam Rivera');
    await ownerPool.query(
      `update conversation set assigned_agent_id = $1, status = 'resolved', resolution_source = 'agent' where id = $2`,
      [agentId, conversationId],
    );

    const res = await request(app)
      .get(`/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.assigned_agent).toEqual({ id: agentId, display_name: 'Sam Rivera' });
    expect(res.body.resolved_by_agent_name).toBe('Sam Rivera');
  });

  it('leaves resolved_by_agent_name null when the bot resolved it', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAgent(workspaceId, 'Sam Rivera');
    await ownerPool.query(
      `update conversation set assigned_agent_id = $1, status = 'resolved', resolution_source = 'bot' where id = $2`,
      [agentId, conversationId],
    );

    const res = await request(app)
      .get(`/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.resolution_source).toBe('bot');
    expect(res.body.resolved_by_agent_name).toBeNull();
  });

  it('returns 404 for a conversation in another workspace', async () => {
    const mine = await seedWorkspace();
    const theirs = await seedWorkspace();
    const theirPlayer = await seedPlayer(theirs);
    const theirConversation = await seedConversation({
      workspaceId: theirs,
      playerId: theirPlayer,
    });
    const { token } = await setupAgent(mine);

    await request(app)
      .get(`/conversations/${theirConversation}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', mine)
      .expect(404);
  });

  it('returns 422 for an id that is not a uuid', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAgent(workspaceId);
    await request(app)
      .get('/conversations/not-a-uuid')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(422);
  });
});
