import { createServer } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { agentRoom, playerRoom } from '../src/shared/realtime/rooms.ts';
import {
  closeSocketServer,
  createSocketServer,
  getIo,
} from '../src/shared/realtime/socketServer.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requirePlayerToken } from '../src/shared/middleware/requirePlayerToken.ts';
import { resolutionRouter } from '../src/surface/routers/resolutionRouter.ts';
import { mintToken } from './helpers/app.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requirePlayerToken, resolutionRouter);
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
afterEach(() => vi.restoreAllMocks());

/**
 * Records (room, event) for everything emitted while it is installed. The
 * server here is never listened on, so there is no client to observe a real
 * broadcast — intercepting `to()` is what makes the routing assertable.
 */
function captureEmits() {
  const emits: { room: string; event: string }[] = [];
  vi.spyOn(getIo(), 'to').mockImplementation(
    (room) =>
      ({
        emit: (event: string) => {
          emits.push({ room: String(room), event });
          return true;
        },
      }) as never,
  );
  return emits;
}

async function fixture() {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'p-1',
  });
  return { workspaceId, playerId, token };
}

async function setConfirmPhase(
  conversationId: string,
  phase: 'none' | 'bot_article' | 'agent_ask',
) {
  await ownerPool.query(`update conversation set confirm_phase = $2 where id = $1`, [
    conversationId,
    phase,
  ]);
}

describe('POST /surface/resolution-answer', () => {
  it('resolves an agent_ask on yes', async () => {
    const { workspaceId, playerId, token } = await fixture();
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [
      conversationId,
    ]);
    await setConfirmPhase(conversationId, 'agent_ask');

    const emits = captureEmits();
    const res = await request(app)
      .post('/resolution-answer')
      .set('Authorization', `Bearer ${token}`)
      .send({ helped: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ confirm_phase: 'none', status: 'resolved' });

    // The status change alone left the agent's transcript blank — the resolve
    // has to be visible as an answer in the thread, not only as a badge.
    const { rows } = await ownerPool.query<{ author_type: string; body: string }>(
      `select author_type, body from message where conversation_id = $1 order by seq`,
      [conversationId],
    );
    expect(rows).toEqual([{ author_type: 'player', body: 'Yes, my issue is resolved.' }]);
    expect(emits).toContainEqual({ room: agentRoom(conversationId), event: 'message:new' });
    expect(emits).toContainEqual({ room: playerRoom(conversationId), event: 'message:new' });
  });

  it('posts the decline as a player message and emits it to both rooms on no', async () => {
    const { workspaceId, playerId, token } = await fixture();
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [
      conversationId,
    ]);
    await setConfirmPhase(conversationId, 'agent_ask');
    const emits = captureEmits();

    const res = await request(app)
      .post('/resolution-answer')
      .set('Authorization', `Bearer ${token}`)
      .send({ helped: false });
    expect(res.status).toBe(200);

    const { rows } = await ownerPool.query<{ author_type: string; body: string }>(
      `select author_type, body from message where conversation_id = $1 order by seq`,
      [conversationId],
    );
    expect(rows).toEqual([{ author_type: 'player', body: "No, I'm still having issues." }]);

    // Both transcripts update over the ordinary message path — no separate
    // decline-shaped socket event for either client to learn about.
    expect(emits).toContainEqual({ room: agentRoom(conversationId), event: 'message:new' });
    expect(emits).toContainEqual({ room: playerRoom(conversationId), event: 'message:new' });
  });

  it('409s when no check is outstanding', async () => {
    const { workspaceId, playerId, token } = await fixture();
    await seedConversation({ workspaceId, playerId });

    const res = await request(app)
      .post('/resolution-answer')
      .set('Authorization', `Bearer ${token}`)
      .send({ helped: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('no_check_pending');
  });

  it('404s when the player has no conversation at all', async () => {
    const { token } = await fixture();
    expect(
      (
        await request(app)
          .post('/resolution-answer')
          .set('Authorization', `Bearer ${token}`)
          .send({ helped: true })
      ).status,
    ).toBe(404);
  });

  it('422s when helped is missing', async () => {
    const { token } = await fixture();
    expect(
      (
        await request(app)
          .post('/resolution-answer')
          .set('Authorization', `Bearer ${token}`)
          .send({})
      ).status,
    ).toBe(422);
  });

  it('accepts an unverifiable session_id and stamps the event with null', async () => {
    const { workspaceId, playerId, token } = await fixture();
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [
      conversationId,
    ]);
    await setConfirmPhase(conversationId, 'agent_ask');

    const res = await request(app)
      .post('/resolution-answer')
      .set('Authorization', `Bearer ${token}`)
      .send({ helped: false, session_id: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(200);
    const { rows } = await ownerPool.query(
      `select session_id from event where conversation_id = $1`,
      [conversationId],
    );
    expect(rows[0]?.session_id).toBe(null);
  });
});
