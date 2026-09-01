// backend/tests/templateCache.test.ts
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  closeTemplateCacheRedis,
  getCachedTemplates,
  invalidateCachedTemplates,
  setCachedTemplates,
  type TemplatesCachePayload,
} from '../src/domain/templates/templateCache.ts';

afterAll(async () => {
  await closeTemplateCacheRedis();
});

const samplePayload = (): TemplatesCachePayload => ({
  system: {
    no_agents_online: ['Custom no-agents line.'],
    handoff: ['Custom handoff one.', 'Custom handoff two.'],
    form_summary_completed: ['Custom completed line.'],
    form_summary_partial: ['Custom partial line.'],
    form_summary_skipped: ['Custom skipped line.'],
  },
  canned: [{ id: randomUUID(), label: 'Intro', body: 'Hi, this is {{agent_name}}.' }],
});

describe('templateCache', () => {
  it('returns null on a cache miss', async () => {
    expect(await getCachedTemplates(randomUUID())).toBeNull();
  });

  it('round-trips a cached payload', async () => {
    const workspaceId = randomUUID();
    const payload = samplePayload();
    await setCachedTemplates(workspaceId, payload);
    expect(await getCachedTemplates(workspaceId)).toEqual(payload);
  });

  it('invalidation clears a cached entry immediately', async () => {
    const workspaceId = randomUUID();
    await setCachedTemplates(workspaceId, samplePayload());
    await invalidateCachedTemplates(workspaceId);
    expect(await getCachedTemplates(workspaceId)).toBeNull();
  });

  it('keys are scoped per workspace — no cross-talk', async () => {
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    await setCachedTemplates(workspaceA, samplePayload());
    expect(await getCachedTemplates(workspaceB)).toBeNull();
  });
});
