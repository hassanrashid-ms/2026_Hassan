import { sql } from 'drizzle-orm'
import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { eventActorType } from './enums.ts'
import { workspace } from './identity.ts'
import { conversation } from './conversations.ts'
import { session } from './players.ts'

const tz = { withTimezone: true, mode: 'date' } as const

/**
 * The reporting spine, append-only. Enforcement is REVOKE UPDATE, DELETE in
 * 002_rls.sql — not a convention.
 *
 * Payload values are snapshotted, never live pointers: an event records what
 * happened, and a name resolved through a FK would silently rewrite history when
 * someone renames the thing.
 */
export const event = pgTable(
  'event',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    /** text, not an enum: new types arrive every slice. */
    type: text('type').notNull(),
    conversationId: uuid('conversation_id').references(() => conversation.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id').references(() => session.id, { onDelete: 'restrict' }),
    /** No FK: this holds an agent id or a player id depending on actor_type. */
    actorId: uuid('actor_id'),
    actorType: eventActorType('actor_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp('occurred_at', tz).notNull().defaultNow(),
  },
  (t) => [
    // The table only grows and is only queried by time range.
    index('event_occurred_brin').using('brin', t.occurredAt),
    index('event_conversation_occurred_idx').on(t.conversationId, t.occurredAt),
    index('event_session_type_idx').on(t.sessionId, t.type),
  ],
)
