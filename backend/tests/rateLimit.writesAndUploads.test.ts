import { afterAll, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { app, mintToken } from './helpers/app.ts';
import { closeDb } from '../src/shared/db/client.ts';
import {
  closeOwnerPool,
  seedPlayer,
  seedSession,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';
import { closeRateLimitRedis } from '../src/shared/rateLimit/rateLimitRedis.ts';

afterAll(async () => {
  await closeRateLimitRedis();
  await closeDb();
  await closeOwnerPool();
});

async function authedPlayer() {
  const slug = 'ws-writes-uploads';
  const workspaceId = await seedWorkspace({ slug });
  const playerId = await seedPlayer(workspaceId);
  await seedSession({ workspaceId, playerId });
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'p1',
  });
  return { token, slug };
}

describe('writes and sessionsUploads tier overrides', () => {
  it('applies the writes tier to POST /surface/messages', async () => {
    await truncateAll();
    const { token } = await authedPlayer();
    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hi' });
    expect(res.headers['ratelimit']).toMatch(/^limit=30,/);
  });

  it('applies the writes tier to POST /surface/new-ticket', async () => {
    await truncateAll();
    const { token } = await authedPlayer();
    const res = await request(app)
      .post('/surface/new-ticket')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.headers['ratelimit']).toMatch(/^limit=30,/);
  });

  it('applies the sessionsUploads tier to POST /sdk/sessions/start', async () => {
    await truncateAll();
    const { token, slug } = await authedPlayer();
    const res = await request(app)
      .post('/sdk/sessions/start')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Support-Workspace', slug)
      .send({});
    expect(res.headers['ratelimit']).toMatch(/^limit=10,/);
  });

  it('applies the sessionsUploads tier to POST /surface/uploads', async () => {
    await truncateAll();
    const { token } = await authedPlayer();
    const res = await request(app)
      .post('/surface/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.headers['ratelimit']).toMatch(/^limit=10,/);
  });
});
