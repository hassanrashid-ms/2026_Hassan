import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import {
  getPlayerStateView,
  getTicketHistory,
} from '../src/agent/services/conversationContextService.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedDeclaredFields,
  seedIntent,
  seedPlayer,
  seedSession,
  seedSubintent,
  seedWorkspace,
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
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

async function setupAgent(workspaceId: string) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Agent One') returning id`,
    [`a-${workspaceId.slice(0, 8)}@example.test`],
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  );
  const token = await signAgentSession({ agent_id: agentId });
  return { agentId, token };
}

beforeEach(truncateAll);

async function seedSnapshot(args: {
  workspaceId: string;
  sessionId: string;
  declared?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  isMissing?: boolean;
  degradedReason?: string | null;
  capturedAt?: Date;
}): Promise<void> {
  await ownerPool.query(
    `insert into player_state_snapshot (id, workspace_id, session_id, declared, raw, is_missing, degraded_reason, captured_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      args.workspaceId,
      args.sessionId,
      JSON.stringify(args.declared ?? {}),
      JSON.stringify(args.raw ?? {}),
      args.isMissing ?? false,
      args.degradedReason ?? null,
      args.capturedAt ?? new Date('2026-08-17T10:00:00Z'),
    ],
  );
}

describe('getPlayerStateView', () => {
  it('reports no_session when the conversation carries no session', async () => {
    const workspaceId = await seedWorkspace();
    const view = await withWorkspace(workspaceId, (tx) =>
      getPlayerStateView(tx, workspaceId, null),
    );
    expect(view).toEqual({ status: 'no_session' });
  });

  it('reports not_captured when the session exists but wrote no snapshot', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const sessionId = await seedSession({ workspaceId, playerId });
    const view = await withWorkspace(workspaceId, (tx) =>
      getPlayerStateView(tx, workspaceId, sessionId),
    );
    expect(view).toEqual({ status: 'not_captured' });
  });

  it('reports missing when the snapshot says the provider returned nothing usable', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const sessionId = await seedSession({ workspaceId, playerId });
    await seedSnapshot({ workspaceId, sessionId, isMissing: true });
    const view = await withWorkspace(workspaceId, (tx) =>
      getPlayerStateView(tx, workspaceId, sessionId),
    );
    expect(view).toEqual({ status: 'missing' });
  });

  it('labels and orders declared fields by joining declared_field', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const sessionId = await seedSession({ workspaceId, playerId });
    await seedDeclaredFields(workspaceId, ['player_level', 'platform']);
    await seedSnapshot({
      workspaceId,
      sessionId,
      declared: { platform: 'ios', player_level: 42 },
      raw: { fps: 58 },
    });

    const view = await withWorkspace(workspaceId, (tx) =>
      getPlayerStateView(tx, workspaceId, sessionId),
    );
    if (view.status !== 'captured') throw new Error(`expected captured, got ${view.status}`);

    expect(view.declared.map((f) => f.key)).toEqual(['player_level', 'platform']);
    expect(view.declared[0]).toEqual({
      key: 'player_level',
      label: 'player_level',
      type: 'string',
      value: 42,
    });
    expect(view.raw).toEqual({ fps: 58 });
    expect(view.degraded_reason).toBeNull();
    expect(view.captured_at).toBe('2026-08-17T10:00:00.000Z');
  });

  it('appends a declared key with no declared_field row rather than dropping it', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const sessionId = await seedSession({ workspaceId, playerId });
    await seedDeclaredFields(workspaceId, ['platform']);
    await seedSnapshot({
      workspaceId,
      sessionId,
      declared: { orphan_key: 'x', platform: 'android' },
    });

    const view = await withWorkspace(workspaceId, (tx) =>
      getPlayerStateView(tx, workspaceId, sessionId),
    );
    if (view.status !== 'captured') throw new Error(`expected captured, got ${view.status}`);

    expect(view.declared.map((f) => f.key)).toEqual(['platform', 'orphan_key']);
    expect(view.declared[1]).toEqual({
      key: 'orphan_key',
      label: 'orphan_key',
      type: 'string',
      value: 'x',
    });
  });

  it('surfaces degraded_reason on a captured snapshot', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const sessionId = await seedSession({ workspaceId, playerId });
    await seedSnapshot({ workspaceId, sessionId, degradedReason: 'provider threw on total_spend' });

    const view = await withWorkspace(workspaceId, (tx) =>
      getPlayerStateView(tx, workspaceId, sessionId),
    );
    if (view.status !== 'captured') throw new Error(`expected captured, got ${view.status}`);
    expect(view.degraded_reason).toBe('provider threw on total_spend');
  });

  it('does not fall back to another session snapshot', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const thisSession = await seedSession({
      workspaceId,
      playerId,
      startedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const laterSession = await seedSession({
      workspaceId,
      playerId,
      startedAt: new Date('2026-06-01T00:00:00Z'),
    });
    await seedSnapshot({ workspaceId, sessionId: laterSession, declared: { player_level: 99 } });

    const view = await withWorkspace(workspaceId, (tx) =>
      getPlayerStateView(tx, workspaceId, thisSession),
    );
    expect(view).toEqual({ status: 'not_captured' });
  });
});

async function seedReopen(
  workspaceId: string,
  conversationId: string,
  times: number,
): Promise<void> {
  for (let i = 0; i < times; i++) {
    await ownerPool.query(
      `insert into event (workspace_id, type, conversation_id, actor_type) values ($1, 'conversation_reopened', $2, 'player')`,
      [workspaceId, conversationId],
    );
  }
}

describe('getTicketHistory', () => {
  it('includes the current conversation and orders newest first', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const older = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const newer = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    const current = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-03-01T00:00:00Z'),
    });

    const result = await withWorkspace(workspaceId, (tx) =>
      getTicketHistory(tx, { playerId, currentConversationId: current }),
    );

    expect(result.tickets.map((t) => t.id)).toEqual([current, newer, older]);
    expect(result.totalTickets).toBe(2);
  });

  it('returns the current conversation alone when it is the only ticket', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const current = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-03-01T00:00:00Z'),
    });

    const result = await withWorkspace(workspaceId, (tx) =>
      getTicketHistory(tx, { playerId, currentConversationId: current }),
    );

    expect(result.tickets.map((t) => t.id)).toEqual([current]);
    expect(result.totalTickets).toBe(0);
  });

  it('numbers each ticket and carries its status', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const first = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const current = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    await ownerPool.query(`update conversation set status = 'closed' where id = $1`, [first]);

    const result = await withWorkspace(workspaceId, (tx) =>
      getTicketHistory(tx, { playerId, currentConversationId: current }),
    );

    expect(result.tickets[1]).toMatchObject({ id: first, number: 1, status: 'closed' });
    expect(typeof result.tickets[1]!.created_at).toBe('string');
  });

  it('counts reopen events per ticket and totals them', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const a = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const b = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    const current = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-03-01T00:00:00Z'),
    });
    await seedReopen(workspaceId, a, 2);
    await seedReopen(workspaceId, b, 1);
    await seedReopen(workspaceId, current, 5); // shown on its own row, never in the total

    const result = await withWorkspace(workspaceId, (tx) =>
      getTicketHistory(tx, { playerId, currentConversationId: current }),
    );

    const byId = new Map(result.tickets.map((t) => [t.id, t.reopen_count]));
    expect(byId.get(a)).toBe(2);
    expect(byId.get(b)).toBe(1);
    expect(byId.get(current)).toBe(5);
    expect(result.totalReopened).toBe(3);
  });

  it('reports zero reopens for a ticket with no events', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const a = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const current = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });

    const result = await withWorkspace(workspaceId, (tx) =>
      getTicketHistory(tx, { playerId, currentConversationId: current }),
    );

    expect(result.tickets.find((t) => t.id === a)!.reopen_count).toBe(0);
    expect(result.totalReopened).toBe(0);
  });

  it('caps the list at 20 rows including the current one, while total_tickets holds the true count', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    for (let i = 0; i < 25; i++) {
      await seedConversation({
        workspaceId,
        playerId,
        createdAt: new Date(Date.UTC(2026, 0, i + 1)),
      });
    }
    const current = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-06-01T00:00:00Z'),
    });

    const result = await withWorkspace(workspaceId, (tx) =>
      getTicketHistory(tx, { playerId, currentConversationId: current }),
    );

    expect(result.tickets).toHaveLength(20);
    expect(result.totalTickets).toBe(25);
    expect(result.tickets[0]!.id).toBe(current);
    expect(result.tickets[0]!.number).toBe(26);
    expect(result.tickets[1]!.number).toBe(25);
  });

  it('names the intent and subintent when a past ticket was classified', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const intentId = await seedIntent(workspaceId, 'Account');
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Lost progress' });
    const past = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const current = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    await ownerPool.query(`update conversation set subintent_id = $1 where id = $2`, [
      subintentId,
      past,
    ]);

    const result = await withWorkspace(workspaceId, (tx) =>
      getTicketHistory(tx, { playerId, currentConversationId: current }),
    );

    expect(result.tickets[1]!.subintent).toEqual({
      subintent_id: subintentId,
      intent_name: 'Account',
      subintent_name: 'Lost progress',
    });
  });

  it('does not reach across workspaces', async () => {
    const wsA = await seedWorkspace();
    const wsB = await seedWorkspace();
    const playerA = await seedPlayer(wsA, 'shared-external-id');
    const playerB = await seedPlayer(wsB, 'shared-external-id');
    await seedConversation({
      workspaceId: wsB,
      playerId: playerB,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const current = await seedConversation({ workspaceId: wsA, playerId: playerA });

    const result = await withWorkspace(wsA, (tx) =>
      getTicketHistory(tx, { playerId: playerA, currentConversationId: current }),
    );

    expect(result.tickets.map((t) => t.id)).toEqual([current]);
    expect(result.totalTickets).toBe(0);
  });
});

describe('GET /agent/conversations/:id/context', () => {
  it('returns player state, tickets and summary in one payload', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    await ownerPool.query(`update player set first_seen_at = $1 where id = $2`, [
      new Date('2025-11-02T08:30:00Z'),
      playerId,
    ]);
    const sessionId = await seedSession({ workspaceId, playerId });
    await seedDeclaredFields(workspaceId, ['player_level']);
    await seedSnapshot({
      workspaceId,
      sessionId,
      declared: { player_level: 42 },
      raw: { fps: 58 },
    });

    const past = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await seedReopen(workspaceId, past, 2);
    const current = await seedConversation({
      workspaceId,
      playerId,
      sessionId,
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${current}/context`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.player_state.status).toBe('captured');
    expect(res.body.player_state.declared[0]).toMatchObject({ key: 'player_level', value: 42 });
    expect(res.body.player_state.raw).toEqual({ fps: 58 });
    expect(res.body.tickets).toHaveLength(2);
    expect(res.body.tickets[0]).toMatchObject({ id: current });
    expect(res.body.tickets[1]).toMatchObject({ id: past, reopen_count: 2 });
    expect(res.body.summary).toEqual({
      total_tickets: 1,
      total_reopened: 2,
      first_contact_at: '2025-11-02T08:30:00.000Z',
    });
  });

  it('returns 200 with no_session when the conversation has no session', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const current = await seedConversation({ workspaceId, playerId });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${current}/context`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.player_state).toEqual({ status: 'no_session' });
    expect(res.body.tickets.map((t: { id: string }) => t.id)).toEqual([current]);
    expect(res.body.summary.total_tickets).toBe(0);
  });

  it('returns 200 with missing when the provider returned nothing usable', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const sessionId = await seedSession({ workspaceId, playerId });
    await seedSnapshot({ workspaceId, sessionId, isMissing: true });
    const current = await seedConversation({ workspaceId, playerId, sessionId });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${current}/context`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.player_state).toEqual({ status: 'missing' });
  });

  it('returns 200 with not_captured when the session wrote no snapshot', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const sessionId = await seedSession({ workspaceId, playerId });
    const current = await seedConversation({ workspaceId, playerId, sessionId });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${current}/context`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.player_state).toEqual({ status: 'not_captured' });
  });

  it('returns 404 for a conversation in another workspace', async () => {
    const mine = await seedWorkspace();
    const theirs = await seedWorkspace();
    const theirPlayer = await seedPlayer(theirs);
    const theirConversation = await seedConversation({
      workspaceId: theirs,
      playerId: theirPlayer,
    });
    const { token } = await setupAgent(mine);

    await request(app)
      .get(`/conversations/${theirConversation}/context`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', mine)
      .expect(404);
  });

  it('returns 422 for an id that is not a uuid', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAgent(workspaceId);
    await request(app)
      .get('/conversations/not-a-uuid/context')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(422);
  });
});
