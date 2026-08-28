import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  closeWsAuthRedis,
  getCachedWsAuth,
  invalidateCachedWsAuth,
  setCachedWsAuth,
} from '../src/shared/auth/wsAuthCache.ts';

afterAll(async () => {
  await closeWsAuthRedis();
});

describe('wsAuthCache', () => {
  it('returns null on a cache miss', async () => {
    const entry = await getCachedWsAuth(randomUUID(), randomUUID());
    expect(entry).toBeNull();
  });

  it('round-trips a cached entry', async () => {
    const agentId = randomUUID();
    const workspaceId = randomUUID();
    await setCachedWsAuth(agentId, workspaceId, { active: true, role: 'team_lead' });
    expect(await getCachedWsAuth(agentId, workspaceId)).toEqual({
      active: true,
      role: 'team_lead',
    });
  });

  it('invalidation clears a cached entry immediately, ahead of its TTL', async () => {
    const agentId = randomUUID();
    const workspaceId = randomUUID();
    await setCachedWsAuth(agentId, workspaceId, { active: true, role: 'agent' });
    await invalidateCachedWsAuth(agentId, workspaceId);
    expect(await getCachedWsAuth(agentId, workspaceId)).toBeNull();
  });

  it('keys are scoped per (agent, workspace) pair — no cross-talk', async () => {
    const agentId = randomUUID();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    await setCachedWsAuth(agentId, workspaceA, { active: true, role: 'agent' });
    expect(await getCachedWsAuth(agentId, workspaceB)).toBeNull();
  });
});
