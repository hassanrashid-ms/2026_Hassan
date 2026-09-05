// backend/tests/agent.unassign.test.ts
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
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

async function conversationRow(id: string) {
  const { rows } = await ownerPool.query(
    `select assigned_agent_id from conversation where id = $1`,
    [id],
  );
  return rows[0];
}
async function eventsFor(id: string) {
  const { rows } = await ownerPool.query(
    `select type, payload from event where conversation_id = $1 order by id`,
    [id],
  );
  return rows;
}

describe('POST /agent/conversations/:id/unassign', () => {
  it("releases the caller's own ticket back to the unassigned queue", async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    const token = await signAgentSession({ agent_id: agentId });
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      assignedAgentId: agentId,
    });

    const res = await request(app)
      .post(`/conversations/${conversationId}/unassign`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unassigned: true });
    const row = await conversationRow(conversationId);
    expect(row.assigned_agent_id).toBeNull();

    const events = await eventsFor(conversationId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('conversation_unassigned');
    expect(events[0].payload).toMatchObject({ previous_agent_id: agentId });
  });

  it('403s when the caller does not own the ticket', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const owner = await seedAgent();
    const caller = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: owner });
    await seedWorkspaceMember({ workspaceId, agentId: caller });
    const token = await signAgentSession({ agent_id: caller });
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      assignedAgentId: owner,
    });

    const res = await request(app)
      .post(`/conversations/${conversationId}/unassign`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId);

    expect(res.status).toBe(403);
    const row = await conversationRow(conversationId);
    expect(row.assigned_agent_id).toBe(owner);
  });

  it('403s on an already-unassigned ticket — the caller cannot own null', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    const token = await signAgentSession({ agent_id: agentId });
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });

    const res = await request(app)
      .post(`/conversations/${conversationId}/unassign`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId);

    expect(res.status).toBe(403);
  });

  it('409s on a resolved ticket even if still assigned to the caller', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    const token = await signAgentSession({ agent_id: agentId });
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'resolved',
      assignedAgentId: agentId,
    });

    const res = await request(app)
      .post(`/conversations/${conversationId}/unassign`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId);

    expect(res.status).toBe(409);
    const row = await conversationRow(conversationId);
    expect(row.assigned_agent_id).toBe(agentId);
  });

  it('404s on a nonexistent conversation', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    const token = await signAgentSession({ agent_id: agentId });

    const res = await request(app)
      .post(`/conversations/00000000-0000-0000-0000-000000000000/unassign`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId);

    expect(res.status).toBe(404);
  });
});
