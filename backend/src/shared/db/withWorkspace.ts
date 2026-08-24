import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Db } from './client.ts';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const uuidSchema = z.uuid();

/**
 * Thrown by `withWorkspace` when the workspace id isn't a syntactically valid UUID.
 *
 * Without this check, a malformed id reached Postgres inside `set_config(...)` and
 * raised `22P02 invalid input syntax for type uuid` mid-transaction — a 500 with the
 * bad value echoed into logs by the driver's own error message. A distinct error
 * class (rather than a bare string) lets the error middleware in Task 6 map this to
 * a clean 4xx before a transaction is ever opened.
 */
export class InvalidWorkspaceId extends Error {
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(`Invalid workspace id: not a UUID`);
    this.name = 'InvalidWorkspaceId';
    this.workspaceId = workspaceId;
  }
}

/**
 * The only way a handler touches a scoped table.
 *
 * `SET LOCAL app.workspace_id = $1` is a syntax error — SET does not take bind
 * parameters. set_config() is an ordinary function call, so it parameterises, and
 * its third argument (is_local = true) scopes the value to this transaction. That
 * matters with a connection pool: a session-level setting would leak to the next
 * request that borrowed the same connection.
 *
 * The workspace id must come from a verified JWT claim, never from a header or a
 * request body. It is validated as a UUID *before* the transaction opens — see
 * `InvalidWorkspaceId` — so a bad value fails fast and cleanly rather than
 * surfacing as a raw Postgres error partway through a transaction.
 */
export async function withWorkspace<T>(
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!uuidSchema.safeParse(workspaceId).success) {
    throw new InvalidWorkspaceId(workspaceId);
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    return fn(tx);
  });
}

/**
 * For `workspace` and `agent` — the only two unscoped tables. Reaching for this
 * anywhere else is a tenancy bug: RLS would return zero rows and the symptom would
 * look like missing data.
 */
export async function withoutWorkspace<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
