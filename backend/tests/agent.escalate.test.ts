import { createServer } from 'node:http';
import express from 'express';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { resolutionCycle } from '../src/shared/db/schema/index.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts';
import {
  escalateConversation,
  unescalateConversation,
} from '../src/agent/services/escalationService.ts';
import { ESCALATION_NOTICE_MESSAGE } from '../src/domain/conversations/index.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedPlayer,
  seedResolutionCycle,
  seedWorkspace,
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

async function setupAgent(workspaceId: string) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ('agent1@example.test', 'Agent One') returning id`,
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  );
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
  return { agentId, token };
}

async function openConversationFixture() {
  const workspaceId = await seedWorkspace();
  const { agentId, token } = await setupAgent(workspaceId);
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({
    workspaceId,
    playerId,
    status: 'open',
    assignedAgentId: agentId,
  });
  return { workspaceId, agentId, token, conversationId };
}

async function conversationRow(id: string) {
  const { rows } = await ownerPool.query(
    `select status, assigned_agent_id from conversation where id = $1`,
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
  const { rows } = await ownerPool.query(
    `select author_type, visibility, body from message where conversation_id = $1 order by seq`,
    [id],
  );
  return rows;
}

describe('POST /agent/conversations/:id/escalate', () => {
  it('moves an open conversation to escalated, keeps the assignment, and writes conversation_escalated', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'open', assigned_agent_id = $2 where id = $1`,
      [conversationId, agentId],
    );

    const res = await request(app)
      .post(`/conversations/${conversationId}/escalate`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ escalated: true });
    const row = await conversationRow(conversationId);
    expect(row.status).toBe('escalated');
    expect(row.assigned_agent_id).toBe(agentId);
    expect(await eventsFor(conversationId)).toEqual([
      {
        type: 'message_sent',
        actor_type: 'system',
        payload: { seq: 1, author_type: 'system', visibility: 'public' },
      },
      { type: 'conversation_escalated', actor_type: 'agent', payload: { agent_id: agentId } },
    ]);
  });

  it('posts a public system notice telling the player their ticket was escalated', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'open', assigned_agent_id = $2 where id = $1`,
      [conversationId, agentId],
    );

    const res = await request(app)
      .post(`/conversations/${conversationId}/escalate`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(await messagesFor(conversationId)).toEqual([
      { author_type: 'system', visibility: 'public', body: ESCALATION_NOTICE_MESSAGE },
    ]);
  });

  it('allows escalating from awaiting_player', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'awaiting_player', assigned_agent_id = $2 where id = $1`,
      [conversationId, agentId],
    );

    expect(
      (
        await request(app)
          .post(`/conversations/${conversationId}/escalate`)
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(200);
  });

  it('allows any agent to escalate an unassigned conversation', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [
      conversationId,
    ]);

    expect(
      (
        await request(app)
          .post(`/conversations/${conversationId}/escalate`)
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(200);
  });

  it('rejects with 409 when status is bot_active', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set assigned_agent_id = $2 where id = $1`, [
      conversationId,
      agentId,
    ]);

    const res = await request(app)
      .post(`/conversations/${conversationId}/escalate`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('wrong_status');
  });

  it('rejects with 409 when already escalated', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'escalated', assigned_agent_id = $2 where id = $1`,
      [conversationId, agentId],
    );

    const res = await request(app)
      .post(`/conversations/${conversationId}/escalate`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('wrong_status');
  });

  it('rejects with 403 when another agent owns it, and writes nothing', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agent2@example.test', 'Agent Two') returning id`,
    );
    const otherAgentId = rows[0]!.id;
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
      [workspaceId, otherAgentId],
    );
    await ownerPool.query(
      `update conversation set status = 'open', assigned_agent_id = $2 where id = $1`,
      [conversationId, otherAgentId],
    );

    const res = await request(app)
      .post(`/conversations/${conversationId}/escalate`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('not_owner');
    expect((await conversationRow(conversationId)).status).toBe('open');
  });

  it('404s on a conversation in another workspace', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAgent(workspaceId);
    const otherWorkspaceId = await seedWorkspace();
    const otherPlayerId = await seedPlayer(otherWorkspaceId);
    const foreignId = await seedConversation({
      workspaceId: otherWorkspaceId,
      playerId: otherPlayerId,
    });
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [foreignId]);
    const res = await request(app)
      .post(`/conversations/${foreignId}/escalate`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('422s on a non-uuid id', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAgent(workspaceId);
    expect(
      (
        await request(app)
          .post('/conversations/not-a-uuid/escalate')
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(422);
  });
});

describe('POST /agent/conversations/:id/unescalate', () => {
  it('moves an escalated conversation back to open, keeps the assignment, and writes conversation_unescalated', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'escalated', assigned_agent_id = $2 where id = $1`,
      [conversationId, agentId],
    );

    const res = await request(app)
      .post(`/conversations/${conversationId}/unescalate`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unescalated: true });
    const row = await conversationRow(conversationId);
    expect(row.status).toBe('open');
    expect(row.assigned_agent_id).toBe(agentId);
    expect(await eventsFor(conversationId)).toEqual([
      { type: 'conversation_unescalated', actor_type: 'agent', payload: { agent_id: agentId } },
    ]);
  });

  it('posts no message — un-escalation carries no player-facing notice', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'escalated', assigned_agent_id = $2 where id = $1`,
      [conversationId, agentId],
    );

    const res = await request(app)
      .post(`/conversations/${conversationId}/unescalate`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(await messagesFor(conversationId)).toEqual([]);
  });

  it('rejects with 409 when not currently escalated', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'open', assigned_agent_id = $2 where id = $1`,
      [conversationId, agentId],
    );

    const res = await request(app)
      .post(`/conversations/${conversationId}/unescalate`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('wrong_status');
  });

  it('rejects with 403 when another agent owns it', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agent2@example.test', 'Agent Two') returning id`,
    );
    const otherAgentId = rows[0]!.id;
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
      [workspaceId, otherAgentId],
    );
    await ownerPool.query(
      `update conversation set status = 'escalated', assigned_agent_id = $2 where id = $1`,
      [conversationId, otherAgentId],
    );

    const res = await request(app)
      .post(`/conversations/${conversationId}/unescalate`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('not_owner');
  });

  it('404s on a conversation in another workspace', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAgent(workspaceId);
    const otherWorkspaceId = await seedWorkspace();
    const otherPlayerId = await seedPlayer(otherWorkspaceId);
    const foreignId = await seedConversation({
      workspaceId: otherWorkspaceId,
      playerId: otherPlayerId,
    });
    await ownerPool.query(`update conversation set status = 'escalated' where id = $1`, [
      foreignId,
    ]);
    const res = await request(app)
      .post(`/conversations/${foreignId}/unescalate`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('422s on a non-uuid id', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAgent(workspaceId);
    expect(
      (
        await request(app)
          .post('/conversations/not-a-uuid/unescalate')
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(422);
  });
});

describe('escalation and the inactivity clock', () => {
  it('nulls inactivity_due_at on escalate and sets a fresh window on unescalate', async () => {
    const { workspaceId, agentId, conversationId } = await openConversationFixture();
    const dueAt = new Date('2026-08-18T12:00:00Z');
    await seedResolutionCycle({ workspaceId, conversationId, inactivityDueAt: dueAt });

    const ctx = { workspaceId, agentId } as never;

    const escalated = await escalateConversation(ctx, conversationId);
    expect(escalated.ok).toBe(true);
    expect(escalated.ok && escalated.posted?.body).toBe(ESCALATION_NOTICE_MESSAGE);
    const paused = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(resolutionCycle).where(eq(resolutionCycle.conversationId, conversationId)),
    );
    expect(paused[0]!.inactivityDueAt).toBeNull();

    expect(await unescalateConversation(ctx, conversationId)).toEqual({ ok: true, posted: null });
    const resumed = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(resolutionCycle).where(eq(resolutionCycle.conversationId, conversationId)),
    );
    expect(resumed[0]!.inactivityDueAt).not.toBeNull();
    // A fresh full window, not the remainder of the paused one.
    expect(resumed[0]!.inactivityDueAt!.getTime()).toBeGreaterThan(dueAt.getTime());
  });

  it('leaves a resolved cycle untouched when the toggle is rejected', async () => {
    const { workspaceId, agentId, conversationId } = await openConversationFixture();
    await seedResolutionCycle({
      workspaceId,
      conversationId,
      inactivityDueAt: null,
      resolvedAt: new Date('2026-08-17T00:00:00Z'),
      resolutionKind: 'agent',
    });

    // Wrong status for unescalate — the guard rejects before any clock write.
    expect(await unescalateConversation({ workspaceId, agentId } as never, conversationId)).toEqual(
      {
        ok: false,
        reason: 'wrong_status',
      },
    );
    const rows = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(resolutionCycle).where(eq(resolutionCycle.conversationId, conversationId)),
    );
    expect(rows[0]!.inactivityDueAt).toBeNull();
  });
});
