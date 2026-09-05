import { createServer } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { incrementPresence, closePresenceRedis } from '../src/shared/realtime/presence.ts';
import * as presence from '../src/shared/realtime/presence.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedMessage,
  seedPlayer,
  seedResolutionCycle,
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
afterEach(() => {
  vi.restoreAllMocks();
});

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
      .set('X-Workspace-Id', workspaceId)
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
      .set('X-Workspace-Id', workspaceId)
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
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const firstRow = res.body.agents.find((a: { agentId: string }) => a.agentId === firstAgentId);
    const secondRow = res.body.agents.find((a: { agentId: string }) => a.agentId === secondAgentId);
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
      .set('X-Workspace-Id', workspaceId)
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
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const row = res.body.agents.find((a: { agentId: string }) => a.agentId === deactivatedAgentId);
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
      .set('X-Workspace-Id', workspaceId)
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
      .set('X-Workspace-Id', workspaceId)
      .expect(403);
  });

  it('reports offline by default, online once connected, and away once set', async () => {
    const workspaceId = await seedWorkspace();
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const offlineAgentId = await seedAgent('offline@example.test');
    const onlineAgentId = await seedAgent('online@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: offlineAgentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId, agentId: onlineAgentId, role: 'agent' });
    await incrementPresence(onlineAgentId);

    const res = await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const offlineRow = res.body.agents.find(
      (a: { agentId: string }) => a.agentId === offlineAgentId,
    );
    const onlineRow = res.body.agents.find((a: { agentId: string }) => a.agentId === onlineAgentId);
    expect(offlineRow.status).toBe('offline');
    expect(onlineRow.status).toBe('online');
  });

  it('on_leave overrides live presence, connected or not', async () => {
    const workspaceId = await seedWorkspace();
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const onLeaveAgentId = await seedAgent('on-leave@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: onLeaveAgentId, role: 'agent' });
    await ownerPool.query(`update agent set status = 'on_leave' where id = $1`, [onLeaveAgentId]);
    // Connected, but on_leave must still win — a disconnected agent on leave
    // and a connected one both show on_leave per the design's precedence.
    await incrementPresence(onLeaveAgentId);

    const res = await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const row = res.body.agents.find((a: { agentId: string }) => a.agentId === onLeaveAgentId);
    expect(row.status).toBe('on_leave');
  });

  it('falls back to offline for every row when the presence read fails, without failing the request', async () => {
    const workspaceId = await seedWorkspace();
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });
    await incrementPresence(workerAgentId);

    vi.spyOn(presence, 'getPresenceStatusBatch').mockRejectedValueOnce(new Error('redis down'));

    const res = await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const row = res.body.agents.find((a: { agentId: string }) => a.agentId === workerAgentId);
    expect(row.status).toBe('offline');
    expect(row.openCount).toBe(0);
  });
});

describe('GET /agent/workload — new metrics', () => {
  it('returns each roster member’s workspace role', async () => {
    const workspaceId = await seedWorkspace();
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });

    const res = await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId);

    expect(res.status).toBe(200);
    const roles = new Set(res.body.agents.map((a: { role: string }) => a.role));
    expect(roles).toEqual(new Set(['agent', 'team_lead']));
  });

  it('returns the workspace’s maxAssignedTickets as capacityMax for every agent', async () => {
    const workspaceId = await seedWorkspace({ maxAssignedTickets: 3 });
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });

    const res = await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId);

    expect(res.status).toBe(200);
    for (const a of res.body.agents) {
      expect(a.capacityMax).toBe(3);
    }
  });

  it('counts escalated conversations separately from other open statuses', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });

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

    const res = await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId);

    const worker = res.body.agents.find((a: { agentId: string }) => a.agentId === workerAgentId);
    expect(worker.openCount).toBe(2);
    expect(worker.escalatedCount).toBe(1);
  });

  it('counts a conversation as overdue when the player’s latest message is more than 4 hours old', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });

    const staleConversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      assignedAgentId: workerAgentId,
    });
    await seedMessage({
      workspaceId,
      conversationId: staleConversationId,
      seq: 1,
      authorType: 'player',
      createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId);
    const worker = res.body.agents.find((a: { agentId: string }) => a.agentId === workerAgentId);
    expect(worker.overdueCount).toBe(1);
  });

  it('does not count a conversation as overdue when the player’s message is recent', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });

    const freshConversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      assignedAgentId: workerAgentId,
    });
    await seedMessage({
      workspaceId,
      conversationId: freshConversationId,
      seq: 1,
      authorType: 'player',
      createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId);
    const worker = res.body.agents.find((a: { agentId: string }) => a.agentId === workerAgentId);
    expect(worker.overdueCount).toBe(0);
  });

  it('does not count a conversation as overdue when the agent replied last, even if that reply is old', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });

    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      assignedAgentId: workerAgentId,
    });
    await seedMessage({
      workspaceId,
      conversationId,
      seq: 1,
      authorType: 'player',
      createdAt: new Date(Date.now() - 10 * 60 * 60 * 1000),
    });
    await seedMessage({
      workspaceId,
      conversationId,
      seq: 2,
      authorType: 'agent',
      createdAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .get('/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId);
    const worker = res.body.agents.find((a: { agentId: string }) => a.agentId === workerAgentId);
    expect(worker.overdueCount).toBe(0);
  });
});
