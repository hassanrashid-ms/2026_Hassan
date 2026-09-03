import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeOwnerPool, ownerPool, truncateAll } from './helpers/db.ts';
import { recordRateLimitHit } from '../src/shared/rateLimit/recordRateLimitHit.ts';

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(async () => {
  await truncateAll();
});

describe('recordRateLimitHit', () => {
  it('inserts a row with the given fields', async () => {
    await recordRateLimitHit({
      tier: 'writes',
      keyType: 'identity',
      keyValue: 'agent-123',
      path: '/surface/messages',
      method: 'POST',
    });

    const { rows } = await ownerPool.query(
      'select tier, key_type, key_value, path, method from rate_limit_hit',
    );
    expect(rows).toEqual([
      {
        tier: 'writes',
        key_type: 'identity',
        key_value: 'agent-123',
        path: '/surface/messages',
        method: 'POST',
      },
    ]);
  });
});
