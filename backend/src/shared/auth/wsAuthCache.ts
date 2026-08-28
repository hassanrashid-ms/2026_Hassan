import IORedis from 'ioredis';
import { getEnv } from '../../env.ts';

/**
 * Backs the per-request membership check in resolveConsoleWorkspace.ts — see
 * 2026-08-25-global-inbox-workspace-decoupling-design.md section 1. `role` is
 * carried alongside `active` purely as a cache-fill byproduct of the lookup;
 * no caller currently reads it, since requireWorkspaceRole.ts still re-queries
 * role itself (role changes must take effect immediately, this cache's TTL
 * is 60s).
 */
export type WsAuthCacheEntry = { active: boolean; role: 'agent' | 'team_lead' | null };

const PREFIX = 'wsauth:';
const TTL_SECONDS = 60;

let redisClient: IORedis | undefined;

function client(): IORedis {
  if (!redisClient) {
    redisClient = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  }
  return redisClient;
}

const cacheKey = (agentId: string, workspaceId: string): string =>
  `${PREFIX}${agentId}:${workspaceId}`;

export async function getCachedWsAuth(
  agentId: string,
  workspaceId: string,
): Promise<WsAuthCacheEntry | null> {
  const raw = await client().get(cacheKey(agentId, workspaceId));
  if (raw === null) return null;
  return JSON.parse(raw) as WsAuthCacheEntry;
}

export async function setCachedWsAuth(
  agentId: string,
  workspaceId: string,
  entry: WsAuthCacheEntry,
): Promise<void> {
  await client().set(cacheKey(agentId, workspaceId), JSON.stringify(entry), 'EX', TTL_SECONDS);
}

export async function invalidateCachedWsAuth(agentId: string, workspaceId: string): Promise<void> {
  await client().del(cacheKey(agentId, workspaceId));
}

/** Test-only teardown, mirrors presence.ts's closePresenceRedis. */
export async function closeWsAuthRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit().catch(() => redisClient!.disconnect());
    redisClient = undefined;
  }
}
