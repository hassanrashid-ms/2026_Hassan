// backend/src/domain/templates/templateCache.ts
import IORedis from 'ioredis';
import { getEnv } from '../../env.ts';

export type SystemMessageKey =
  | 'no_agents_online'
  | 'handoff'
  | 'form_summary_completed'
  | 'form_summary_partial'
  | 'form_summary_skipped';

export type CannedReplyEntry = { id: string; label: string; body: string };

/**
 * One key per workspace, not per-message: the full active-template set per
 * workspace is small, and reads vastly outnumber writes, so grouping avoids
 * N Redis round-trips per bot turn.
 */
export type TemplatesCachePayload = {
  system: Record<SystemMessageKey, string[]>;
  canned: CannedReplyEntry[];
};

const PREFIX = 'templates:';
// A safety net, not the primary invalidation path — every write path in
// templateService.ts calls invalidateCachedTemplates in the same request, so
// this TTL exists only in case an invalidation is ever missed. Redis is a
// cache here, never the system of record (see CLAUDE.md Stack table).
const TTL_SECONDS = 60 * 60 * 24;

let redisClient: IORedis | undefined;

function client(): IORedis {
  if (!redisClient) {
    redisClient = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  }
  return redisClient;
}

const cacheKey = (workspaceId: string): string => `${PREFIX}${workspaceId}`;

export async function getCachedTemplates(
  workspaceId: string,
): Promise<TemplatesCachePayload | null> {
  const raw = await client().get(cacheKey(workspaceId));
  if (raw === null) return null;
  return JSON.parse(raw) as TemplatesCachePayload;
}

export async function setCachedTemplates(
  workspaceId: string,
  payload: TemplatesCachePayload,
): Promise<void> {
  await client().set(cacheKey(workspaceId), JSON.stringify(payload), 'EX', TTL_SECONDS);
}

export async function invalidateCachedTemplates(workspaceId: string): Promise<void> {
  await client().del(cacheKey(workspaceId));
}

/** Test-only teardown, mirrors wsAuthCache.ts's closeWsAuthRedis. */
export async function closeTemplateCacheRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit().catch(() => redisClient!.disconnect());
    redisClient = undefined;
  }
}
