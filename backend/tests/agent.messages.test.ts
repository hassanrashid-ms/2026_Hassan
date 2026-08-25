import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { presignPutObject } from '../src/shared/storage/presign.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { messagesRouter } from '../src/agent/routers/messagesRouter.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

// Standalone app around just this router — see Task 7's test for why. Keeps
// this task's test run from racing Task 7's over agent/router.ts.
const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, messagesRouter);
app.use(errorMiddleware);

// sendAgentMessage calls getIo() after its transaction commits, so this file's
// own process needs a live Socket.io instance even though no test connects a
// client to it — a bare, unlistened http server is enough to satisfy getIo().
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

describe('POST /agent/messages', () => {
  it('sends a message when the caller is the assigned agent', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { token } = await setupAssignedAgent(workspaceId, conversationId);

    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ conversation_id: conversationId, body: 'how can I help?' })
      .expect(200);
    expect(res.body.message).toMatchObject({
      author_type: 'agent',
      body: 'how can I help?',
      seq: 1,
    });
  });

  it('403s when the conversation is not assigned to the caller', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agent2@example.test', 'Agent Two') returning id`,
    );
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
      [workspaceId, rows[0]!.id],
    );
    const token = await signAgentSession({ agent_id: rows[0]!.id });

    await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ conversation_id: conversationId, body: 'hi' })
      .expect(403);
  });

  it("404s for a conversation outside the agent's workspace", async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const playerB = await seedPlayer(workspaceB);
    const conversationB = await seedConversation({ workspaceId: workspaceB, playerId: playerB });
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agentA@example.test', 'Agent A') returning id`,
    );
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
      [workspaceA, rows[0]!.id],
    );
    const token = await signAgentSession({ agent_id: rows[0]!.id });

    await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceA)
      .send({ conversation_id: conversationB, body: 'hi' })
      .expect(404);
  });
});

describe('POST /agent/messages with an attachment', () => {
  async function uploadFixtureImage(workspaceId: string, agentId: string) {
    const key = `pending/${workspaceId}/${agentId}/${crypto.randomUUID()}.png`;
    const body = Buffer.from('fake-png-bytes');
    const { url } = await presignPutObject({
      key,
      contentType: 'image/png',
      contentLength: body.length,
    });
    await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.length) },
      body,
    });
    return key;
  }

  it('claims the pending object and inserts an attachment row, using the filename as body when body is empty', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAssignedAgent(workspaceId, conversationId);
    const key = await uploadFixtureImage(workspaceId, agentId);

    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({
        conversation_id: conversationId,
        body: '',
        attachment: { key, filename: 'screenshot.png', mime_type: 'image/png', byte_size: 14 },
      })
      .expect(200);

    expect(res.body.message.body).toBe('screenshot.png');
    expect(res.body.message.attachment).toMatchObject({
      filename: 'screenshot.png',
      mime_type: 'image/png',
      byte_size: 14,
    });

    const { rows } = await ownerPool.query(
      `select storage_key from attachment where message_id = $1`,
      [res.body.message.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].storage_key).toContain(`ws/${workspaceId}/attachments/`);
  });

  it('422s with attachment_not_found when the pending key does not exist', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAssignedAgent(workspaceId, conversationId);
    const bogusKey = `pending/${workspaceId}/${agentId}/${crypto.randomUUID()}.png`;

    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({
        conversation_id: conversationId,
        body: '',
        attachment: { key: bogusKey, filename: 'ghost.png', mime_type: 'image/png', byte_size: 14 },
      })
      .expect(422);
    expect(res.body.error.code).toBe('attachment_not_found');
  });

  it("422s with attachment_not_found when the key belongs to a different agent's pending prefix", async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { token } = await setupAssignedAgent(workspaceId, conversationId);
    const otherAgentId = crypto.randomUUID();
    const key = await uploadFixtureImage(workspaceId, otherAgentId);

    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({
        conversation_id: conversationId,
        body: '',
        attachment: { key, filename: 'screenshot.png', mime_type: 'image/png', byte_size: 14 },
      })
      .expect(422);
    expect(res.body.error.code).toBe('attachment_not_found');
  });

  it("422s with attachment_not_found when the key belongs to a different workspace's pending prefix", async () => {
    const workspaceId = await seedWorkspace();
    const otherWorkspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAssignedAgent(workspaceId, conversationId);
    const key = await uploadFixtureImage(otherWorkspaceId, agentId);

    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({
        conversation_id: conversationId,
        body: '',
        attachment: { key, filename: 'screenshot.png', mime_type: 'image/png', byte_size: 14 },
      })
      .expect(422);
    expect(res.body.error.code).toBe('attachment_not_found');
  });

  it('422s with attachment_mismatch when the real object exceeds the size cap even though the declared value agrees', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAssignedAgent(workspaceId, conversationId);

    // Constructed directly via presignPutObject, bypassing the normal
    // /agent/uploads endpoint (which already blocks an oversized declared
    // byte_size at presign time) — this proves the claim-time re-check is
    // real defense-in-depth, not just a mirror of the presign-time check.
    const key = `pending/${workspaceId}/${agentId}/${crypto.randomUUID()}.png`;
    const oversizedBody = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    const { url } = await presignPutObject({
      key,
      contentType: 'image/png',
      contentLength: oversizedBody.length,
    });
    await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(oversizedBody.length) },
      body: oversizedBody,
    });

    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({
        conversation_id: conversationId,
        body: '',
        attachment: {
          key,
          filename: 'screenshot.png',
          mime_type: 'image/png',
          byte_size: oversizedBody.length,
        },
      })
      .expect(422);
    expect(res.body.error.code).toBe('attachment_mismatch');
  });

  it('422s with attachment_mismatch when declared byte_size disagrees with the real object', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAssignedAgent(workspaceId, conversationId);
    const key = await uploadFixtureImage(workspaceId, agentId);

    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({
        conversation_id: conversationId,
        body: '',
        attachment: { key, filename: 'screenshot.png', mime_type: 'image/png', byte_size: 999999 },
      })
      .expect(422);
    expect(res.body.error.code).toBe('attachment_mismatch');
  });
});

describe('POST /agent/messages/read', () => {
  it('marks player-authored messages up to seq as read', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, body) values ($1, $2, 1, 'player', 'help')`,
      [workspaceId, conversationId],
    );
    const { token } = await setupAssignedAgent(workspaceId, conversationId);

    await request(app)
      .post('/messages/read')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ conversation_id: conversationId, up_to_seq: 1 })
      .expect(200);

    const { rows } = await ownerPool.query<{ delivery_state: string }>(
      `select delivery_state from message where conversation_id = $1 and seq = 1`,
      [conversationId],
    );
    expect(rows[0]!.delivery_state).toBe('read');
  });
});

describe('POST /agent/messages — internal notes and status transition', () => {
  it('an internal note stores visibility internal and leaves status unchanged even from open', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [
      conversationId,
    ]);
    const { token } = await setupAssignedAgent(workspaceId, conversationId);

    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ conversation_id: conversationId, body: 'internal note', visibility: 'internal' })
      .expect(200);
    expect(res.body.message).toMatchObject({ visibility: 'internal' });

    const { rows } = await ownerPool.query<{ status: string }>(
      `select status from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.status).toBe('open');
  });

  it('a public reply from open flips status to awaiting_player and appends conversation_awaiting_player', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [
      conversationId,
    ]);
    const { token } = await setupAssignedAgent(workspaceId, conversationId);

    await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ conversation_id: conversationId, body: 'here is the fix' })
      .expect(200);

    const { rows } = await ownerPool.query<{ status: string }>(
      `select status from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.status).toBe('awaiting_player');

    const { rows: events } = await ownerPool.query<{ type: string }>(
      `select type from event where conversation_id = $1 and type = 'conversation_awaiting_player'`,
      [conversationId],
    );
    expect(events).toHaveLength(1);
  });

  it('a public reply from a status other than open leaves status unchanged', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set status = 'awaiting_player' where id = $1`, [
      conversationId,
    ]);
    const { token } = await setupAssignedAgent(workspaceId, conversationId);

    await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ conversation_id: conversationId, body: 'still here' })
      .expect(200);

    const { rows } = await ownerPool.query<{ status: string }>(
      `select status from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.status).toBe('awaiting_player');
  });

  // Escalated is forward-only to resolved: an agent's reply must never pull it back into the
  // ordinary open/awaiting_player flow, or a ticket that's gone to engineering silently loses
  // that state the moment someone types in the thread.
  it('a public reply while escalated leaves status escalated', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set status = 'escalated' where id = $1`, [
      conversationId,
    ]);
    const { token } = await setupAssignedAgent(workspaceId, conversationId);

    await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ conversation_id: conversationId, body: 'still working on this with engineering' })
      .expect(200);

    const { rows } = await ownerPool.query<{ status: string }>(
      `select status from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.status).toBe('escalated');
  });

  it('message_sent event payload includes visibility', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { token } = await setupAssignedAgent(workspaceId, conversationId);

    await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ conversation_id: conversationId, body: 'note', visibility: 'internal' })
      .expect(200);

    const { rows } = await ownerPool.query<{ payload: { visibility?: string } }>(
      `select payload from event where conversation_id = $1 and type = 'message_sent'`,
      [conversationId],
    );
    expect(rows[0]!.payload.visibility).toBe('internal');
  });
});

describe('POST /messages/read records when the agent saw it', () => {
  it('stamps read_at on player messages and leaves agent messages untouched', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAssignedAgent(workspaceId, conversationId);
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, author_agent_id, body)
       values ($1, $2, 1, 'player', null, 'my coins vanished'), ($1, $2, 2, 'agent', $3, 'looking into it')`,
      [workspaceId, conversationId, agentId],
    );

    await request(app)
      .post('/messages/read')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ conversation_id: conversationId, up_to_seq: 2 })
      .expect(200);

    const { rows } = await ownerPool.query<{
      seq: number;
      delivery_state: string;
      read_at: Date | null;
    }>(`select seq, delivery_state, read_at from message where conversation_id = $1 order by seq`, [
      conversationId,
    ]);
    expect(rows[0]).toMatchObject({ seq: 1, delivery_state: 'read' });
    expect(rows[0]!.read_at).toBeInstanceOf(Date);
    // An agent reading their own reply is not a receipt.
    expect(rows[1]).toMatchObject({ seq: 2, delivery_state: 'sent' });
    expect(rows[1]!.read_at).toBeNull();
  });

  it('never moves read_at forward on a second read of the same message', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { token } = await setupAssignedAgent(workspaceId, conversationId);
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, author_agent_id, body)
       values ($1, $2, 1, 'player', null, 'my coins vanished')`,
      [workspaceId, conversationId],
    );

    const read = () =>
      request(app)
        .post('/messages/read')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Workspace-Id', workspaceId)
        .send({ conversation_id: conversationId, up_to_seq: 1 })
        .expect(200);
    const readAtNow = async () => {
      const { rows } = await ownerPool.query<{ read_at: Date }>(
        `select read_at from message where conversation_id = $1 and seq = 1`,
        [conversationId],
      );
      return rows[0]!.read_at.toISOString();
    };

    await read();
    const first = await readAtNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await read();
    expect(await readAtNow()).toBe(first);
  });
});
