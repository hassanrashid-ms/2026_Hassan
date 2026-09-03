import { afterAll, describe, expect, it } from 'vitest';
import { closeRateLimitRedis, rateLimitRedisClient } from '../src/shared/rateLimit/rateLimitRedis.ts';

afterAll(async () => {
  await closeRateLimitRedis();
});

describe('rateLimitRedisClient', () => {
  it('returns a connected, reusable client', async () => {
    const client = rateLimitRedisClient();
    expect(await client.ping()).toBe('PONG');
    expect(rateLimitRedisClient()).toBe(client);
  });
});
