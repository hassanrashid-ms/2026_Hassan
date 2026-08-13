import { foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import {
  classificationSource,
  conversationPriority,
  conversationStatus,
  messageAuthorType,
  messageDeliveryState,
  messageVisibility,
  confirmPhase,
  resolutionSource,
} from './enums.ts'
import { agent, workspace } from './identity.ts'
import { player, session } from './players.ts'
import { subintent } from './taxonomy.ts'

const tz = { withTimezone: true, mode: 'date' } as const

/**
 * MINIMAL on purpose. These two tables exist in this slice only because
 * GET /sdk/unread joins them. `subintent_id`, `resolution_cycle`, labels, form
 * submissions and the real status machine arrive with the step-5 slice, once the
 * taxonomy tables exist.
 */
export const conversation = pgTable(
  'conversation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => player.id, { onDelete: 'restrict' }),
    /** How a conversation reaches its player-state snapshot. Never rewritten on reopen. */
    sessionId: uuid('session_id').references(() => session.id, { onDelete: 'restrict' }),
    status: conversationStatus('status').notNull().default('bot_active'),
    priority: conversationPriority('priority').notNull().default('p3'),
    /** NULL is the unassigned queue. There is no queue table. */
    assignedAgentId: uuid('assigned_agent_id').references(() => agent.id, { onDelete: 'restrict' }),
    /** NULL means unset — the bot never ran. Only 'bot' or 'agent' otherwise. */
    classificationSource: classificationSource('classification_source'),
    /**
     * NULL means the bot never classified this conversation — never "unknown
     * category". `Other`'s catch-all subintent is where an unplaceable
     * conversation lands, and the two must stay distinguishable.
     */
    subintentId: uuid('subintent_id'),
    /** Guard, not a scheduler — decides whether confirm_resolution is offered to
     *  the model at all, and whether the player sees the Yes/No banner. The
     *  forms slice widens this to add 'form'. */
    confirmPhase: confirmPhase('confirm_phase').notNull().default('none'),
    /** NULL until the conversation is resolved. Read on reopen to decide
     *  assignment per spec §10, then cleared. */
    resolutionSource: resolutionSource('resolution_source'),
    messageSeq: integer('message_seq').notNull().default(0),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    index('conversation_workspace_player_idx').on(t.workspaceId, t.playerId),
    index('conversation_workspace_subintent_idx').on(t.workspaceId, t.subintentId),
    foreignKey({
      name: 'conversation_subintent_fk',
      columns: [t.workspaceId, t.subintentId],
      foreignColumns: [subintent.workspaceId, subintent.id],
    }).onDelete('restrict'),
  ],
)

export const message = pgTable(
  'message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'restrict' }),
    /** Server-assigned sequence, never a device clock. Gaps are fine; order is not. */
    seq: integer('seq').notNull(),
    authorType: messageAuthorType('author_type').notNull(),
    authorAgentId: uuid('author_agent_id').references(() => agent.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    /** Never filtered in a query — two serializers do that. Internal notes leaking is safety-critical. */
    visibility: messageVisibility('visibility').notNull().default('public'),
    deliveryState: messageDeliveryState('delivery_state').notNull().default('sent'),
    /** Set once, by the first mark-read that matches this row. Never rewritten — see docs/specs/2026-08-11-read-receipts-design.md. */
    readAt: timestamp('read_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('message_conversation_seq_uk').on(t.conversationId, t.seq),
    // The GET /sdk/unread scan.
    index('message_unread_idx').on(t.conversationId, t.deliveryState, t.authorType),
  ],
)
