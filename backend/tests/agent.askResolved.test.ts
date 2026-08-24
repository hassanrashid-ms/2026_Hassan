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
  seedConversation,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

// A standalone app carrying just this router, gated by the real
// requireAgentSession middleware — not the shared app.ts, and it never
// touches agent/router.ts. conversationsRouter isn't mounted there until the
// Batch 2 Checkpoint, so this is the only way to exercise it before then, and
// it keeps this task's test run from racing Task 8's over the same file.
const app = express();
app.use(express.json());
app.use(requireAgentSession, conversationsRouter);
app.use(errorMiddleware);

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

async function conversationRow(id: string) {
  const { rows } = await ownerPool.query(
    `select status, confirm_phase, assigned_agent_id from conversation where id = $1`,
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

describe('POST /agent/conversations/:id/ask-resolved', () => {
  it('posts the fixed question, sets agent_ask, and writes resolution_check_requested', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'open', assigned_agent_id = $2 where id = $1`,
      [conversationId, agentId],
    );

    const res = await request(app)
      .post(`/conversations/${conversationId}/ask-resolved`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ asked: true });
    const row = await conversationRow(conversationId);
    expect(row.confirm_phase).toBe('agent_ask');
    expect(row.status).toBe('open');
    expect(await messagesFor(conversationId)).toEqual([
      { author_type: 'system', visibility: 'public', body: 'Did this solve it?' },
    ]);
    const events = await eventsFor(conversationId);
    expect(events).toEqual([
      {
        type: 'message_sent',
        actor_type: 'system',
        payload: { seq: 1, author_type: 'system', visibility: 'public' },
      },
      {
        type: 'resolution_check_requested',
        actor_type: 'agent',
        payload: { source: 'agent', agent_id: agentId },
      },
    ]);
  });

  it('rejects a double-ask with 409 and writes nothing the second time', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'open', assigned_agent_id = $2 where id = $1`,
      [conversationId, agentId],
    );

    await request(app)
      .post(`/conversations/${conversationId}/ask-resolved`)
      .set('Authorization', `Bearer ${token}`);
    const second = await request(app)
      .post(`/conversations/${conversationId}/ask-resolved`)
      .set('Authorization', `Bearer ${token}`);

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('already_pending');
    expect((await messagesFor(conversationId)).length).toBe(1);
    expect((await eventsFor(conversationId)).length).toBe(2);
  });

  it('rejects when status is bot_active', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set assigned_agent_id = $2 where id = $1`, [
      conversationId,
      agentId,
    ]);

    const res = await request(app)
      .post(`/conversations/${conversationId}/ask-resolved`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('wrong_status');
    expect((await conversationRow(conversationId)).confirm_phase).toBe('none');
  });

  it('rejects when status is resolved', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'resolved', assigned_agent_id = $2 where id = $1`,
      [conversationId, agentId],
    );

    expect(
      (
        await request(app)
          .post(`/conversations/${conversationId}/ask-resolved`)
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(409);
  });

  it('allows awaiting_player', async () => {
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
          .post(`/conversations/${conversationId}/ask-resolved`)
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(200);
  });

  it('allows escalated — the only path from escalated to resolved is asking the player', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'escalated', assigned_agent_id = $2 where id = $1`,
      [conversationId, agentId],
    );

    const res = await request(app)
      .post(`/conversations/${conversationId}/ask-resolved`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const row = await conversationRow(conversationId);
    // Asking does not itself resolve anything — status stays escalated until the player answers.
    expect(row.status).toBe('escalated');
    expect(row.confirm_phase).toBe('agent_ask');
  });

  it('allows any agent when the conversation is unassigned', async () => {
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
          .post(`/conversations/${conversationId}/ask-resolved`)
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(200);
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
      `update conversation set status = 'open', assigned_agent_id = $2 where id = $1`,
      [conversationId, otherAgentId],
    );

    const res = await request(app)
      .post(`/conversations/${conversationId}/ask-resolved`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('not_owner');
    expect((await conversationRow(conversationId)).confirm_phase).toBe('none');
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
      .post(`/conversations/${foreignId}/ask-resolved`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('422s on a non-uuid id', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAgent(workspaceId);
    expect(
      (
        await request(app)
          .post('/conversations/not-a-uuid/ask-resolved')
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(422);
  });
});
