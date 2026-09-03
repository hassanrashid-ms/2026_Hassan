import express from 'express';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeOwnerPool, ownerPool, truncateAll } from './helpers/db.ts';
import { closeRateLimitRedis } from '../src/shared/rateLimit/rateLimitRedis.ts';
import { createRateLimiter } from '../src/shared/rateLimit/limiter.ts';
import { logger } from '../src/shared/logging/logger.ts';

afterAll(async () => {
  await closeRateLimitRedis();
  await closeDb();
  await closeOwnerPool();
});

let tierCounter = 0;

function buildTestApp(max: number) {
  const tier = `test-tier-${tierCounter++}`;
  const app = express();
  const limiter = createRateLimiter({
    tier,
    keyType: 'ip',
    windowMs: 60_000,
    max,
    keyFn: (req) => req.ip ?? 'unknown',
  });
  app.get('/probe', limiter, (_req, res) => res.status(200).json({ ok: true }));
  return { app, tier };
}

describe('createRateLimiter', () => {
  it('allows requests under the limit', async () => {
    const { app } = buildTestApp(5);
    await request(app).get('/probe').expect(200);
  });

  it('returns 429 with the rate_limited error shape once the limit is exceeded', async () => {
    await truncateAll();
    const { app } = buildTestApp(1);
    await request(app).get('/probe').expect(200);
    const res = await request(app).get('/probe').expect(429);
    expect(res.body).toEqual({
      error: { code: 'rate_limited', message: 'Too many requests, try again later.' },
    });
  });

  it('logs a warning on trigger', async () => {
    await truncateAll();
    const warnSpy = vi.spyOn(logger, 'warn');
    const { app, tier } = buildTestApp(1);
    await request(app).get('/probe').expect(200);
    await request(app).get('/probe').expect(429);
    expect(warnSpy).toHaveBeenCalledWith(
      'rate_limit',
      'blocked request',
      expect.objectContaining({ tier, keyType: 'ip', path: '/probe', method: 'GET' }),
    );
    warnSpy.mockRestore();
  });

  it('persists a rate_limit_hit row on trigger', async () => {
    await truncateAll();
    const { app, tier } = buildTestApp(1);
    await request(app).get('/probe').expect(200);
    await request(app).get('/probe').expect(429);

    await vi.waitFor(async () => {
      const { rows } = await ownerPool.query('select tier, key_type, path, method from rate_limit_hit');
      expect(rows).toEqual([{ tier, key_type: 'ip', path: '/probe', method: 'GET' }]);
    });
  });
});
