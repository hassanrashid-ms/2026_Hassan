import { afterAll, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { app } from './helpers/app.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeOwnerPool, truncateAll } from './helpers/db.ts';
import { closeRateLimitRedis } from '../src/shared/rateLimit/rateLimitRedis.ts';

afterAll(async () => {
  await closeRateLimitRedis();
  await closeDb();
  await closeOwnerPool();
});

describe('auth-tier rate limiting', () => {
  it('sets the auth-tier RateLimit limit on /auth/player-token', async () => {
    await truncateAll();
    const res = await request(app).post('/auth/player-token').send({});
    expect(res.headers['ratelimit']).toMatch(/^limit=60,/);
  });

  it('sets the auth-tier RateLimit limit on /agent/auth/dev-login', async () => {
    await truncateAll();
    const res = await request(app).post('/agent/auth/dev-login').send({});
    expect(res.headers['ratelimit']).toMatch(/^limit=60,/);
  });
});
