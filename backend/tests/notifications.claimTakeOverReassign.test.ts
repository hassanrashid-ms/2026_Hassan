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

describe('assignment notifications', () => {
  it('claim creates a notification for the claiming agent', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const { rows } = await ownerPool.query(
      `select agent_id, type, conversation_id, payload from notification where conversation_id = $1`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_id: agentId,
      type: 'ticket_assigned',
      conversation_id: conversationId,
      payload: { via: 'claim' },
    });
  });

  it('take-over creates a notification for the taking-over agent', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'bot_active',
    });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .post(`/conversations/${conversationId}/take-over`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const { rows } = await ownerPool.query(
      `select agent_id, payload from notification where conversation_id = $1`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_id: agentId, payload: { via: 'take_over' } });
  });

  it('reassign creates a notification for the target agent, not the reassigner', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const teamLead = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: teamLead, role: 'team_lead' });
    const teamLeadToken = await signAgentSession({ agent_id: teamLead });
    const targetAgentId = await seedAgent('target@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: targetAgentId, role: 'agent' });

    await request(app)
      .patch(`/conversations/${conversationId}/assign`)
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ agentId: targetAgentId })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select agent_id, payload from notification where conversation_id = $1`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_id: targetAgentId, payload: { via: 'reassign' } });
  });
});
