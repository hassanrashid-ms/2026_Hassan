import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { notificationsRouter } from '../src/agent/routers/notificationsRouter.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { notifyAgent } from '../src/domain/notifications/notifyAgent.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requireAgentSession, notificationsRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('notifications routes', () => {
  it('GET /notifications returns notifications and unread_count', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await withWorkspace(workspaceId, (tx) =>
      notifyAgent(tx, { workspaceId, agentId, conversationId, via: 'claim' }),
    );
    const token = await signAgentSession({ agent_id: agentId });

    const res = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.unread_count).toBe(1);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].conversation_id).toBe(conversationId);
  });

  it('PATCH /notifications/:id/read marks it read', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const view = await withWorkspace(workspaceId, (tx) =>
      notifyAgent(tx, { workspaceId, agentId, conversationId, via: 'claim' }),
    );
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .patch(`/notifications/${view.id}/read`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const res = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.unread_count).toBe(0);
  });

  it("PATCH /notifications/:id/read returns 404 for another agent's notification", async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    const otherAgentId = await seedAgent('other@example.test');
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId, agentId: otherAgentId, role: 'agent' });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const view = await withWorkspace(workspaceId, (tx) =>
      notifyAgent(tx, { workspaceId, agentId, conversationId, via: 'claim' }),
    );
    const otherToken = await signAgentSession({ agent_id: otherAgentId });

    await request(app)
      .patch(`/notifications/${view.id}/read`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
  });

  it('PATCH /notifications/read-all clears unread_count', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const playerId = await seedPlayer(workspaceId);
    const convA = await seedConversation({ workspaceId, playerId });
    const convB = await seedConversation({ workspaceId, playerId });
    await withWorkspace(workspaceId, (tx) =>
      notifyAgent(tx, { workspaceId, agentId, conversationId: convA, via: 'claim' }),
    );
    await withWorkspace(workspaceId, (tx) =>
      notifyAgent(tx, { workspaceId, agentId, conversationId: convB, via: 'sweep' }),
    );
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .patch('/notifications/read-all')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const res = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.unread_count).toBe(0);
  });
});
