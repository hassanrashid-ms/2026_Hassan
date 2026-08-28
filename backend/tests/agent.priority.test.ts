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
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

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

async function setupAgent(workspaceId: string): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ('agent1@example.test', 'Agent One') returning id`,
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  );
  const token = await signAgentSession({ agent_id: agentId });
  return { agentId, token };
}

describe('PATCH /agent/conversations/:id/priority', () => {
  it('sets priority and marks it manually set', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p3' });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .patch(`/conversations/${conversationId}/priority`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ priority: 'p1' })
      .expect(200);

    expect(res.body).toEqual({ updated: true });

    const { rows } = await ownerPool.query<{ priority: string; priority_manually_set: boolean }>(
      `select priority, priority_manually_set from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.priority).toBe('p1');
    expect(rows[0]!.priority_manually_set).toBe(true);
  });

  it('works on a resolved conversation (no status restriction)', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'resolved',
      priority: 'p3',
    });
    const { token } = await setupAgent(workspaceId);

    await request(app)
      .patch(`/conversations/${conversationId}/priority`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ priority: 'p2' })
      .expect(200);
  });

  it('returns 404 for a conversation that does not exist', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAgent(workspaceId);
    const nonExistentConversationId = '00000000-0000-0000-0000-000000000000';

    const res = await request(app)
      .patch(`/conversations/${nonExistentConversationId}/priority`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ priority: 'p1' })
      .expect(404);

    expect(res.body.error.code).toBe('not_found');
  });

  it('is a no-op when priority already equals the requested value', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p3' });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .patch(`/conversations/${conversationId}/priority`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ priority: 'p3' })
      .expect(200);

    expect(res.body).toEqual({ updated: false });

    const events = await ownerPool.query(
      `select id from event where conversation_id = $1 and type = 'conversation_priority_changed'`,
      [conversationId],
    );
    expect(events.rows).toHaveLength(0);
  });

  it('writes exactly one conversation_priority_changed event with correct payload', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p3' });
    const { agentId, token } = await setupAgent(workspaceId);

    await request(app)
      .patch(`/conversations/${conversationId}/priority`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ priority: 'p1' })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select type, actor_id, actor_type, payload from event where conversation_id = $1 and type = 'conversation_priority_changed'`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'conversation_priority_changed',
      actor_id: agentId,
      actor_type: 'agent',
      payload: { from: 'p3', to: 'p1', reason: 'manual' },
    });
  });

  it('writes exactly one change_log row with correct before/after', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p3' });
    const { token } = await setupAgent(workspaceId);

    await request(app)
      .patch(`/conversations/${conversationId}/priority`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ priority: 'p1' })
      .expect(200);

    const { rows } = await ownerPool.query<{
      field: string;
      before_value: string;
      after_value: string;
    }>(
      `select field, before_value, after_value from change_log where entity_id = $1 and entity_type = 'conversation' and field = 'priority'`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before_value).toBe('p3');
    expect(rows[0]!.after_value).toBe('p1');
  });

  it('rejects an invalid priority value with 422', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { token } = await setupAgent(workspaceId);

    await request(app)
      .patch(`/conversations/${conversationId}/priority`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ priority: 'urgent' })
      .expect(422);
  });
});
