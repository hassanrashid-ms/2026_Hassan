import { rateLimitHit } from '../db/schema/index.ts';
import { withoutWorkspace } from '../db/withWorkspace.ts';

export async function recordRateLimitHit(input: {
  tier: string;
  keyType: 'ip' | 'identity';
  keyValue: string;
  path: string;
  method: string;
}): Promise<void> {
  await withoutWorkspace((tx) =>
    tx.insert(rateLimitHit).values({
      tier: input.tier,
      keyType: input.keyType,
      keyValue: input.keyValue,
      path: input.path,
      method: input.method,
    }),
  );
}
