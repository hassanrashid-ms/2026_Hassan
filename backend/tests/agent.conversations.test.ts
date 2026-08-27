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
import { messagesRouter } from '../src/agent/routers/messagesRouter.ts';
import { presignPutObject } from '../src/shared/storage/presign.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedMessage,
  seedPlayer,
  seedWorkspace,
  seedResolutionCycle,
  truncateAll,
  seedIntent,
  seedSubintent,
  seedAgent,
} from './helpers/db.ts';

// A standalone app carrying just this router, gated by the real
// requireAgentSession middleware — not the shared app.ts, and it never
// touches agent/router.ts. conversationsRouter isn't mounted there until the
// Batch 2 Checkpoint, so this is the only way to exercise it before then, and
// it keeps this task's test run from racing Task 8's over the same file.
const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, conversationsRouter);
app.use(errorMiddleware);

// A second standalone app carrying messagesRouter, needed only to produce a
// real attachment row + real stored object via POST /messages ahead of the
// list-read test below — see agent.messages.test.ts for the file that
// otherwise owns this router's coverage.
const messagesApp = express();
messagesApp.use(express.json());
messagesApp.use(requireAgentSession, resolveConsoleWorkspace, messagesRouter);
messagesApp.use(errorMiddleware);

// claimConversationHandler calls getIo() after a successful claim, so this
// file's own process needs a live Socket.io instance even though no test
// connects a client to it — a bare, unlistened http server is enough to
// satisfy getIo(). Same pattern as agent.messages.test.ts and
// surface.messages.test.ts, which hit the same singleton requirement.
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

async function setupAssignedAgent(workspaceId: string, conversationId: string) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ('agent1@example.test', 'Agent One') returning id`,
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  );
  await ownerPool.query(`update conversation set assigned_agent_id = $2 where id = $1`, [
    conversationId,
    agentId,
  ]);
  const token = await signAgentSession({ agent_id: agentId });
  return { agentId, token };
}

async function setupAgent(workspaceId: string) {
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

describe('GET /agent/conversations', () => {
  it('lists unassigned conversations with a last-message preview', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    await seedMessage({
      workspaceId,
      conversationId,
      seq: 1,
      authorType: 'player',
      body: 'help please',
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0].last_message_preview).toBe('help please');
  });

  it('lists confirm_phase per conversation', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const { agentId, token } = await setupAgent(workspaceId);
    await ownerPool.query(`update conversation set assigned_agent_id = $2 where id = $1`, [
      conversationId,
      agentId,
    ]);
    await ownerPool.query(`update conversation set confirm_phase = 'agent_ask' where id = $1`, [
      conversationId,
    ]);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'mine' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations[0].confirm_phase).toBe('agent_ask');
  });

  it('omits a resolved conversation from the unassigned list', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const resolvedId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const openId = await seedConversation({ workspaceId, playerId, status: 'open' });
    await ownerPool.query(`update conversation set status = 'resolved' where id = $1`, [
      resolvedId,
    ]);
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([openId]);
  });

  it('omits a closed conversation from the mine list', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const closedId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const openId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const { agentId, token } = await setupAgent(workspaceId);
    await ownerPool.query(
      `update conversation set assigned_agent_id = $2 where id = any($1::uuid[])`,
      [[closedId, openId], agentId],
    );
    await ownerPool.query(`update conversation set status = 'closed' where id = $1`, [closedId]);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'mine' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([openId]);
  });
});

describe('GET /agent/conversations filters', () => {
  it('filters by priority', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token } = await setupAgent(workspaceId);
    const highId = await seedConversation({
      workspaceId,
      playerId,
      priority: 'p1',
      status: 'open',
    });
    const lowId = await seedConversation({ workspaceId, playerId, priority: 'p4', status: 'open' });

    const dbRow = await ownerPool.query(
      `select id, workspace_id, status, priority, assigned_agent_id from conversation where id = $1`,
      [highId],
    );

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', priority: 'p1' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: any) => c.id)).toEqual([highId]);
  });

  it('filters by subintentIds', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token } = await setupAgent(workspaceId);
    const intentId = await seedIntent(workspaceId);
    const subintentId = await seedSubintent({ workspaceId, intentId });
    const matchId = await seedConversation({ workspaceId, playerId, subintentId, status: 'open' });
    const noMatchId = await seedConversation({ workspaceId, playerId, status: 'open' });

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', subintentIds: subintentId })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: any) => c.id)).toEqual([matchId]);
  });

  it('filters by assigneeIds', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { agentId, token } = await setupAgent(workspaceId);
    const agent2 = await seedAgent('agent2@example.test');
    const matchId = await seedConversation({
      workspaceId,
      playerId,
      assignedAgentId: agentId,
      status: 'open',
    });
    const noMatchId = await seedConversation({
      workspaceId,
      playerId,
      assignedAgentId: agent2,
      status: 'open',
    });

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'agentAssigned', assigneeIds: agentId })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: any) => c.id)).toEqual([matchId]);
  });

  it('filters by labelIds', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token } = await setupAgent(workspaceId);
    const matchId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const noMatchId = await seedConversation({ workspaceId, playerId, status: 'open' });

    const { rows: tagRows } = await ownerPool.query<{ id: string }>(
      `insert into tag (workspace_id, name, normalized_name, color_index) values ($1, 'Bug', 'bug', 1) returning id`,
      [workspaceId],
    );
    const tagId = tagRows[0]!.id;

    await ownerPool.query(
      `insert into conversation_tag (workspace_id, conversation_id, tag_id) values ($1, $2, $3)`,
      [workspaceId, matchId, tagId],
    );

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', labelIds: tagId })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: any) => c.id)).toEqual([matchId]);
  });

  it('filters by olderThanHours', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token } = await setupAgent(workspaceId);
    const oldId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const newId = await seedConversation({ workspaceId, playerId, status: 'open' });

    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await seedMessage({
      workspaceId,
      conversationId: oldId,
      seq: 1,
      authorType: 'player',
      createdAt: threeHoursAgo,
    });
    await seedMessage({ workspaceId, conversationId: newId, seq: 1, authorType: 'player' }); // now

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', olderThanHours: 2 })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: any) => c.id)).toEqual([oldId]);
  });

  it('combines multiple filters', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token } = await setupAgent(workspaceId);
    const matchId = await seedConversation({
      workspaceId,
      playerId,
      priority: 'p1',
      status: 'open',
    });
    const noMatchId = await seedConversation({
      workspaceId,
      playerId,
      priority: 'p1',
      status: 'open',
    });
    const diffPriorityId = await seedConversation({
      workspaceId,
      playerId,
      priority: 'p4',
      status: 'open',
    });

    const { rows: tagRows } = await ownerPool.query<{ id: string }>(
      `insert into tag (workspace_id, name, normalized_name, color_index) values ($1, 'Vip', 'vip', 2) returning id`,
      [workspaceId],
    );
    const tagId = tagRows[0]!.id;

    await ownerPool.query(
      `insert into conversation_tag (workspace_id, conversation_id, tag_id) values ($1, $2, $3)`,
      [workspaceId, matchId, tagId],
    );
    await ownerPool.query(
      `insert into conversation_tag (workspace_id, conversation_id, tag_id) values ($1, $2, $3)`,
      [workspaceId, diffPriorityId, tagId],
    );

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', priority: 'p1', labelIds: tagId })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: any) => c.id)).toEqual([matchId]);
  });

  it('searches by q (ticket number)', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token } = await setupAgent(workspaceId);
    const c1 = await seedConversation({ workspaceId, playerId, status: 'open' });

    const { rows } = await ownerPool.query<{ number: number }>(
      `select number from conversation where id = $1`,
      [c1],
    );
    const ticketNum = rows[0]!.number;

    const c2 = await seedConversation({ workspaceId, playerId, status: 'open' });

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', q: ticketNum.toString() })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: any) => c.id)).toEqual([c1]);
  });

  it('searches by q (player external id)', async () => {
    const workspaceId = await seedWorkspace();
    const p1 = await seedPlayer(workspaceId, 'ext-abc-123');
    const p2 = await seedPlayer(workspaceId, 'ext-xyz-987');
    const { token } = await setupAgent(workspaceId);
    const c1 = await seedConversation({ workspaceId, playerId: p1, status: 'open' });
    const c2 = await seedConversation({ workspaceId, playerId: p2, status: 'open' });

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', q: 'abc-12' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: any) => c.id)).toEqual([c1]);
  });

  it('searches by q (subintent name)', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token } = await setupAgent(workspaceId);
    const intentId = await seedIntent(workspaceId);
    const sub1 = await seedSubintent({ workspaceId, intentId, name: 'Billing Issue' });
    const sub2 = await seedSubintent({ workspaceId, intentId, name: 'Login Problem' });

    const c1 = await seedConversation({ workspaceId, playerId, subintentId: sub1, status: 'open' });
    const c2 = await seedConversation({ workspaceId, playerId, subintentId: sub2, status: 'open' });

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', q: 'billing' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: any) => c.id)).toEqual([c1]);
  });
});

describe('GET /agent/conversations pagination', () => {
  it('caps a page at 25 and returns a nextCursor when more rows exist', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    for (let i = 0; i < 30; i++) {
      await seedConversation({ workspaceId, playerId, status: 'open' });
    }
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations).toHaveLength(25);
    expect(typeof res.body.nextCursor).toBe('string');
  });

  it('returns the remaining rows and a null nextCursor on the second page', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(await seedConversation({ workspaceId, playerId, status: 'open' }));
    }
    const { token } = await setupAgent(workspaceId);

    const page1 = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const page2 = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', cursor: page1.body.nextCursor })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(page2.body.conversations).toHaveLength(5);
    expect(page2.body.nextCursor).toBeNull();

    const page1Ids = page1.body.conversations.map((c: { id: string }) => c.id);
    const page2Ids = page2.body.conversations.map((c: { id: string }) => c.id);
    expect(new Set([...page1Ids, ...page2Ids]).size).toBe(30);
    expect([...page1Ids, ...page2Ids].sort()).toEqual([...ids].sort());
  });

  it('does not skip or duplicate a row inserted between two page fetches', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    for (let i = 0; i < 25; i++) {
      await seedConversation({ workspaceId, playerId, status: 'open' });
    }
    const { token } = await setupAgent(workspaceId);

    const page1 = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(page1.body.nextCursor).toBeNull();

    const lateId = await seedConversation({ workspaceId, playerId, status: 'open' });

    const refetched = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(refetched.body.conversations).toHaveLength(25);
    expect(typeof refetched.body.nextCursor).toBe('string');

    const page2 = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', cursor: refetched.body.nextCursor })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(page2.body.conversations.map((c: { id: string }) => c.id)).toEqual([lateId]);
  });
});

describe('GET /agent/conversations resolved/closed queues', () => {
  it('lists a conversation resolved within the last 7 days', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'resolved' });
    await seedResolutionCycle({
      workspaceId,
      conversationId,
      resolvedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'resolved' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([conversationId]);
    expect(res.body.nextCursor).toBeNull();
  });

  it('omits a conversation resolved more than 7 days ago', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'resolved' });
    await seedResolutionCycle({
      workspaceId,
      conversationId,
      resolvedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'resolved' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations).toEqual([]);
  });

  it('excludes a resolved conversation with no resolution cycle row', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    await seedConversation({ workspaceId, playerId, status: 'resolved' });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'resolved' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations).toEqual([]);
  });

  it('lists closed conversations most-recently-closed first', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const olderId = await seedConversation({ workspaceId, playerId, status: 'closed' });
    await seedResolutionCycle({
      workspaceId,
      conversationId: olderId,
      resolvedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      closedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const newerId = await seedConversation({ workspaceId, playerId, status: 'closed' });
    await seedResolutionCycle({
      workspaceId,
      conversationId: newerId,
      resolvedAt: new Date(Date.now() - 90 * 60 * 1000),
      closedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'closed' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([newerId, olderId]);
  });

  it('uses only the latest resolution cycle for a reopened-then-reclosed conversation', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'closed' });
    await seedResolutionCycle({
      workspaceId,
      conversationId,
      cycleNo: 1,
      resolvedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      closedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
    });
    await seedResolutionCycle({
      workspaceId,
      conversationId,
      cycleNo: 2,
      resolvedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      closedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'closed' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([conversationId]);
  });

  it('paginates the resolved queue in pages of 25, newest first, with a stable cursor', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    for (let i = 0; i < 30; i++) {
      const conversationId = await seedConversation({ workspaceId, playerId, status: 'resolved' });
      await seedResolutionCycle({
        workspaceId,
        conversationId,
        resolvedAt: new Date(Date.now() - i * 60 * 1000),
      });
    }
    const { token } = await setupAgent(workspaceId);

    const page1 = await request(app)
      .get('/conversations')
      .query({ status: 'resolved' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(page1.body.conversations).toHaveLength(25);
    expect(typeof page1.body.nextCursor).toBe('string');

    const page2 = await request(app)
      .get('/conversations')
      .query({ status: 'resolved', cursor: page1.body.nextCursor })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(page2.body.conversations).toHaveLength(5);
    expect(page2.body.nextCursor).toBeNull();

    const page1Ids = page1.body.conversations.map((c: { id: string }) => c.id);
    const page2Ids = page2.body.conversations.map((c: { id: string }) => c.id);
    expect(new Set([...page1Ids, ...page2Ids]).size).toBe(30);
  });
});

describe('POST /agent/conversations/:id/claim', () => {
  it('claims an unassigned conversation', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(res.body).toEqual({ claimed: true });
  });

  it('writes exactly one conversation_assigned event for a successful claim', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const { agentId, token } = await setupAgent(workspaceId);

    await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const { rows } = await ownerPool.query(
      `select actor_type, actor_id, session_id, payload from event where conversation_id = $1 and type = 'conversation_assigned' order by id`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_type: 'agent',
      actor_id: agentId,
      session_id: null,
      payload: { agent_id: agentId, via: 'claim' },
    });
  });

  it('a losing claim on an already-claimed conversation writes no extra event', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const agentA = await setupAgent(workspaceId);
    const { rows: agentBRows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agent2@example.test', 'Agent Two') returning id`,
    );
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
      [workspaceId, agentBRows[0]!.id],
    );
    const tokenB = await signAgentSession({
      agent_id: agentBRows[0]!.id
    });

    await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${agentA.token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    const resB = await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${tokenB}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(resB.body).toEqual({ claimed: false });

    const { rows } = await ownerPool.query<{ n: number }>(
      `select count(*)::int as n from event where conversation_id = $1 and type = 'conversation_assigned'`,
      [conversationId],
    );
    expect(rows[0]!.n).toBe(1);

    // The one event that exists is the winner's, not the loser's.
    const { rows: actors } = await ownerPool.query<{ actor_id: string }>(
      `select actor_id from event where conversation_id = $1 and type = 'conversation_assigned'`,
      [conversationId],
    );
    expect(actors[0]!.actor_id).toBe(agentA.agentId);
  });

  it('a claim race: exactly one of two concurrent claims succeeds', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const agentA = await setupAgent(workspaceId);
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agent2@example.test', 'Agent Two') returning id`,
    );
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
      [workspaceId, rows[0]!.id],
    );
    const tokenB = await signAgentSession({ agent_id: rows[0]!.id });

    const [resA, resB] = await Promise.all([
      request(app)
        .post(`/conversations/${conversationId}/claim`)
        .set('Authorization', `Bearer ${agentA.token}`)
        .set('X-Workspace-Id', workspaceId),
      request(app)
        .post(`/conversations/${conversationId}/claim`)
        .set('Authorization', `Bearer ${tokenB}`)
        .set('X-Workspace-Id', workspaceId),
    ]);

    const claimedFlags = [resA.body.claimed, resB.body.claimed].sort();
    expect(claimedFlags).toEqual([false, true]);
  });

  it('refuses to claim a resolved conversation and leaves it unassigned', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    await ownerPool.query(`update conversation set status = 'resolved' where id = $1`, [
      conversationId,
    ]);
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(res.body).toEqual({ claimed: false });

    const { rows } = await ownerPool.query<{ assigned_agent_id: string | null }>(
      `select assigned_agent_id from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.assigned_agent_id).toBeNull();
  });

  it('a refused claim on a closed conversation writes no conversation_assigned event', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    await ownerPool.query(`update conversation set status = 'closed' where id = $1`, [
      conversationId,
    ]);
    const { token } = await setupAgent(workspaceId);

    await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const { rows } = await ownerPool.query<{ n: number }>(
      `select count(*)::int as n from event where conversation_id = $1 and type = 'conversation_assigned'`,
      [conversationId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('an open unassigned conversation is still listed and still claimable', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const { agentId, token } = await setupAgent(workspaceId);

    const list = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(list.body.conversations.map((c: { id: string }) => c.id)).toEqual([conversationId]);

    const res = await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(res.body).toEqual({ claimed: true });

    const { rows } = await ownerPool.query<{ assigned_agent_id: string | null }>(
      `select assigned_agent_id from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.assigned_agent_id).toBe(agentId);
  });
});

describe('GET /agent/conversations/:id/messages', () => {
  it('returns the full history via toAgentView', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player', body: 'hi' });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0]).toMatchObject({ author_type: 'player', body: 'hi' });
  });

  it("404s for a conversation outside the agent's workspace", async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const playerB = await seedPlayer(workspaceB);
    const conversationB = await seedConversation({ workspaceId: workspaceB, playerId: playerB });
    const { token } = await setupAgent(workspaceA);

    await request(app)
      .get(`/conversations/${conversationB}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceA)
      .expect(404);
  });
});

describe('GET /agent/conversations/:id/messages with an attachment', () => {
  it('returns a fetchable presigned url for a message with an attachment', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAssignedAgent(workspaceId, conversationId);

    const key = `pending/${workspaceId}/${agentId}/${crypto.randomUUID()}.png`;
    const fileBody = Buffer.from('fake-png-bytes');
    const { url: putUrl } = await presignPutObject({
      key,
      contentType: 'image/png',
      contentLength: fileBody.length,
    });
    await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(fileBody.length) },
      body: fileBody,
    });

    await request(messagesApp)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({
        conversation_id: conversationId,
        body: '',
        attachment: { key, filename: 'shot.png', mime_type: 'image/png', byte_size: fileBody.length },
      })
      .expect(200);

    const res = await request(app)
      .get(`/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const withAttachment = res.body.messages.find((m: { attachment: unknown }) => m.attachment);
    expect(withAttachment.attachment.url).toBeTruthy();
    const getRes = await fetch(withAttachment.attachment.url);
    expect(getRes.status).toBe(200);
  });

  it('returns the real filename, not the typed caption, when a message has both text and an attachment', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAssignedAgent(workspaceId, conversationId);

    const key = `pending/${workspaceId}/${agentId}/${crypto.randomUUID()}.png`;
    const fileBody = Buffer.from('fake-png-bytes');
    const { url: putUrl } = await presignPutObject({
      key,
      contentType: 'image/png',
      contentLength: fileBody.length,
    });
    await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(fileBody.length) },
      body: fileBody,
    });

    await request(messagesApp)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({
        conversation_id: conversationId,
        body: 'here is a screenshot',
        attachment: { key, filename: 'shot.png', mime_type: 'image/png', byte_size: fileBody.length },
      })
      .expect(200);

    const res = await request(app)
      .get(`/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const withAttachment = res.body.messages.find((m: { attachment: unknown }) => m.attachment);
    expect(withAttachment.body).toBe('here is a screenshot');
    expect(withAttachment.attachment.filename).toBe('shot.png');
    expect(withAttachment.attachment.filename).not.toBe('here is a screenshot');
  });
});
