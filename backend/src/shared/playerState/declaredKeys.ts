import { declaredField } from '../db/schema/index.ts'
import type { Tx } from '../db/withWorkspace.ts'

/**
 * Read inside the same transaction as the write it feeds. The split is made against
 * the set current at that moment, which is exactly what makes promotion
 * non-retroactive — so this must never be cached across requests.
 */
export async function loadDeclaredKeys(tx: Tx): Promise<ReadonlySet<string>> {
  const rows = await tx.select({ key: declaredField.key }).from(declaredField)
  return new Set(rows.map((row) => row.key))
}
