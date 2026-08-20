import { and, desc, eq, sql } from 'drizzle-orm'
import type { Tx } from '../db/withWorkspace.ts'
import { agent, changeLog } from '../db/schema/index.ts'
import { encodeChangeLogCursor, type ChangeLogCursor } from './cursor.ts'

/**
 * One audit row, with its actor resolved. `id` is already a string — see the
 * mapping below.
 */
export type ChangeLogRow = {
  id: string
  field: string
  beforeValue: unknown
  afterValue: unknown
  changedAt: Date
  actor: { id: string; displayName: string; email: string }
}

export type ReadChangeLogInput = {
  workspaceId: string
  entityType: string
  entityId: string
  /** Page size. The caller's schema caps this; nothing is capped here. */
  limit: number
  cursor?: ChangeLogCursor
}

/** `nextCursor` null means this was the last page. */
export type ChangeLogPage = { rows: ChangeLogRow[]; nextCursor: string | null }

/**
 * The generic read of the audit trail: one entity's history, newest first.
 * Entity-agnostic on purpose — `entityType` is a parameter, so the next audited
 * entity reuses this rather than hand-rolling a query that misses the index.
 *
 * The predicate and ORDER BY are shaped to match
 * INDEX (workspace_id, entity_type, entity_id, changed_at). The explicit
 * workspace predicate is belt-and-braces on top of RLS, matching the codebase
 * rule that scoped reads name their workspace.
 *
 * `agent` is one of the two unscoped tables, so joining it for the actor's name
 * needs no policy consideration — but the join is inner, and `actor_id` is
 * NOT NULL with a real FK, so it can never drop a row.
 *
 * Keyset paging on the PAIR (changed_at, id): changed_at is transaction start
 * time, so every row one save writes shares it, and a cursor on that column alone
 * would skip all but the first. One extra row is fetched to decide whether a next
 * page exists without a second COUNT query.
 */
export async function readChangeLog(tx: Tx, input: ReadChangeLogInput): Promise<ChangeLogPage> {
  const scope = and(
    eq(changeLog.workspaceId, input.workspaceId),
    eq(changeLog.entityType, input.entityType),
    eq(changeLog.entityId, input.entityId),
  )

  // `changed_at` is timestamptz with microsecond precision in Postgres, but the
  // cursor round-trips through a JS Date, which only holds millisecond precision.
  // Comparing the raw column against a millisecond-truncated cursor value would
  // incorrectly exclude rows whose stored (sub-millisecond) timestamp is greater
  // than the truncated cursor even though they're indistinguishable once read as
  // a Date. Truncating the column to milliseconds here, matching ORDER BY below,
  // keeps the keyset predicate consistent with what callers actually observe.
  const changedAtMs = sql`date_trunc('milliseconds', ${changeLog.changedAt})`

  const where = input.cursor
    ? and(
        scope,
        sql`(${changedAtMs}, ${changeLog.id}) < (${input.cursor.changedAt.toISOString()}::timestamptz, ${input.cursor.id}::bigint)`,
      )
    : scope

  const found = await tx
    .select({
      id: changeLog.id,
      field: changeLog.field,
      beforeValue: changeLog.beforeValue,
      afterValue: changeLog.afterValue,
      changedAt: changeLog.changedAt,
      actorId: agent.id,
      actorDisplayName: agent.displayName,
      actorEmail: agent.email,
    })
    .from(changeLog)
    .innerJoin(agent, eq(agent.id, changeLog.actorId))
    .where(where)
    .orderBy(desc(changedAtMs), desc(changeLog.id))
    .limit(input.limit + 1)

  const page = found.slice(0, input.limit)

  // String(), not Number(): the column is a bigserial mapped as a JS bigint, and
  // JSON.stringify throws outright on a bigint while Number() would silently lose
  // precision past 2^53.
  const rows: ChangeLogRow[] = page.map((row) => ({
    id: String(row.id),
    field: row.field,
    beforeValue: row.beforeValue,
    afterValue: row.afterValue,
    changedAt: row.changedAt,
    actor: { id: row.actorId, displayName: row.actorDisplayName, email: row.actorEmail },
  }))

  const last = rows.at(-1)
  const nextCursor =
    found.length > input.limit && last ? encodeChangeLogCursor({ changedAt: last.changedAt, id: last.id }) : null

  return { rows, nextCursor }
}

/**
 * A single audit row by id, scoped to workspace + entity — the rollback
 * endpoint's lookup. Returns null both for a genuinely unknown id and for one
 * belonging to another workspace: under RLS those are indistinguishable from
 * inside a scoped transaction, matching this codebase's "expect 404 not 403"
 * convention (see CLAUDE.md Tenancy).
 */
export async function getChangeLogEntryById(
  tx: Tx,
  input: { workspaceId: string; entityType: string; entityId: string; id: string },
): Promise<ChangeLogRow | null> {
  if (!/^\d{1,19}$/.test(input.id)) return null

  const [row] = await tx
    .select({
      id: changeLog.id,
      field: changeLog.field,
      beforeValue: changeLog.beforeValue,
      afterValue: changeLog.afterValue,
      changedAt: changeLog.changedAt,
      actorId: agent.id,
      actorDisplayName: agent.displayName,
      actorEmail: agent.email,
    })
    .from(changeLog)
    .innerJoin(agent, eq(agent.id, changeLog.actorId))
    .where(
      and(
        eq(changeLog.workspaceId, input.workspaceId),
        eq(changeLog.entityType, input.entityType),
        eq(changeLog.entityId, input.entityId),
        eq(changeLog.id, sql`${input.id}::bigint`),
      ),
    )
    .limit(1)

  if (!row) return null
  return {
    id: String(row.id),
    field: row.field,
    beforeValue: row.beforeValue,
    afterValue: row.afterValue,
    changedAt: row.changedAt,
    actor: { id: row.actorId, displayName: row.actorDisplayName, email: row.actorEmail },
  }
}
