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
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
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

async function setupAdmin() {
  const agentId = await seedAgent(undefined, { isAdmin: true });
  const token = await signAgentSession({ agent_id: agentId, is_admin: true });
  return { agentId, token };
}

async function setupAgent(workspaceId: string) {
  const agentId = await seedAgent();
  await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
  const token = await signAgentSession({ agent_id: agentId, is_admin: false });
  return { agentId, token };
}

async function conversationRow(id: string) {
  const { rows } = await ownerPool.query(
    `select status, confirm_phase, resolution_source, assigned_agent_id from conversation where id = $1`,
    [id],
  );
  return rows[0];
}
async function eventsFor(id: string) {
  const { rows } = await ownerPool.query(
    `select type, actor_type, payload from event where conversation_id = $1 order by id`,
    [id],
  );
  return rows;
}
async function messagesFor(id: string) {
  const { rows } = await ownerPool.query(`select id from message where conversation_id = $1`, [
    id,
  ]);
  return rows;
}

describe('POST /agent/conversations/:id/force-resolve', () => {
  it('resolves a bot_active conversation with no player confirmation, as admin', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await setupAdmin();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'bot_active',
    });

    const res = await request(app)
      .post(`/conversations/${conversationId}/force-resolve`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resolved: true });
    const row = await conversationRow(conversationId);
    expect(row.status).toBe('resolved');
    expect(row.confirm_phase).toBe('none');
    expect(row.resolution_source).toBe('admin_forced');
    expect(row.assigned_agent_id).toBe(agentId);
    expect(await messagesFor(conversationId)).toEqual([]);
    const events = await eventsFor(conversationId);
    expect(events).toEqual([
      {
        type: 'conversation_resolved_forced',
        actor_type: 'agent',
        payload: { admin_agent_id: agentId },
      },
    ]);
  });

  it('resolves and clears a pending confirmPhase (e.g. escalated mid agent_ask)', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAdmin();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'escalated',
      confirmPhase: 'agent_ask',
    });

    const res = await request(app)
      .post(`/conversations/${conversationId}/force-resolve`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId);

    expect(res.status).toBe(200);
    const row = await conversationRow(conversationId);
    expect(row.status).toBe('resolved');
    expect(row.confirm_phase).toBe('none');
  });

  it('rejects with 403 when the caller is not an admin', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });

    const res = await request(app)
      .post(`/conversations/${conversationId}/force-resolve`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId);

    expect(res.status).toBe(403);
    expect((await conversationRow(conversationId)).status).toBe('open');
    expect((await eventsFor(conversationId)).length).toBe(0);
  });

  it('rejects when already resolved', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAdmin();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'resolved' });

    const res = await request(app)
      .post(`/conversations/${conversationId}/force-resolve`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('wrong_status');
  });

  it('rejects when already closed', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAdmin();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'closed' });

    const res = await request(app)
      .post(`/conversations/${conversationId}/force-resolve`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('wrong_status');
  });

  it('404s on a conversation in another workspace', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAdmin();
    const otherWorkspaceId = await seedWorkspace();
    const otherPlayerId = await seedPlayer(otherWorkspaceId);
    const foreignId = await seedConversation({
      workspaceId: otherWorkspaceId,
      playerId: otherPlayerId,
      status: 'open',
    });

    const res = await request(app)
      .post(`/conversations/${foreignId}/force-resolve`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId);
    expect(res.status).toBe(404);
  });

  it('422s on a non-uuid id', async () => {
    const { token } = await setupAdmin();
    const workspaceId = await seedWorkspace();
    const res = await request(app)
      .post('/conversations/not-a-uuid/force-resolve')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId);
    expect(res.status).toBe(422);
  });
});
