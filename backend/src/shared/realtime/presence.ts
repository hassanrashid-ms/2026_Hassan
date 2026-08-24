import IORedis from 'ioredis';
import { getEnv } from '../../env.ts';

export type LivePresenceStatus = 'online' | 'away' | 'offline';

const CONN_PREFIX = 'presence:conn:';
const STATUS_PREFIX = 'presence:status:';

let redisClient: IORedis | undefined;

/**
 * Lazily created, module-scoped connection — presence is read/written from
 * both socketServer.ts (on connect/disconnect) and the REST presence routes,
 * so one shared client avoids opening a new Redis connection per call site.
 */
function client(): IORedis {
  if (!redisClient) {
    redisClient = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  }
  return redisClient;
}

/** Test-only teardown, mirrors closeSocketServer's redisClients cleanup. */
export async function closePresenceRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit().catch(() => redisClient!.disconnect());
    redisClient = undefined;
  }
}

const connKey = (agentId: string): string => `${CONN_PREFIX}${agentId}`;
const statusKey = (agentId: string): string => `${STATUS_PREFIX}${agentId}`;

/**
 * Socket connect. Returns whether this was the first connection (counter was
 * 0 before the increment) — callers use that to decide whether to emit
 * presence_changed, since a second tab/device connecting must not re-announce.
 */
export async function incrementPresence(agentId: string): Promise<{ wasFirstConnection: boolean }> {
  const count = await client().incr(connKey(agentId));
  if (count === 1) {
    await client().set(statusKey(agentId), 'online');
    return { wasFirstConnection: true };
  }
  return { wasFirstConnection: false };
}

/**
 * Socket disconnect. Returns whether this was the last connection (counter
 * reached 0) — callers use that to decide whether to clear status and emit
 * offline, since a remaining tab/device must not flip the agent offline.
 */
export async function decrementPresence(agentId: string): Promise<{ wasLastConnection: boolean }> {
  const count = await client().decr(connKey(agentId));
  if (count <= 0) {
    // Never go negative from a stray extra decrement (e.g. a disconnect firing
    // without a matching prior connect) — clamp back to 0 so a later connect
    // starts clean rather than needing multiple increments to reach positive.
    if (count < 0) await client().set(connKey(agentId), 0);
    await client().del(statusKey(agentId));
    return { wasLastConnection: true };
  }
  return { wasLastConnection: false };
}

/**
 * Sets `online`/`away` for an agent that already has an open connection.
 * Returns false if the connection counter is 0 (caller maps this to 409) —
 * setting presence without any open socket is a contradiction, not a state.
 */
export async function setPresenceStatus(
  agentId: string,
  status: 'online' | 'away',
): Promise<boolean> {
  const count = await client().get(connKey(agentId));
  if (!count || Number(count) <= 0) return false;
  await client().set(statusKey(agentId), status);
  return true;
}

/** Self status for the header dropdown: online/away/offline, never on_leave. */
export async function getPresenceStatus(agentId: string): Promise<LivePresenceStatus> {
  const [count, status] = await Promise.all([
    client().get(connKey(agentId)),
    client().get(statusKey(agentId)),
  ]);
  if (!count || Number(count) <= 0) return 'offline';
  return status === 'away' ? 'away' : 'online';
}

/**
 * Batch read for the workload roster — one round trip via mget rather than
 * N+1 per-agent reads. Order of the returned map has no relation to input order.
 */
export async function getPresenceStatusBatch(
  agentIds: string[],
): Promise<Map<string, LivePresenceStatus>> {
  const result = new Map<string, LivePresenceStatus>();
  if (agentIds.length === 0) return result;

  const connKeys = agentIds.map(connKey);
  const statusKeys = agentIds.map(statusKey);
  const [connValues, statusValues] = await Promise.all([
    client().mget(...connKeys),
    client().mget(...statusKeys),
  ]);

  agentIds.forEach((agentId, i) => {
    const count = connValues[i];
    if (!count || Number(count) <= 0) {
      result.set(agentId, 'offline');
      return;
    }
    result.set(agentId, statusValues[i] === 'away' ? 'away' : 'online');
  });

  return result;
}
