import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Test as SupertestTest } from 'supertest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { verifyPlayerToken } from '../src/shared/auth/playerToken.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import {
  generateWorkspaceSecret,
  parseWorkspaceSecret,
} from '../src/shared/auth/workspaceSecret.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { app, mintToken } from './helpers/app.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedMessage,
  seedPlayer,
  seedSession,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

const B_SESSION = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

type Tenant = { workspaceId: string; playerId: string; token: string; slug: string };

async function tenant(slug: string): Promise<Tenant> {
  const workspaceId = await seedWorkspace({ slug });
  const playerId = await seedPlayer(workspaceId, 'UserId7661');
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'UserId7661',
  });
  return { workspaceId, playerId, token, slug };
}

type RowCounts = {
  session: number;
  player_state_snapshot: number;
  event: number;
  conversation: number;
  message: number;
};

async function rowCounts(): Promise<RowCounts> {
  const tables = ['session', 'player_state_snapshot', 'event', 'conversation', 'message'] as const;
  const counts = {} as RowCounts;
  for (const table of tables) {
    const { rows } = await ownerPool.query<{ n: number }>(
      `select count(*)::int as n from ${table}`,
    );
    counts[table] = rows[0]!.n;
  }
  return counts;
}

let a: Tenant;
let b: Tenant;

// POST /surface/messages calls getIo() after its transaction commits, so this
// file's own process needs a live Socket.io instance — same pattern as
// surface.messages.test.ts and agent.messages.test.ts.
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
  a = await tenant('game-a');
  b = await tenant('game-b');
  // Workspace B owns a session, a conversation and an unread agent message.
  await seedSession({ workspaceId: b.workspaceId, playerId: b.playerId, id: B_SESSION });
  const conversationId = await seedConversation({
    workspaceId: b.workspaceId,
    playerId: b.playerId,
    sessionId: B_SESSION,
  });
  await seedMessage({ workspaceId: b.workspaceId, conversationId, seq: 1, authorType: 'agent' });
});

const withA = (req: SupertestTest) =>
  req.set('Authorization', `Bearer ${a.token}`).set('X-Support-Workspace', a.slug);

describe('workspace A cannot reach workspace B', () => {
  it('POST /sdk/sessions/start with B session id writes nothing anywhere but an incident', async () => {
    const before = await rowCounts();
    await withA(request(app).post('/sdk/sessions/start'))
      .send({ session_id: B_SESSION, entry_point: 'settings_menu', snapshot: { platform: 'ios' } })
      .expect(200);
    const after = await rowCounts();

    expect(after.session).toBe(before.session);
    expect(after.player_state_snapshot).toBe(before.player_state_snapshot);
    // The only new row is A's own sdk_incident.
    expect(after.event).toBe(before.event + 1);
  });

  it('POST /sdk/sessions/end with B session id does not end it', async () => {
    await withA(request(app).post('/sdk/sessions/end')).send({ session_id: B_SESSION }).expect(200);
    const { rows } = await ownerPool.query<{ ended_at: Date | null }>(
      `select ended_at from session where id = $1`,
      [B_SESSION],
    );
    expect(rows[0]!.ended_at).toBeNull();
  });

  it('POST /sdk/incidents with B session id stores no cross-tenant foreign key', async () => {
    await withA(request(app).post('/sdk/incidents'))
      .send({ session_id: B_SESSION, kind: 'token_timeout' })
      .expect(200);
    const { rows } = await ownerPool.query<{ workspace_id: string; session_id: string | null }>(
      `select workspace_id, session_id from event where type = 'sdk_incident'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspace_id).toBe(a.workspaceId);
    expect(rows[0]!.session_id).toBeNull();
  });

  it('GET /sdk/unread never counts B messages', async () => {
    const res = await withA(request(app).get('/sdk/unread')).expect(200);
    expect(res.body).toEqual({ unread_count: 0 });
  });

  it('GET /surface/bootstrap on a B session is 404, not 403', async () => {
    const res = await request(app)
      .get('/surface/bootstrap')
      .query({ session_id: B_SESSION })
      .set('Authorization', `Bearer ${a.token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('POST /surface/events/article_read on a B session is 404 and writes nothing', async () => {
    const before = await rowCounts();
    await request(app)
      .post('/surface/events/article_read')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ session_id: B_SESSION, article_id: 'a_123' })
      .expect(404);
    expect((await rowCounts()).event).toBe(before.event);
  });

  it('cannot mint a B token with A real secret', async () => {
    // Give both workspaces genuine secrets, then present A's against B's slug.
    const aSecret = generateWorkspaceSecret('game-a');
    const bSecret = generateWorkspaceSecret('game-b');
    await ownerPool.query(
      `insert into workspace_secret (workspace_id, secret_hash) values ($1, $2)`,
      [a.workspaceId, aSecret.secretHash],
    );
    await ownerPool.query(
      `insert into workspace_secret (workspace_id, secret_hash) values ($1, $2)`,
      [b.workspaceId, bSecret.secretHash],
    );

    // A's random half under B's slug: the slug resolves, the hash does not match.
    const { raw } = parseWorkspaceSecret(aSecret.secret)!;
    await request(app)
      .post('/auth/player-token')
      .set('Authorization', `Bearer sk_game-b.${raw}`)
      .send({ external_player_id: 'UserId7661' })
      .expect(401);

    // A's own secret still works, so the 401 above was the cross-check and not a
    // broken fixture.
    const ok = await request(app)
      .post('/auth/player-token')
      .set('Authorization', `Bearer ${aSecret.secret}`)
      .send({ external_player_id: 'UserId7661' })
      .expect(200);
    const claims = await verifyPlayerToken(ok.body.token);
    expect(claims.workspace_id).toBe(a.workspaceId);
  });

  it('every attempt above leaves B session count at one', async () => {
    // Guards against a handler that writes into B while still returning the right
    // status. beforeEach seeds exactly one B session; nothing in this file may add
    // or remove one.
    const { rows } = await ownerPool.query<{ n: number }>(
      `select count(*)::int as n from session where workspace_id = $1`,
      [b.workspaceId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("POST /surface/messages never lets A read or write into B's conversation", async () => {
    // A's own POST only ever touches A's own (auto-created) conversation — there
    // is no conversation_id in the request body for A to target B's with.
    const before = await rowCounts();
    await withA(request(app).post('/surface/messages')).send({ body: 'hello' }).expect(200);
    const after = await rowCounts();
    expect(after.conversation).toBe(before.conversation + 1);
    // A's workspace has no bot_config row, so the new conversation's first
    // message resolves as not-provisioned and hands off inline: the player's
    // own message plus the public system handoff message land in the same
    // transaction.
    expect(after.message).toBe(before.message + 2);
  });

  it("POST /surface/messages with B's session_id writes no cross-tenant foreign key", async () => {
    const before = await rowCounts();
    await withA(request(app).post('/surface/messages'))
      .send({ body: 'hello', session_id: B_SESSION })
      .expect(200);
    const after = await rowCounts();

    // The send still succeeds — an unverifiable session degrades to a null
    // stamp, it never fails a player's message.
    expect(after.conversation).toBe(before.conversation + 1);
    expect(after.session).toBe(before.session);

    const { rows } = await ownerPool.query<{ n: number }>(
      `select count(*)::int as n from event where session_id = $1 or conversation_id in
         (select id from conversation where session_id = $1 and workspace_id = $2)`,
      [B_SESSION, a.workspaceId],
    );
    expect(rows[0]!.n).toBe(0);

    const { rows: convRows } = await ownerPool.query<{ n: number }>(
      `select count(*)::int as n from conversation where workspace_id = $1 and session_id is not null`,
      [a.workspaceId],
    );
    expect(convRows[0]!.n).toBe(0);
  });

  it("GET /surface/messages with B's session_id returns A's own thread, never B's", async () => {
    const conversationId = await seedConversation({
      workspaceId: a.workspaceId,
      playerId: a.playerId,
    });
    const res = await withA(request(app).get('/surface/messages'))
      .query({ session_id: B_SESSION })
      .expect(200);

    expect(res.body.conversation_id).toBe(conversationId);
    expect(res.body.messages).toEqual([]);
  });

  it("GET /agent/conversations/:id/messages on B's conversation is 404 for an A agent", async () => {
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('a-agent@example.test', 'A Agent') returning id`,
    );
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
      [a.workspaceId, rows[0]!.id],
    );
    const bConversation = await seedConversation({
      workspaceId: b.workspaceId,
      playerId: b.playerId,
    });
    const agentToken = await signAgentSession({ agent_id: rows[0]!.id });

    await request(app)
      .get(`/agent/conversations/${bConversation}/messages`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('X-Workspace-Id', a.workspaceId)
      .expect(404);
  });

  it("POST /agent/conversations/:id/claim on B's conversation is a no-op false claim for an A agent", async () => {
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('a-agent2@example.test', 'A Agent 2') returning id`,
    );
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
      [a.workspaceId, rows[0]!.id],
    );
    const bConversation = await seedConversation({
      workspaceId: b.workspaceId,
      playerId: b.playerId,
    });
    const agentToken = await signAgentSession({ agent_id: rows[0]!.id });

    const res = await request(app)
      .post(`/agent/conversations/${bConversation}/claim`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('X-Workspace-Id', a.workspaceId)
      .expect(200);
    expect(res.body).toEqual({ claimed: false });

    const { rows: check } = await ownerPool.query<{ assigned_agent_id: string | null }>(
      `select assigned_agent_id from conversation where id = $1`,
      [bConversation],
    );
    expect(check[0]!.assigned_agent_id).toBeNull();
  });

  it("POST /agent/messages targeting B's conversation is 404 for an A agent, and writes nothing", async () => {
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('a-agent3@example.test', 'A Agent 3') returning id`,
    );
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
      [a.workspaceId, rows[0]!.id],
    );
    const bConversation = await seedConversation({
      workspaceId: b.workspaceId,
      playerId: b.playerId,
    });
    const agentToken = await signAgentSession({ agent_id: rows[0]!.id });

    const before = await rowCounts();
    await request(app)
      .post('/agent/messages')
      .set('Authorization', `Bearer ${agentToken}`)
      .set('X-Workspace-Id', a.workspaceId)
      .send({ conversation_id: bConversation, body: 'leak attempt' })
      .expect(404);
    expect((await rowCounts()).message).toBe(before.message);
  });
});
