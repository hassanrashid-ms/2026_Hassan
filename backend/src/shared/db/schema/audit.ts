import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { agent, workspace } from './identity.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

/**
 * The audit trail: who changed which field, when, and from what to what.
 * Field-level granularity — one save that edits two fields writes two rows.
 *
 * Append-only. Enforcement is REVOKE UPDATE, DELETE in 002_rls.sql: an editable
 * audit trail is not one.
 *
 * NOT the `event` spine, deliberately. `event.actor_id` has no foreign key
 * because it holds an agent id or a player id depending on actor_type, and an
 * audit trail whose actor is unverifiable at the database layer is a weak one.
 * `event` is also the conversation/session reporting spine, and admin config
 * rows would silently enter any metric that aggregates event types.
 *
 * `actor_id` is NOT NULL with a real FK: every row in this table is a human act.
 * A system or bot actor would need a deliberate design decision, not a nullable
 * column that quietly permits one.
 *
 * A bot_config edit writes here and does NOT also write an `event`. Two audit
 * homes diverge.
 */
export const changeLog = pgTable(
  'change_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    /** text, not an enum, for the same reason `event.type` is: new audited
     *  entities arrive every slice, and a migration per type is friction with no
     *  safety benefit. Only 'bot_config' is written in this slice — do not add
     *  values for writers that do not exist. */
    entityType: text('entity_type').notNull(),
    /** uuid because every audited entity has a uuid pk. For bot_config this IS
     *  the workspace_id, which reads redundantly next to the column above but
     *  keeps the table uniform — a reader never special-cases one entity type. */
    entityId: uuid('entity_id').notNull(),
    /** The COLUMN name — 'prompt', 'is_provisioned' — never an API field name,
     *  so the trail stays readable against the schema when an API shape changes. */
    field: text('field').notNull(),
    /** NULL means the field had no value before: the first time it was ever set. */
    beforeValue: jsonb('before_value'),
    /** NULL means the field was cleared — e.g. a prompt reset to the default. */
    afterValue: jsonb('after_value'),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'restrict' }),
    changedAt: timestamp('changed_at', tz).notNull().defaultNow(),
  },
  (t) => [
    // A row recording a change from x to x is noise that makes a real audit
    // harder to read. appendChangeLog drops no-ops before insert; this is the
    // backstop against a bug there, not a routine error path.
    check('change_log_value_changed', sql`${t.beforeValue} is distinct from ${t.afterValue}`),
    // The read path: one entity's history, newest first.
    index('change_log_entity_changed_idx').on(t.workspaceId, t.entityType, t.entityId, t.changedAt),
    // bigserial + BRIN, matching `event`: the table only grows and is only
    // queried by entity or by time range.
    index('change_log_changed_brin').using('brin', t.changedAt),
  ],
);
