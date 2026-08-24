import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { declaredFieldType } from './enums.ts';
import { agent, workspace } from './identity.ts';
import { session } from './players.ts';

const tz = { withTimezone: true, mode: 'date' } as const;
const emptyJson = sql`'{}'::jsonb`;

/**
 * The admin-promoted key set. The snapshot split reads this table at write time,
 * which is exactly what makes promotion non-retroactive: promote a field later and
 * old snapshots keep it in `raw`. There is no backfill, ever.
 *
 * `declared_at` is why a filter returning partial results is explainable rather
 * than mysterious.
 */
export const declaredField = pgTable(
  'declared_field',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: declaredFieldType('type').notNull(),
    declaredAt: timestamp('declared_at', tz).notNull().defaultNow(),
    /** Nullable: the eleven seeded rows have no human actor. */
    declaredBy: uuid('declared_by').references(() => agent.id, { onDelete: 'restrict' }),
  },
  (t) => [uniqueIndex('declared_field_workspace_key_uk').on(t.workspaceId, t.key)],
);

/**
 * Keyed to the session, not the conversation — the SDK delivers it before any
 * conversation exists, and a reopen never rewrites conversation.session_id, so
 * "a reopened cycle keeps the original snapshot" is structural rather than a rule.
 *
 * `raw` is PII by default: uncontrolled client input, handled as personal data for
 * access and retention purposes regardless of contents.
 */
export const playerStateSnapshot = pgTable(
  'player_state_snapshot',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'restrict' }),
    declared: jsonb('declared').$type<Record<string, unknown>>().notNull().default(emptyJson),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default(emptyJson),
    /** Delivered, but the game's provider returned nothing usable. A state, not an error. */
    isMissing: boolean('is_missing').notNull().default(false),
    /** Partial — device fields captured, some provider fields threw. */
    degradedReason: text('degraded_reason'),
    capturedAt: timestamp('captured_at', tz).notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('player_state_snapshot_session_uk').on(t.sessionId),
    // Filter on any promoted key without an index per field.
    index('player_state_snapshot_declared_gin').using('gin', sql`${t.declared} jsonb_path_ops`),
  ],
);
