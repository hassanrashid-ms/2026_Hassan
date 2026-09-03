import { afterAll, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { app, mintToken } from './helpers/app.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeOwnerPool, seedPlayer, seedSession, seedWorkspace, truncateAll } from './helpers/db.ts';
import { closeRateLimitRedis } from '../src/shared/rateLimit/rateLimitRedis.ts';

afterAll(async () => {
  await closeRateLimitRedis();
  await closeDb();
  await closeOwnerPool();
});

describe('reads-tier baseline rate limiting', () => {
  it('sets the reads-tier IP limit on /sdk', async () => {
    await truncateAll();
    const res = await request(app).get('/sdk/_whoami');
    expect(res.headers['ratelimit']).toMatch(/^limit=300,/);
  });

  it('sets the reads-tier identity limit on /surface once authenticated', async () => {
    await truncateAll();
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    await seedSession({ workspaceId, playerId });
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p1',
    });
    const res = await request(app)
      .get('/surface/messages')
      .set('Authorization', `Bearer ${token}`);
    expect(res.headers['ratelimit']).toMatch(/^limit=60,/);
  });
});
