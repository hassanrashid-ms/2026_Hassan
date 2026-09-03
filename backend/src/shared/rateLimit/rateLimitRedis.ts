import IORedis from 'ioredis';
import { getEnv } from '../../env.ts';

let redisClient: IORedis | undefined;

export function rateLimitRedisClient(): IORedis {
  if (!redisClient) {
    redisClient = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  }
  return redisClient;
}

/** Test-only teardown, mirrors wsAuthCache.ts's closeWsAuthRedis. */
export async function closeRateLimitRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit().catch(() => redisClient!.disconnect());
    redisClient = undefined;
  }
}
