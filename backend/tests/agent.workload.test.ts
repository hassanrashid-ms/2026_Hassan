import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedResolutionCycle,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requireAgentSession, conversationsRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeDb();
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
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
  return { agentId, token };
}

describe('GET /agent/workload', () => {
  it('open count matches the agentAssigned filter predicate', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });

    // Matches: assigned + active status.
    await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      assignedAgentId: workerAgentId,
    });
    await seedConversation({
      workspaceId,
      playerId,
      status: 'escalated',
      assignedAgentId: workerAgentId,
    });
    // Excluded: unassigned.
    await seedConversation({ workspaceId, playerId, status: 'open' });
    // Excluded: assigned but resolved (not an active status).
    await seedConversation({
      workspaceId,
      playerId,
      status: 'resolved',
      assignedAgentId: workerAgentId,
    });

    const res = await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .expect(200);

    const row = res.body.agents.find((a: { agentId: string }) => a.agentId === workerAgentId);
    expect(row).toMatchObject({ openCount: 2, resolved7d: 0 });
  });

  it('excludes bot-resolved cycles with no agent ever assigned', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });

    const botConversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'resolved',
      assignedAgentId: null,
    });
    await seedResolutionCycle({
      workspaceId,
      conversationId: botConversationId,
      resolvedAt: new Date(),
      resolutionKind: 'bot',
    });

    const res = await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .expect(200);

    const row = res.body.agents.find((a: { agentId: string }) => a.agentId === workerAgentId);
    expect(row.resolved7d).toBe(0);
  });

  it('attributes a reassigned-mid-cycle resolution to the agent who held it at resolved_at', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const firstAgentId = await seedAgent('first@example.test');
    const secondAgentId = await seedAgent('second@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: firstAgentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId, agentId: secondAgentId, role: 'agent' });

    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'resolved',
      assignedAgentId: secondAgentId,
    });
    await seedResolutionCycle({
      workspaceId,
      conversationId,
      resolvedAt: new Date(),
      resolutionKind: 'agent',
    });

    const res = await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .expect(200);

    const firstRow = res.body.agents.find((a: { agentId: string }) => a.agentId === firstAgentId);
    const secondRow = res.body.agents.find(
      (a: { agentId: string }) => a.agentId === secondAgentId,
    );
    expect(firstRow.resolved7d).toBe(0);
    expect(secondRow.resolved7d).toBe(1);
  });

  it('zero-ticket active agents appear with 0/0', async () => {
    const workspaceId = await seedWorkspace();
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const idleAgentId = await seedAgent('idle@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: idleAgentId, role: 'agent' });

    const res = await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .expect(200);

    const row = res.body.agents.find((a: { agentId: string }) => a.agentId === idleAgentId);
    expect(row).toMatchObject({ openCount: 0, resolved7d: 0 });
  });

  it('excludes deactivated agents', async () => {
    const workspaceId = await seedWorkspace();
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const deactivatedAgentId = await seedAgent('gone@example.test');
    await seedWorkspaceMember({
      workspaceId,
      agentId: deactivatedAgentId,
      role: 'agent',
      deactivatedAt: new Date(),
    });

    const res = await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .expect(200);

    const row = res.body.agents.find(
      (a: { agentId: string }) => a.agentId === deactivatedAgentId,
    );
    expect(row).toBeUndefined();
  });

  it('excludes a cycle resolved 7 days and 1 second ago', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });

    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'resolved',
      assignedAgentId: workerAgentId,
    });
    const justOutside = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000 + 1000));
    await seedResolutionCycle({
      workspaceId,
      conversationId,
      resolvedAt: justOutside,
      resolutionKind: 'agent',
    });

    const res = await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .expect(200);

    const row = res.body.agents.find((a: { agentId: string }) => a.agentId === workerAgentId);
    expect(row.resolved7d).toBe(0);
  });

  it('refuses a plain agent with 403', async () => {
    const workspaceId = await seedWorkspace();
    const { token: agentToken } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(403);
  });
});
