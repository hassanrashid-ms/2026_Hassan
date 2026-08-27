import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { app, mintToken } from './helpers/app.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedBotConfig,
  seedConversation,
  seedForm,
  seedFormAnswer,
  seedFormSubmission,
  seedFormVersion,
  seedPlayer,
  seedSession,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';
import { enqueueBotTurn } from '../src/shared/jobs/botTurns.ts';
import { HANDOFF_PLAYER_MESSAGES } from '../src/domain/bot/messages.ts';
import { incrementPresence, closePresenceRedis } from '../src/shared/realtime/presence.ts';
import { presignPutObject } from '../src/shared/storage/presign.ts';

vi.mock('../src/shared/jobs/botTurns.ts', () => ({
  enqueueBotTurn: vi.fn().mockResolvedValue(undefined),
}));

// This suite's pool runs each test file in an isolated module registry, so the
// realtime singleton getIo() relies on isn't populated by realtime.rooms.test.ts
// running earlier in the same process. Initialise it here — the http server is
// never listened on, so this never accepts real socket connections; it exists
// only so emitMessageToRooms/emitInboxChanged have a Server instance to call.
beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeDb();
  await closeOwnerPool();
  await closePresenceRedis();
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

async function uploadFixtureImage(workspaceId: string, playerId: string) {
  const key = `pending/${workspaceId}/${playerId}/${crypto.randomUUID()}.png`;
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

describe('POST /surface/messages with an attachment', () => {
  it('claims the pending object and inserts an attachment row', async () => {
    const { workspaceId, playerId, token } = await setup();
    const key = await uploadFixtureImage(workspaceId, playerId);

    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        body: '',
        attachment: { key, filename: 'shot.png', mime_type: 'image/png', byte_size: 14 },
      })
      .expect(200);

    expect(res.body.message.body).toBe('shot.png');
    expect(res.body.message.attachment).toMatchObject({
      filename: 'shot.png',
      mime_type: 'image/png',
      byte_size: 14,
    });
  });

  it('422s with attachment_not_found for a bogus key', async () => {
    const { workspaceId, playerId, token } = await setup();
    const bogusKey = `pending/${workspaceId}/${playerId}/${crypto.randomUUID()}.png`;

    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        body: '',
        attachment: { key: bogusKey, filename: 'ghost.png', mime_type: 'image/png', byte_size: 14 },
      })
      .expect(422);
    expect(res.body.error.code).toBe('attachment_not_found');
  });
});

describe('POST /surface/messages answering a form attachment field', () => {
  it('creates a form_answer with the attachment id and does not error', async () => {
    const { workspaceId, playerId, token } = await setup();
    const conversationId = await seedConversation({ workspaceId, playerId });
    const formId = await seedForm({ workspaceId, name: 'Missing Purchase' });
    await seedFormVersion({
      workspaceId,
      formId,
      version: 1,
      fields: [
        {
          key: 'store',
          label: 'Which store?',
          type: 'choice',
          isRequired: true,
          position: 0,
          options: ['Google Play', 'Apple App Store'],
        },
        {
          key: 'proof_of_purchase',
          label: 'Proof of purchase',
          type: 'attachment',
          isRequired: false,
          position: 1,
        },
      ],
      publishedAt: new Date(),
    });
    const submissionId = await seedFormSubmission({
      workspaceId,
      conversationId,
      formId,
      formVersion: 1,
    });
    await seedFormAnswer({
      workspaceId,
      formSubmissionId: submissionId,
      fieldKey: 'store',
      fieldType: 'choice',
      value: 'Google Play',
    });

    const key = await uploadFixtureImage(workspaceId, playerId);
    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        body: '',
        attachment: { key, filename: 'receipt.png', mime_type: 'image/png', byte_size: 14 },
        form_field_key: 'proof_of_purchase',
      })
      .expect(200);

    expect(res.body.message.attachment).toBeTruthy();
    const { rows } = await ownerPool.query(
      `select value from form_answer where field_key = 'proof_of_purchase'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toMatchObject({ attachmentId: expect.any(String) });
  });
});

describe('POST /surface/messages', () => {
  it('creates the conversation on the first message', async () => {
    const { token } = await setup();
    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello' })
      .expect(200);
    expect(res.body.conversation_id).toBeDefined();
    expect(res.body.message).toMatchObject({ author_type: 'player', body: 'hello', seq: 1 });
  });

  it('creates a new conversation at bot_active, not open', async () => {
    const { workspaceId, token } = await setup();
    // Provisioned: this first message resolves to `shouldEnqueue`, which this
    // plan computes but does not act on, so the transaction never touches
    // status again and it stays at the schema default.
    await seedBotConfig({ workspaceId, isProvisioned: true });
    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hi' })
      .expect(200);

    const { rows } = await ownerPool.query(`select status from conversation where id = $1`, [
      res.body.conversation_id,
    ]);
    expect(rows[0].status).toBe('bot_active');
  });

  it('a not-provisioned bot hands off inline: open, assigned, one public system message, no internal note, one bot_unavailable event, no job', async () => {
    const { workspaceId, token } = await setup();
    const availableAgent = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: availableAgent });
    await incrementPresence(availableAgent);
    await seedBotConfig({ workspaceId, isProvisioned: false });

    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hi' })
      .expect(200);

    const conversationId = res.body.conversation_id;

    const { rows: convRows } = await ownerPool.query(
      `select status, assigned_agent_id from conversation where id = $1`,
      [conversationId],
    );
    expect(convRows[0].status).toBe('open');
    expect(convRows[0].assigned_agent_id).toBe(availableAgent);

    const { rows: msgRows } = await ownerPool.query(
      `select author_type, visibility from message where conversation_id = $1 and author_type = 'system'`,
      [conversationId],
    );
    expect(msgRows.length).toBe(1);
    expect(msgRows[0].visibility).toBe('public');

    const { rows: eventRows } = await ownerPool.query(
      `select type, payload from event where conversation_id = $1 and type = 'bot_unavailable'`,
      [conversationId],
    );
    expect(eventRows.length).toBe(1);
    expect(eventRows[0].payload).toEqual({ reason: 'not_provisioned' });

    // Only the player's own message comes back in the response body.
    expect(res.body.message.body).toBe('hi');
  });

  it('rejects an empty body with 422', async () => {
    const { token } = await setup();
    await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: '' })
      .expect(422);
  });

  it('reopens a resolved conversation and appends conversation_reopened', async () => {
    const { workspaceId, playerId, token } = await setup();
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'resolved', assigned_agent_id = null where id = $1`,
      [conversationId],
    );
    const agentRow = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('a1@example.test', 'A1') returning id`,
    );
    await ownerPool.query(`update conversation set assigned_agent_id = $2 where id = $1`, [
      conversationId,
      agentRow.rows[0]!.id,
    ]);

    await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'still here' })
      .expect(200);

    const { rows } = await ownerPool.query<{ status: string; assigned_agent_id: string | null }>(
      `select status, assigned_agent_id from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.status).toBe('open');
    expect(rows[0]!.assigned_agent_id).toBeNull();

    const { rows: events } = await ownerPool.query<{ type: string }>(
      `select type from event where conversation_id = $1 and type = 'conversation_reopened'`,
      [conversationId],
    );
    expect(events).toHaveLength(1);
  });

  it('orders the reopen handoff message after the player message that triggered it', async () => {
    const { workspaceId, playerId, token } = await setup();
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set status = 'resolved' where id = $1`, [
      conversationId,
    ]);

    await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: "I'm still facing issues." })
      .expect(200);

    const { rows } = await ownerPool.query<{ seq: number; author_type: string; body: string }>(
      `select seq, author_type, body from message where conversation_id = $1 order by seq`,
      [conversationId],
    );
    // Support cannot answer before the player has spoken: the handoff line is a
    // response to this message, so it must carry the higher seq.
    expect(rows.map((r) => r.author_type)).toEqual(['player', 'system']);
    expect(rows[0]!.body).toBe("I'm still facing issues.");
    expect(HANDOFF_PLAYER_MESSAGES as readonly string[]).toContain(rows[1]!.body);
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq);
  });

  it('flips awaiting_player back to open, keeps the assignment, and appends conversation_player_replied', async () => {
    const { workspaceId, playerId, token } = await setup();
    const conversationId = await seedConversation({ workspaceId, playerId });
    const agentRow = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('a2@example.test', 'A2') returning id`,
    );
    const agentId = agentRow.rows[0]!.id;
    await ownerPool.query(
      `update conversation set status = 'awaiting_player', assigned_agent_id = $2 where id = $1`,
      [conversationId, agentId],
    );

    await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'here it is' })
      .expect(200);

    const { rows } = await ownerPool.query<{ status: string; assigned_agent_id: string | null }>(
      `select status, assigned_agent_id from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.status).toBe('open');
    // A reply is not a reopen: the agent who asked stays the owner.
    expect(rows[0]!.assigned_agent_id).toBe(agentId);

    const { rows: events } = await ownerPool.query<{ type: string }>(
      `select type from event where conversation_id = $1 order by id`,
      [conversationId],
    );
    expect(events.map((e) => e.type)).toContain('conversation_player_replied');
    expect(events.map((e) => e.type)).not.toContain('conversation_reopened');
  });

  it('leaves a status outside the transition table untouched on a player reply', async () => {
    const { workspaceId, playerId, token } = await setup();
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set status = 'escalated' where id = $1`, [
      conversationId,
    ]);

    await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'any news?' })
      .expect(200);

    const { rows } = await ownerPool.query<{ status: string }>(
      `select status from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.status).toBe('escalated');
  });

  it('enqueues exactly one bot-turn job with id conversationId__seq when the bot is provisioned', async () => {
    const { workspaceId, token } = await setup();
    await seedBotConfig({ workspaceId, isProvisioned: true });

    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello' })
      .expect(200);

    expect(enqueueBotTurn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(enqueueBotTurn).mock.calls[0]![0];
    expect(call.workspaceId).toBe(workspaceId);
    expect(call.conversationId).toBe(res.body.conversation_id);
    // The posted player message's own seq, not just "some number" — a regression
    // to a wrong or zero seq (e.g. always enqueuing seq 1) must fail this.
    expect(call.seq).toBe(res.body.message.seq);

    const { rows } = await ownerPool.query<{ seq: number }>(
      `select seq from message where conversation_id = $1 and author_type = 'player'`,
      [res.body.conversation_id],
    );
    expect(rows).toHaveLength(1);
    expect(call.seq).toBe(rows[0]!.seq);
  });

  it('does not enqueue on the reopen branch', async () => {
    const { workspaceId, playerId, token } = await setup();
    await seedBotConfig({ workspaceId, isProvisioned: true });
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'resolved', assigned_agent_id = null where id = $1`,
      [conversationId],
    );

    await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello again' })
      .expect(200);

    expect(enqueueBotTurn).not.toHaveBeenCalled();
  });

  it('does not enqueue on the awaiting_player -> open branch', async () => {
    const { workspaceId, playerId, token } = await setup();
    await seedBotConfig({ workspaceId, isProvisioned: true });
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set status = 'awaiting_player' where id = $1`, [
      conversationId,
    ]);

    await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'answer' })
      .expect(200);

    expect(enqueueBotTurn).not.toHaveBeenCalled();
  });
});

describe('POST /surface/messages — lifecycle events and session attribution', () => {
  async function eventsFor(conversationId: string) {
    const { rows } = await ownerPool.query<{
      type: string;
      session_id: string | null;
      payload: Record<string, unknown>;
    }>(`select type, session_id, payload from event where conversation_id = $1 order by id`, [
      conversationId,
    ]);
    return rows;
  }

  it('writes conversation_opened and conversation_assigned_bot on the first message, both stamped', async () => {
    const { workspaceId, playerId, token } = await setup();
    const sessionId = await seedSession({ workspaceId, playerId, entryPoint: 'pause_menu' });

    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello', session_id: sessionId })
      .expect(200);

    const events = await eventsFor(res.body.conversation_id);
    const opened = events.find((e) => e.type === 'conversation_opened');
    const assignedBot = events.find((e) => e.type === 'conversation_assigned_bot');
    const messageSent = events.find((e) => e.type === 'message_sent');

    expect(opened).toBeDefined();
    expect(opened!.session_id).toBe(sessionId);
    expect(opened!.payload).toEqual({ entry_point: 'pause_menu' });
    expect(assignedBot).toBeDefined();
    expect(assignedBot!.session_id).toBe(sessionId);
    expect(messageSent!.session_id).toBe(sessionId);
  });

  it('writes neither lifecycle event on the second message', async () => {
    const { workspaceId, playerId, token } = await setup();
    const sessionId = await seedSession({ workspaceId, playerId });

    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'first', session_id: sessionId })
      .expect(200);
    await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'second', session_id: sessionId })
      .expect(200);

    const events = await eventsFor(res.body.conversation_id);
    expect(events.filter((e) => e.type === 'conversation_opened')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'conversation_assigned_bot')).toHaveLength(1);
  });

  it('sets conversation.session_id to the verified request session, not the latest-started one', async () => {
    const { workspaceId, playerId, token } = await setup();
    const olderSessionId = await seedSession({
      workspaceId,
      playerId,
      startedAt: new Date(Date.now() - 60_000),
      entryPoint: 'settings',
    });
    // The newer session is a second live device; the request names the older one.
    await seedSession({ workspaceId, playerId, startedAt: new Date() });

    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello', session_id: olderSessionId })
      .expect(200);

    const { rows } = await ownerPool.query<{ session_id: string | null }>(
      `select session_id from conversation where id = $1`,
      [res.body.conversation_id],
    );
    expect(rows[0]!.session_id).toBe(olderSessionId);
  });

  it('falls back to the latest-started session when the client sends nothing', async () => {
    const { workspaceId, playerId, token } = await setup();
    await seedSession({ workspaceId, playerId, startedAt: new Date(Date.now() - 60_000) });
    const newerSessionId = await seedSession({ workspaceId, playerId, startedAt: new Date() });

    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello' })
      .expect(200);

    const { rows } = await ownerPool.query<{ session_id: string | null }>(
      `select session_id from conversation where id = $1`,
      [res.body.conversation_id],
    );
    expect(rows[0]!.session_id).toBe(newerSessionId);
    const events = await eventsFor(res.body.conversation_id);
    // Unattributed on purpose: no session accompanied the request.
    expect(events.every((e) => e.session_id === null)).toBe(true);
  });

  const unverifiable: [string, () => Promise<string | undefined>][] = [
    ['an unknown session_id', async () => '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['no session_id at all', async () => undefined],
  ];

  for (const [label, value] of unverifiable) {
    it(`still sends the message with ${label}, stamping events null`, async () => {
      const { token } = await setup();
      const sessionId = await value();

      const res = await request(app)
        .post('/surface/messages')
        .set('Authorization', `Bearer ${token}`)
        .send(sessionId ? { body: 'hello', session_id: sessionId } : { body: 'hello' })
        .expect(200);

      expect(res.body.message.body).toBe('hello');
      const events = await eventsFor(res.body.conversation_id);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.session_id === null)).toBe(true);
      const opened = events.find((e) => e.type === 'conversation_opened');
      // An unknown entry point is recorded as unknown, never guessed from
      // another session.
      expect(opened!.payload).toEqual({ entry_point: null });
    });
  }

  it("still sends the message with another player's session_id, stamping events null", async () => {
    const { workspaceId, token } = await setup();
    const otherPlayerId = await seedPlayer(workspaceId);
    const foreignSessionId = await seedSession({ workspaceId, playerId: otherPlayerId });

    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello', session_id: foreignSessionId })
      .expect(200);

    const events = await eventsFor(res.body.conversation_id);
    expect(events.every((e) => e.session_id === null)).toBe(true);
    const { rows } = await ownerPool.query<{ session_id: string | null }>(
      `select session_id from conversation where id = $1`,
      [res.body.conversation_id],
    );
    expect(rows[0]!.session_id).not.toBe(foreignSessionId);
  });

  it('stamps conversation_reopened with the reopening session while conversation.session_id is unchanged', async () => {
    const { workspaceId, playerId, token } = await setup();
    const originatingSessionId = await seedSession({ workspaceId, playerId });
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'resolved', session_id = $2 where id = $1`,
      [conversationId, originatingSessionId],
    );
    const reopeningSessionId = await seedSession({ workspaceId, playerId });

    await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'still here', session_id: reopeningSessionId })
      .expect(200);

    const events = await eventsFor(conversationId);
    const reopened = events.find((e) => e.type === 'conversation_reopened');
    expect(reopened!.session_id).toBe(reopeningSessionId);

    // The row says where it began; the event says where this reopen happened.
    const { rows } = await ownerPool.query<{ session_id: string | null }>(
      `select session_id from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.session_id).toBe(originatingSessionId);
  });

  it('stamps conversation_player_replied with the request session', async () => {
    const { workspaceId, playerId, token } = await setup();
    const sessionId = await seedSession({ workspaceId, playerId });
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set status = 'awaiting_player' where id = $1`, [
      conversationId,
    ]);

    await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'here it is', session_id: sessionId })
      .expect(200);

    const events = await eventsFor(conversationId);
    expect(events.find((e) => e.type === 'conversation_player_replied')!.session_id).toBe(
      sessionId,
    );
  });

  it('leaves bot and system message_sent events unstamped', async () => {
    const { workspaceId, playerId, token } = await setup();
    const sessionId = await seedSession({ workspaceId, playerId });
    await seedWorkspaceMember({ workspaceId, agentId: await seedAgent() });
    await seedBotConfig({ workspaceId, isProvisioned: false });

    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hi', session_id: sessionId })
      .expect(200);

    const { rows } = await ownerPool.query<{
      session_id: string | null;
      payload: { author_type: string };
    }>(
      `select session_id, payload from event where conversation_id = $1 and type = 'message_sent' order by id`,
      [res.body.conversation_id],
    );
    for (const row of rows) {
      expect(row.session_id).toBe(row.payload.author_type === 'player' ? sessionId : null);
    }
    expect(rows.some((r) => r.payload.author_type !== 'player')).toBe(true);
  });
});

describe('GET /surface/messages', () => {
  it('returns conversation_id: null and an empty list when no conversation exists yet', async () => {
    const { token, sessionId } = await setup();
    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: sessionId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({
      conversation_id: null,
      messages: [],
      confirm_phase: 'none',
      form: null,
    });
  });

  it("ignores a session_id that is not the caller's own and returns the caller's own thread", async () => {
    const { workspaceId, playerId, token } = await setup();
    const otherPlayerId = await seedPlayer(workspaceId);
    const otherSessionId = await seedSession({ workspaceId, playerId: otherPlayerId });
    const otherConversationId = await seedConversation({ workspaceId, playerId: otherPlayerId });
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, body) values ($1, $2, 1, 'agent', 'not yours')`,
      [workspaceId, otherConversationId],
    );
    const ownConversationId = await seedConversation({ workspaceId, playerId });

    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: otherSessionId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Isolation is unchanged: the thread is resolved from the token's player
    // under RLS, so a foreign session id cannot name a foreign conversation.
    expect(res.body.conversation_id).toBe(ownConversationId);
    expect(res.body.messages).toEqual([]);
  });

  it('returns 200 and the full thread for a session_id with no row yet', async () => {
    const { workspaceId, playerId, token } = await setup();
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, body) values ($1, $2, 1, 'player', 'hi')`,
      [workspaceId, conversationId],
    );

    // The Outbox case: POST /sdk/sessions/start has not landed yet. History and
    // the conversation_id that drives join_conversation must survive it.
    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.conversation_id).toBe(conversationId);
    expect(res.body.messages).toHaveLength(1);
  });

  it('includes status and no internal-only fields', async () => {
    const { workspaceId, playerId, token, sessionId } = await setup();
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [
      conversationId,
    ]);
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, body) values ($1, $2, 1, 'agent', 'hi')`,
      [workspaceId, conversationId],
    );

    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: sessionId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.status).toBe('open');
    expect(res.body.messages[0]).not.toHaveProperty('visibility');
    expect(res.body.messages[0]).not.toHaveProperty('author_agent_id');
  });

  it('GET /messages reports confirm_phase', async () => {
    const { workspaceId, playerId, token, sessionId } = await setup();
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set confirm_phase = 'agent_ask' where id = $1`, [
      conversationId,
    ]);

    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: sessionId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.confirm_phase).toBe('agent_ask');
  });

  it('GET /messages reports none when the player has no conversation', async () => {
    const { token, sessionId } = await setup();

    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: sessionId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.conversation_id).toBe(null);
    expect(res.body.confirm_phase).toBe('none');
  });

  // A player mid-form: the card is up, the submission is live, and the
  // snapshotted v1 fields are stored out of render order on purpose so the
  // position sort is exercised rather than assumed from insertion order.
  async function liveForm() {
    const base = await setup();
    const conversationId = await seedConversation({
      workspaceId: base.workspaceId,
      playerId: base.playerId,
    });
    await ownerPool.query(`update conversation set confirm_phase = 'form' where id = $1`, [
      conversationId,
    ]);
    const formId = await seedForm({ workspaceId: base.workspaceId, name: 'Missing Purchase' });
    await seedFormVersion({
      workspaceId: base.workspaceId,
      formId,
      version: 1,
      fields: [
        { key: 'proof', label: 'Receipt', type: 'short_text', isRequired: false, position: 2 },
        {
          key: 'store',
          label: 'Which store?',
          type: 'choice',
          isRequired: true,
          position: 0,
          options: ['Google Play', 'Apple App Store'],
        },
        { key: 'quantity', label: 'How many?', type: 'number', isRequired: true, position: 1 },
      ],
      publishedAt: new Date(),
    });
    const submissionId = await seedFormSubmission({
      workspaceId: base.workspaceId,
      conversationId,
      formId,
      formVersion: 1,
    });
    return { ...base, conversationId, formId, submissionId };
  }

  it('returns the resolved form and the answers so far while the card is up', async () => {
    const f = await liveForm();
    await seedFormAnswer({
      workspaceId: f.workspaceId,
      formSubmissionId: f.submissionId,
      fieldKey: 'store',
      fieldType: 'choice',
      value: 'Google Play',
    });

    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: f.sessionId })
      .set('Authorization', `Bearer ${f.token}`)
      .expect(200);

    expect(res.body.confirm_phase).toBe('form');
    expect(res.body.form.submission_id).toBe(f.submissionId);
    expect(res.body.form.form_id).toBe(f.formId);
    expect(res.body.form.form_name).toBe('Missing Purchase');
    expect(res.body.form.version).toBe(1);
    expect(res.body.form.fields.map((x: { key: string }) => x.key)).toEqual([
      'store',
      'quantity',
      'proof',
    ]);
    expect(res.body.form.answers).toEqual([{ field_key: 'store', value: 'Google Play' }]);
  });

  it('returns only the newest answer per field', async () => {
    const f = await liveForm();
    await seedFormAnswer({
      workspaceId: f.workspaceId,
      formSubmissionId: f.submissionId,
      fieldKey: 'store',
      fieldType: 'choice',
      value: 'Google Play',
      createdAt: new Date(Date.now() - 60_000),
    });
    await seedFormAnswer({
      workspaceId: f.workspaceId,
      formSubmissionId: f.submissionId,
      fieldKey: 'store',
      fieldType: 'choice',
      value: 'Apple App Store',
    });

    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: f.sessionId })
      .set('Authorization', `Bearer ${f.token}`)
      .expect(200);

    expect(res.body.form.answers).toEqual([{ field_key: 'store', value: 'Apple App Store' }]);
  });

  it('returns form null when no card is up', async () => {
    const f = await liveForm();
    await ownerPool.query(`update conversation set confirm_phase = 'none' where id = $1`, [
      f.conversationId,
    ]);

    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: f.sessionId })
      .set('Authorization', `Bearer ${f.token}`)
      .expect(200);

    expect(res.body.form).toBeNull();
  });

  // The window between a terminate committing and the phase update being
  // observed: the phase still says 'form' but nothing is live behind it.
  it('returns form null when the phase says form but the submission is finished', async () => {
    const f = await liveForm();
    await ownerPool.query(`update form_submission set status = 'completed' where id = $1`, [
      f.submissionId,
    ]);

    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: f.sessionId })
      .set('Authorization', `Bearer ${f.token}`)
      .expect(200);

    expect(res.body.confirm_phase).toBe('form');
    expect(res.body.form).toBeNull();
  });
});

describe('GET /messages with an attachment', () => {
  it('returns a fetchable presigned url for a public message with an attachment', async () => {
    const { workspaceId, playerId, sessionId, token } = await setup();
    const { rows: convRows } = await ownerPool.query<{ id: string }>(
      `insert into conversation (workspace_id, player_id, session_id, number) values ($1, $2, $3, 1) returning id`,
      [workspaceId, playerId, sessionId],
    );
    const conversationId = convRows[0]!.id;
    const { rows: msgRows } = await ownerPool.query<{ id: string }>(
      `insert into message (workspace_id, conversation_id, seq, author_type, body, visibility)
       values ($1, $2, 1, 'agent', 'diagram.png', 'public') returning id`,
      [workspaceId, conversationId],
    );
    const messageId = msgRows[0]!.id;

    const key = `ws/${workspaceId}/attachments/${crypto.randomUUID()}.png`;
    const body = Buffer.from('fake-png-bytes');
    const { url: putUrl } = await presignPutObject({
      key,
      contentType: 'image/png',
      contentLength: body.length,
    });
    await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.length) },
      body,
    });
    await ownerPool.query(
      `insert into attachment (workspace_id, message_id, storage_key, filename, mime_type, byte_size)
       values ($1, $2, $3, 'diagram.png', 'image/png', $4)`,
      [workspaceId, messageId, key, body.length],
    );

    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: sessionId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const withAttachment = res.body.messages.find((m: { attachment: unknown }) => m.attachment);
    expect(withAttachment.attachment.url).toBeTruthy();
    const getRes = await fetch(withAttachment.attachment.url);
    expect(getRes.status).toBe(200);
  });

  it('never signs an attachment on an internal-visibility message (unreachable via toPlayerView, verified defensively)', async () => {
    const { workspaceId, playerId, sessionId, token } = await setup();
    const { rows: convRows } = await ownerPool.query<{ id: string }>(
      `insert into conversation (workspace_id, player_id, session_id, number) values ($1, $2, $3, 1) returning id`,
      [workspaceId, playerId, sessionId],
    );
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, body, visibility)
       values ($1, $2, 1, 'agent', 'internal note', 'internal')`,
      [workspaceId, convRows[0]!.id],
    );

    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: sessionId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.messages).toHaveLength(0);
  });
});

describe('POST /surface/messages/read', () => {
  it('marks agent-authored messages up to seq as read', async () => {
    const { workspaceId, playerId, token } = await setup();
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, body) values ($1, $2, 1, 'agent', 'hi')`,
      [workspaceId, conversationId],
    );
    await request(app)
      .post('/surface/messages/read')
      .set('Authorization', `Bearer ${token}`)
      .send({ up_to_seq: 1 })
      .expect(200);

    const { rows } = await ownerPool.query<{ delivery_state: string }>(
      `select delivery_state from message where conversation_id = $1 and seq = 1`,
      [conversationId],
    );
    expect(rows[0]!.delivery_state).toBe('read');
  });

  it('marks the latest conversation, not an older one the player also owns', async () => {
    const { workspaceId, playerId, token } = await setup();
    const older = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'closed', created_at = now() - interval '1 day' where id = $1`,
      [older],
    );
    const latest = await seedConversation({ workspaceId, playerId });

    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, body)
       values ($1, $2, 1, 'agent', 'in the old thread'), ($1, $3, 1, 'agent', 'in the live thread')`,
      [workspaceId, older, latest],
    );

    await request(app)
      .post('/surface/messages/read')
      .set('Authorization', `Bearer ${token}`)
      .send({ up_to_seq: 1 })
      .expect(200);

    const state = async (conversationId: string) => {
      const { rows } = await ownerPool.query<{ delivery_state: string }>(
        `select delivery_state from message where conversation_id = $1 and seq = 1`,
        [conversationId],
      );
      return rows[0]!.delivery_state;
    };
    // Once a player opens a second ticket the unordered lookup this replaced
    // could pick either row, and picking the closed one meant the agent's live
    // thread never showed a read receipt.
    expect(await state(latest)).toBe('read');
    expect(await state(older)).toBe('sent');
  });
});

describe('POST /surface/messages/read records when the player saw it', () => {
  it("stamps read_at on agent messages and leaves the player's own untouched", async () => {
    const { workspaceId, playerId, token } = await setup();
    const conversationId = await seedConversation({ workspaceId, playerId });
    const agentRow = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('r1@example.test', 'R1') returning id`,
    );
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, author_agent_id, body)
       values ($1, $2, 1, 'agent', $3, 'from the agent'), ($1, $2, 2, 'player', null, 'from the player')`,
      [workspaceId, conversationId, agentRow.rows[0]!.id],
    );

    await request(app)
      .post('/surface/messages/read')
      .set('Authorization', `Bearer ${token}`)
      .send({ up_to_seq: 2 })
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
    // The player reading their own message is not a receipt.
    expect(rows[1]).toMatchObject({ seq: 2, delivery_state: 'sent' });
    expect(rows[1]!.read_at).toBeNull();
  });

  it('never moves read_at forward on a second read of the same message', async () => {
    const { workspaceId, playerId, token } = await setup();
    const conversationId = await seedConversation({ workspaceId, playerId });
    const agentRow = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('r2@example.test', 'R2') returning id`,
    );
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, author_agent_id, body)
       values ($1, $2, 1, 'agent', $3, 'first')`,
      [workspaceId, conversationId, agentRow.rows[0]!.id],
    );

    const read = () =>
      request(app)
        .post('/surface/messages/read')
        .set('Authorization', `Bearer ${token}`)
        .send({ up_to_seq: 1 })
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
