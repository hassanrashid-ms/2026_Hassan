import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { app, mintToken } from './helpers/app.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedPlayer,
  seedSession,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

vi.mock('../src/shared/jobs/botTurns.ts', () => ({
  enqueueBotTurn: vi.fn().mockResolvedValue(undefined),
}));

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeDb();
  await closeOwnerPool();
});

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
});

async function setup() {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const sessionId = await seedSession({ workspaceId, playerId });
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'p1',
  });
  return { workspaceId, playerId, sessionId, token };
}

const post = (token: string, body: Record<string, unknown> = {}) =>
  request(app).post('/surface/new-ticket').set('Authorization', `Bearer ${token}`).send(body);

async function setStatus(conversationId: string, status: string) {
  await ownerPool.query(`update conversation set status = $2 where id = $1`, [
    conversationId,
    status,
  ]);
}

async function events(conversationId: string): Promise<string[]> {
  const { rows } = await ownerPool.query<{ type: string }>(
    // `id` alone, not occurred_at: every event in one transaction shares
    // now(), so only the bigserial orders them deterministically.
    `select type from event where conversation_id = $1 order by id`,
    [conversationId],
  );
  return rows.map((r) => r.type);
}

describe('POST /surface/new-ticket', () => {
  it('409s while the current conversation is still live', async () => {
    const { workspaceId, playerId, token } = await setup();
    const conversationId = await seedConversation({ workspaceId, playerId });
    await setStatus(conversationId, 'open');

    const res = await post(token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conversation_still_open');

    // Nothing was created and nothing was closed.
    const { rows } = await ownerPool.query(
      `select id, status from conversation where player_id = $1`,
      [playerId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
  });

  it('409s at bot_active too — the default status is not a closeable one', async () => {
    const { workspaceId, playerId, token } = await setup();
    await seedConversation({ workspaceId, playerId });
    expect((await post(token)).status).toBe(409);
  });

  it('404s when the player has no conversation at all', async () => {
    const { token } = await setup();
    const res = await post(token);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('closes the resolved conversation and opens a fresh bot_active one', async () => {
    const { workspaceId, playerId, sessionId, token } = await setup();
    const oldId = await seedConversation({ workspaceId, playerId, sessionId });
    await setStatus(oldId, 'resolved');

    const res = await post(token, { session_id: sessionId });
    expect(res.status).toBe(201);
    expect(res.body.conversation_id).toBeDefined();
    expect(res.body.conversation_id).not.toBe(oldId);
    expect(res.body).toMatchObject({ status: 'bot_active', message: null });

    const newId = res.body.conversation_id as string;
    const { rows } = await ownerPool.query<{ id: string; status: string; session_id: string }>(
      `select id, status, session_id from conversation where player_id = $1 order by created_at`,
      [playerId],
    );
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [oldId, 'closed'],
      [newId, 'bot_active'],
    ]);
    expect(rows[1]!.session_id).toBe(sessionId);

    expect(await events(oldId)).toEqual(['conversation_closed']);
    expect(await events(newId)).toEqual(['conversation_opened', 'conversation_assigned_bot']);

    const { rows: closedEvent } = await ownerPool.query<{
      payload: { previous_status: string };
      session_id: string;
    }>(
      `select payload, session_id from event where conversation_id = $1 and type = 'conversation_closed'`,
      [oldId],
    );
    expect(closedEvent[0]!.payload.previous_status).toBe('resolved');
    expect(closedEvent[0]!.session_id).toBe(sessionId);
  });

  it('closes an already-closed conversation again, deliberately, with the event to show it', async () => {
    const { workspaceId, playerId, token } = await setup();
    const oldId = await seedConversation({ workspaceId, playerId });
    await setStatus(oldId, 'closed');

    expect((await post(token)).status).toBe(201);
    const { rows } = await ownerPool.query<{ payload: { previous_status: string } }>(
      `select payload from event where conversation_id = $1 and type = 'conversation_closed'`,
      [oldId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.previous_status).toBe('closed');
  });

  it('accepts an unverifiable session_id and stamps the events with null', async () => {
    const { workspaceId, playerId, token } = await setup();
    const oldId = await seedConversation({ workspaceId, playerId });
    await setStatus(oldId, 'resolved');

    const res = await post(token, { session_id: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(201);
    const { rows } = await ownerPool.query<{ session_id: string | null }>(
      `select session_id from event`,
    );
    expect(rows.every((r) => r.session_id === null)).toBe(true);
  });

  it('422s on a malformed session_id', async () => {
    const { token } = await setup();
    expect((await post(token, { session_id: 'not-a-uuid' })).status).toBe(422);
  });

  it('the next message appends to the new conversation and never reopens the closed one', async () => {
    const { workspaceId, playerId, token } = await setup();
    const oldId = await seedConversation({ workspaceId, playerId });
    await setStatus(oldId, 'resolved');

    const newId = (await post(token)).body.conversation_id as string;

    const sent = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'a brand new problem' })
      .expect(200);
    expect(sent.body.conversation_id).toBe(newId);

    const { rows } = await ownerPool.query<{ status: string }>(
      `select status from conversation where id = $1`,
      [oldId],
    );
    expect(rows[0]!.status).toBe('closed');
    const { rows: oldMessages } = await ownerPool.query(
      `select id from message where conversation_id = $1`,
      [oldId],
    );
    expect(oldMessages).toHaveLength(0);
    expect(await events(oldId)).toEqual(['conversation_closed']);
  });

  it('never opens two live conversations under two concurrent taps', async () => {
    const { workspaceId, playerId, token } = await setup();
    const oldId = await seedConversation({ workspaceId, playerId });
    await setStatus(oldId, 'resolved');

    const both = await Promise.all([post(token), post(token)]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);

    const { rows } = await ownerPool.query<{ status: string }>(
      `select status from conversation where player_id = $1 and status <> 'closed'`,
      [playerId],
    );
    expect(rows).toHaveLength(1);
  });
});
