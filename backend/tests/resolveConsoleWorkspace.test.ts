import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts';
import { messagesRouter } from '../src/agent/routers/messagesRouter.ts';
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
app.use(requireAgentSession, resolveConsoleWorkspace, conversationsRouter, messagesRouter);
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

async function claimableConversation(workspaceId: string): Promise<string> {
  const playerId = await seedPlayer(workspaceId);
  return seedConversation({ workspaceId, playerId, status: 'open' });
}

describe('resolveConsoleWorkspace — admin path (blanket access, no membership row)', () => {
  it('lets an admin claim a conversation in a workspace they hold no membership in, via X-Workspace-Id', async () => {
    const workspaceId = await seedWorkspace();
    const conversationId = await claimableConversation(workspaceId);
    const adminId = await seedAgent(undefined, { isAdmin: true });
    const token = await signAgentSession({ agent_id: adminId, is_admin: true });

    await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const { rows } = await ownerPool.query<{ assigned_agent_id: string | null }>(
      `select assigned_agent_id from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.assigned_agent_id).toBe(adminId);
  });

  it('404s an admin session with no X-Workspace-Id header', async () => {
    const adminId = await seedAgent(undefined, { isAdmin: true });
    const token = await signAgentSession({ agent_id: adminId, is_admin: true });

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('404s an admin session whose X-Workspace-Id names a workspace that does not exist', async () => {
    const adminId = await seedAgent(undefined, { isAdmin: true });
    const token = await signAgentSession({ agent_id: adminId, is_admin: true });

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', randomUUID())
      .expect(404);
  });
});

describe('resolveConsoleWorkspace — regular agent path (X-Workspace-Id + workspace_member check)', () => {
  it('200s and scopes to the header workspace when the agent has an active membership there', async () => {
    const workspaceId = await seedWorkspace();
    const conversationId = await claimableConversation(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
  });

  it('404s a regular agent session with no X-Workspace-Id header at all', async () => {
    const agentId = await seedAgent();
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('404s a regular agent naming a real workspace they are not a member of', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(404);
  });

  it('404s a regular agent whose membership has been deactivated', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent', deactivatedAt: new Date() });
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(404);
  });

  it('a second request for the same (agent, workspace) pair is served from cache without re-hitting Postgres', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    // Deactivate directly in the DB, bypassing the admin route (and therefore
    // its cache invalidation from Task 3) — proves this second call is served
    // from the still-warm 60s cache rather than re-checking Postgres.
    await ownerPool.query(
      `update workspace_member set deactivated_at = now() where workspace_id = $1 and agent_id = $2`,
      [workspaceId, agentId],
    );

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
  });
});
