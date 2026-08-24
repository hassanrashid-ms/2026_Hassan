import { randomUUID } from 'node:crypto';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { presenceRouter } from '../src/agent/routers/presenceRouter.ts';
import {
  decrementPresence,
  getPresenceStatus,
  incrementPresence,
  closePresenceRedis,
} from '../src/shared/realtime/presence.ts';
import { connectClient, startRealtimeServer } from './helpers/realtime.ts';
import { closeOwnerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requireAgentSession, presenceRouter);
app.use(errorMiddleware);

// One real, listening socket server for the whole file — reused by both the
// plain REST tests (which only need getIo() to not throw) and the real-socket
// describe block at the bottom, rather than nesting a second
// createSocketServer inside the first (module-level ioInstance is a
// singleton; nesting would silently replace it mid-file).
let realtime: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeAll(async () => {
  realtime = await startRealtimeServer();
});

afterAll(async () => {
  await realtime.close();
  await closePresenceRedis();
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function tokenFor(agentId: string, workspaceId: string): Promise<string> {
  return signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
}

function waitFor(socket: ReturnType<typeof connectClient>, event: string): Promise<unknown> {
  return new Promise((resolve) => socket.on(event, resolve));
}

describe('presence helper — connect/disconnect counter arithmetic', () => {
  it('first connect sets online, extra connects do not re-announce', async () => {
    const agentId = randomUUID();
    const first = await incrementPresence(agentId);
    expect(first.wasFirstConnection).toBe(true);
    expect(await getPresenceStatus(agentId)).toBe('online');

    const second = await incrementPresence(agentId);
    expect(second.wasFirstConnection).toBe(false);
  });

  it('disconnecting one of two connections keeps the agent online, the last flips it offline', async () => {
    const agentId = randomUUID();
    await incrementPresence(agentId);
    await incrementPresence(agentId);

    const firstDisconnect = await decrementPresence(agentId);
    expect(firstDisconnect.wasLastConnection).toBe(false);
    expect(await getPresenceStatus(agentId)).toBe('online');

    const secondDisconnect = await decrementPresence(agentId);
    expect(secondDisconnect.wasLastConnection).toBe(true);
    expect(await getPresenceStatus(agentId)).toBe('offline');
  });

  it('a stray extra disconnect clamps the counter at 0 rather than going negative', async () => {
    const agentId = randomUUID();
    await incrementPresence(agentId);
    await decrementPresence(agentId);
    const strayDisconnect = await decrementPresence(agentId);
    expect(strayDisconnect.wasLastConnection).toBe(true);
    expect(await getPresenceStatus(agentId)).toBe('offline');

    // A fresh connect after the stray decrement must still read as the first
    // connection (counter was clamped to 0, not left negative).
    const reconnect = await incrementPresence(agentId);
    expect(reconnect.wasFirstConnection).toBe(true);
  });
});

describe('GET /agent/presence', () => {
  it('returns offline with no open connection', async () => {
    const agentId = randomUUID();
    const workspaceId = await seedWorkspace();
    const token = await tokenFor(agentId, workspaceId);

    const res = await request(app)
      .get('/presence')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({ status: 'offline' });
  });

  it('returns online once a connection is open', async () => {
    const agentId = randomUUID();
    const workspaceId = await seedWorkspace();
    const token = await tokenFor(agentId, workspaceId);
    await incrementPresence(agentId);

    const res = await request(app)
      .get('/presence')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({ status: 'online' });
  });
});

describe('PATCH /agent/presence', () => {
  it('400s on an unrecognized status', async () => {
    const agentId = randomUUID();
    const workspaceId = await seedWorkspace();
    const token = await tokenFor(agentId, workspaceId);
    await incrementPresence(agentId);

    const res = await request(app)
      .patch('/presence')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'busy' })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('409s when the caller has no open connection', async () => {
    const agentId = randomUUID();
    const workspaceId = await seedWorkspace();
    const token = await tokenFor(agentId, workspaceId);

    const res = await request(app)
      .patch('/presence')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'away' })
      .expect(409);
    expect(res.body.error.code).toBe('not_connected');
  });

  it('200s and persists the status when connected', async () => {
    const agentId = randomUUID();
    const workspaceId = await seedWorkspace();
    const token = await tokenFor(agentId, workspaceId);
    await incrementPresence(agentId);

    const res = await request(app)
      .patch('/presence')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'away' })
      .expect(200);
    expect(res.body).toEqual({ status: 'away' });
    expect(await getPresenceStatus(agentId)).toBe('away');
  });
});

describe('presence over the real socket connection', () => {
  it('emits presence_changed online on first connect and offline on last disconnect', async () => {
    const agentId = randomUUID();
    const workspaceId = await seedWorkspace();
    const token = await tokenFor(agentId, workspaceId);

    const observerToken = await tokenFor(randomUUID(), workspaceId);
    const observer = connectClient(realtime.url, { token: observerToken, role: 'agent' });
    await waitFor(observer, 'connect');
    // The connect handler's own presence broadcast (for the observer's own
    // agent id) resolves asynchronously after the client-side 'connect'
    // event — wait it out before attaching the listener so it isn't mistaken
    // for the test agent's event below.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const events: Array<{ agentId: string; status: string }> = [];
    observer.on('presence_changed', (payload: { agentId: string; status: string }) => {
      if (payload.agentId === agentId) events.push(payload);
    });

    const agentSocket = connectClient(realtime.url, { token, role: 'agent' });
    await waitFor(agentSocket, 'connect');
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(events).toEqual([{ agentId, status: 'online' }]);

    agentSocket.close();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(events).toEqual([
      { agentId, status: 'online' },
      { agentId, status: 'offline' },
    ]);

    observer.close();
    // Let the server finish processing this disconnect (its own decrementPresence
    // + emit) before the file's afterAll tears down the socket/Redis connections —
    // otherwise that fire-and-forget emit can land on an already-closed Redis
    // client and surface as an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
});
