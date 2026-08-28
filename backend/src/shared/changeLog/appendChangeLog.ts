import { isDeepStrictEqual } from 'node:util';
import type { Tx } from '../db/withWorkspace.ts';
import { changeLog } from '../db/schema/index.ts';

export type ChangeLogChange = {
  /** The COLUMN name, not the API field name. */
  field: string;
  before: unknown;
  after: unknown;
};

export type ChangeLogInput = {
  workspaceId: string;
  entityType: string;
  /** The audited row's uuid pk. For bot_config that is the workspace id itself. */
  entityId: string;
  /** The authenticated agent. There is no system or bot actor. */
  actorId: string;
  changes: readonly ChangeLogChange[];
};

/**
 * jsonb has no `undefined`. Normalising here means a caller passing `undefined`
 * gets an explicit SQL NULL rather than Drizzle omitting the column and the
 * insert falling back to a default — and it makes the no-op comparison below
 * treat `undefined` and `null` as the same absence, which they are.
 */
function normalise(value: unknown): unknown {
  return value === undefined ? null : value;
}

/**
 * The single choke point for the audit trail, mirroring `appendEvent`.
 * Never insert into `change_log` directly.
 *
 * One row per genuinely changed field: a save that edits the prompt and flips
 * is_provisioned writes two rows, and both carry the same actor and the same
 * `changed_at`, because `now()` is transaction start time in Postgres.
 *
 * No-ops are dropped here, deeply compared, so the table's CHECK constraint is a
 * backstop against a bug in this function rather than a routine error path. A
 * changes array that is entirely no-ops writes nothing and does not fail.
 *
 * Call this inside the same transaction as the mutation it audits, so a config
 * change that leaves no audit row is impossible rather than merely unlikely.
 */
export async function appendChangeLog(tx: Tx, input: ChangeLogInput): Promise<void> {
  const changed = input.changes
    .map((change) => ({
      field: change.field,
      before: normalise(change.before),
      after: normalise(change.after),
    }))
    .filter((change) => !isDeepStrictEqual(change.before, change.after));

  if (changed.length === 0) return;

  await tx.insert(changeLog).values(
    changed.map((change) => ({
      workspaceId: input.workspaceId,
      entityType: input.entityType,
      entityId: input.entityId,
      field: change.field,
      beforeValue: change.before,
      afterValue: change.after,
      actorId: input.actorId,
    })),
  );
}
