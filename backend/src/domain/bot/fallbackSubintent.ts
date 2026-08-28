import { and, eq } from 'drizzle-orm';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { intent, subintent } from '../../shared/db/schema/index.ts';

/** The one name this slice's `Other` classification carries. Seeded in seed.ts. */
export const OTHER_INTENT_NAME = 'Other';
export const OTHER_SUBINTENT_NAME = 'Other';

/**
 * The subintent `classify` resolves to when the model picks the `Other` index,
 * or when the model's index does not resolve. Never fabricated on the fly —
 * this is a lookup against a seeded row, and its absence is a provisioning
 * bug this throws loudly on rather than silently classifying nothing.
 */
export async function resolveFallbackSubintent(tx: Tx, workspaceId: string): Promise<string> {
  const [row] = await tx
    .select({ id: subintent.id })
    .from(subintent)
    .innerJoin(intent, eq(intent.id, subintent.intentId))
    .where(
      and(
        eq(subintent.workspaceId, workspaceId),
        eq(intent.isSystem, true),
        eq(intent.name, OTHER_INTENT_NAME),
        eq(subintent.name, OTHER_SUBINTENT_NAME),
      ),
    )
    .limit(1);

  if (!row) {
    throw new Error(
      `resolveFallbackSubintent: workspace ${workspaceId} has no seeded "Other" subintent`,
    );
  }
  return row.id;
}
