// backend/tests/agent.sweepAssign.test.ts
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
import { incrementPresence, closePresenceRedis } from '../src/shared/realtime/presence.ts';
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
  await closePresenceRedis();
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});
beforeEach(truncateAll);

describe('POST /agent/conversations/sweep-assign', () => {
  it('403s for a plain agent', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const token = await signAgentSession({ agent_id: agentId });

    const res = await request(app)
      .post('/conversations/sweep-assign')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId);

    expect(res.status).toBe(403);
  });

  it('200s for a team lead and reports how many tickets it assigned', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const lead = await seedAgent();
    const worker = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: lead, role: 'team_lead' });
    await seedWorkspaceMember({ workspaceId, agentId: worker, role: 'agent' });
    await incrementPresence(worker);
    const token = await signAgentSession({ agent_id: lead });
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });

    const res = await request(app)
      .post('/conversations/sweep-assign')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      assignedCount: 1,
      conversationIds: [conversationId],
      remainingCount: 0,
      stopReason: 'queue_empty',
    });
  });

  it('200s with zero assigned when nobody is eligible', async () => {
    const workspaceId = await seedWorkspace();
    const lead = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: lead, role: 'team_lead' });
    const token = await signAgentSession({ agent_id: lead });

    const res = await request(app)
      .post('/conversations/sweep-assign')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      assignedCount: 0,
      conversationIds: [],
      remainingCount: 0,
      stopReason: 'queue_empty',
    });
  });
});
