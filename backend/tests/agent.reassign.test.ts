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
  seedAgent,
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

describe('PATCH /agent/conversations/:id/assign', () => {
  it('reassigns an open conversation (team_lead)', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const targetAgentId = await seedAgent('target@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: targetAgentId, role: 'agent' });

    const res = await request(app)
      .patch(`/conversations/${conversationId}/assign`)
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ agentId: targetAgentId })
      .expect(200);

    expect(res.body).toEqual({ reassigned: true });

    const { rows } = await ownerPool.query<{ assigned_agent_id: string }>(
      `select assigned_agent_id from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.assigned_agent_id).toBe(targetAgentId);
  });

  it('reassigns an open conversation (admin)', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const { token: adminToken } = await seedAgentWithRole(workspaceId, 'admin');
    const targetAgentId = await seedAgent('target@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: targetAgentId, role: 'agent' });

    const res = await request(app)
      .patch(`/conversations/${conversationId}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ agentId: targetAgentId })
      .expect(200);

    expect(res.body).toEqual({ reassigned: true });

    const { rows } = await ownerPool.query<{ assigned_agent_id: string }>(
      `select assigned_agent_id from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.assigned_agent_id).toBe(targetAgentId);
  });

  it('refuses a plain agent with 403', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const { token: agentToken } = await seedAgentWithRole(workspaceId, 'agent');
    const targetAgentId = await seedAgent('target@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: targetAgentId, role: 'agent' });

    await request(app)
      .patch(`/conversations/${conversationId}/assign`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ agentId: targetAgentId })
      .expect(403);
  });

  it('returns 409 invalid_status when conversation status is bot_active', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'bot_active' });
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const targetAgentId = await seedAgent('target@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: targetAgentId, role: 'agent' });

    const res = await request(app)
      .patch(`/conversations/${conversationId}/assign`)
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ agentId: targetAgentId })
      .expect(409);

    expect(res.body.error.code).toBe('invalid_status');
  });

  it('returns 404 agent_not_found when target agent has no workspace_member', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const targetAgentId = await seedAgent('target@example.test');

    const res = await request(app)
      .patch(`/conversations/${conversationId}/assign`)
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ agentId: targetAgentId })
      .expect(404);

    expect(res.body.error.code).toBe('agent_not_found');
  });

  it('returns 404 agent_not_found when target agent workspace_member is deactivated', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const targetAgentId = await seedAgent('target@example.test');
    await seedWorkspaceMember({
      workspaceId,
      agentId: targetAgentId,
      role: 'agent',
      deactivatedAt: new Date(),
    });

    const res = await request(app)
      .patch(`/conversations/${conversationId}/assign`)
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ agentId: targetAgentId })
      .expect(404);

    expect(res.body.error.code).toBe('agent_not_found');
  });

  it('returns 409 agent_not_active when target agent status is inactive', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const targetAgentId = await seedAgent('target@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: targetAgentId, role: 'agent' });
    await ownerPool.query(`update agent set status = 'on_leave' where id = $1`, [targetAgentId]);

    const res = await request(app)
      .patch(`/conversations/${conversationId}/assign`)
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ agentId: targetAgentId })
      .expect(409);

    expect(res.body.error.code).toBe('agent_not_active');
  });

  it('writes exactly one conversation_reassigned event with correct payload', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const { agentId: teamLeadId, token: teamLeadToken } = await seedAgentWithRole(
      workspaceId,
      'team_lead',
    );
    const targetAgentId = await seedAgent('target@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: targetAgentId, role: 'agent' });

    await request(app)
      .patch(`/conversations/${conversationId}/assign`)
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ agentId: targetAgentId })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select type, actor_id, payload from event where conversation_id = $1 and type = 'conversation_reassigned' order by id`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'conversation_reassigned',
      actor_id: teamLeadId,
      payload: { agent_id: targetAgentId, reassigned_by: teamLeadId, via: 'reassign' },
    });
  });

  it('posts an internal system message', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const targetAgentId = await seedAgent('target@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: targetAgentId, role: 'agent' });

    await request(app)
      .patch(`/conversations/${conversationId}/assign`)
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ agentId: targetAgentId })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select visibility, author_type from message where conversation_id = $1 order by seq`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      visibility: 'internal',
      author_type: 'system',
    });
  });
});
