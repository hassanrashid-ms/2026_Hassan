import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('weaviate-client', () => {
  const connectToWeaviateCloud = vi.fn().mockResolvedValue({ collections: { get: vi.fn() } });
  return { default: { connectToWeaviateCloud, ApiKey: vi.fn() } };
});

describe('getWeaviateClient', () => {
  beforeEach(async () => {
    const { resetWeaviateClientCache } = await import('../src/shared/weaviate/client.ts');
    resetWeaviateClientCache();
  });

  it('memoises the connection across calls', async () => {
    const { getWeaviateClient } = await import('../src/shared/weaviate/client.ts');
    const weaviate = (await import('weaviate-client')).default;

    const first = await getWeaviateClient();
    const second = await getWeaviateClient();

    expect(first).toBe(second);
    expect(weaviate.connectToWeaviateCloud).toHaveBeenCalledTimes(1);
  });
});
