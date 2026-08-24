import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  classificationSource,
  conversationPriority,
  conversationStatus,
  messageAuthorType,
  messageDeliveryState,
  messageVisibility,
  confirmPhase,
  resolutionSource,
} from './enums.ts';
import { agent, workspace } from './identity.ts';
import { player, session } from './players.ts';
import { subintent } from './taxonomy.ts';
import { article } from './articles.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

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
    /**
     * The per-workspace ticket number the agent console displays as #1042.
     * No default: it is allocated by allocateTicketNumber() in the same
     * transaction as this insert, and a default would hide a creation path
     * that forgot to.
     */
    number: integer('number').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    index('conversation_workspace_player_idx').on(t.workspaceId, t.playerId),
    index('conversation_workspace_subintent_idx').on(t.workspaceId, t.subintentId),
    uniqueIndex('conversation_workspace_number_uk').on(t.workspaceId, t.number),
    foreignKey({
      name: 'conversation_subintent_fk',
      columns: [t.workspaceId, t.subintentId],
      foreignColumns: [subintent.workspaceId, subintent.id],
    }).onDelete('restrict'),
    // Composite-FK parent key: form_submission references (workspace_id, id) together,
    // so a submission can never name another workspace's conversation.
    unique('conversation_workspace_id_uk').on(t.workspaceId, t.id),
  ],
);

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
    /**
     * The article this bot answer was written from, or null. Delivery, not
     * reporting: `bot_article_offered` keeps its own snapshotted title and stays
     * the record every funnel metric groups by. The two must never become two
     * sources for one number.
     *
     * Never client-supplied — toolLoop only accepts an id searchArticles already
     * proved visible in this workspace — so no scoped re-check guards this FK.
     *
     * No index on purpose: it is read on rows already fetched by
     * conversation_id, and is never a filter or a join key.
     */
    articleId: uuid('article_id').references(() => article.id, { onDelete: 'restrict' }),
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
);

export const attachment = pgTable('attachment', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  /**
   * Exactly one parent, deliberately not polymorphic — see
   * docs/specs/2026-08-24-minio-attachments-agent-chat-design.md §4. No row
   * exists until the owning message sends: an abandoned upload is bytes in
   * `pending/`, never a row here.
   */
  messageId: uuid('message_id')
    .notNull()
    .references(() => message.id, { onDelete: 'restrict' }),
  /** `ws/{workspaceId}/attachments/{uuid}.{ext}` once claimed. Never a URL — reads sign this fresh. */
  storageKey: text('storage_key').notNull(),
  /** Verified via HEAD at claim time, never the client-declared value. */
  mimeType: text('mime_type').notNull(),
  /** Verified via HEAD at claim time, never the client-declared value. */
  byteSize: integer('byte_size').notNull(),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});

/**
 * One row per resolution attempt. Cycle 1 opens with the conversation; every
 * reopen opens the next, so `reopen_count = cycle_no - 1` and no counter column
 * exists.
 *
 * A mutable projection, not an append-only log: `inactivity_due_at` ticks
 * forward on every public message for the life of the cycle. That is why there
 * is no REVOKE UPDATE on it, unlike `event`/`change_log`/`form_answer`.
 *
 * `first_human_reply_at` ships unpopulated on purpose — it belongs to the
 * metrics slice ("time to first reply"), not to either clock.
 */
export const resolutionCycle = pgTable(
  'resolution_cycle',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').notNull(),
    /** 1-based. */
    cycleNo: integer('cycle_no').notNull(),
    openedAt: timestamp('opened_at', tz).notNull().defaultNow(),
    /** Column ships now, population is the metrics slice. */
    firstHumanReplyAt: timestamp('first_human_reply_at', tz),
    /** NULL means the clock is not running: bot_active, escalated, or resolved. */
    inactivityDueAt: timestamp('inactivity_due_at', tz),
    resolvedAt: timestamp('resolved_at', tz),
    resolutionKind: resolutionSource('resolution_kind'),
    closedAt: timestamp('closed_at', tz),
    /** Set by the clock's stage 2 when the last public word was the player's. */
    supportOwedFlag: boolean('support_owed_flag').notNull().default(false),
  },
  (t) => [
    // Same composite-FK pattern as subintent/form_submission: a cycle can never
    // name another workspace's conversation.
    foreignKey({
      name: 'resolution_cycle_conversation_fk',
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversation.workspaceId, conversation.id],
    }).onDelete('restrict'),
    // "At most one open cycle per conversation", enforced by the database rather
    // than by every writer remembering to check.
    uniqueIndex('resolution_cycle_open_uk')
      .on(t.conversationId)
      .where(sql`resolved_at is null`),
    // The inactivity worker's stage 1 + stage 2 scan.
    index('resolution_cycle_due_idx')
      .on(t.workspaceId, t.inactivityDueAt)
      .where(sql`resolved_at is null`),
    // The auto-close worker's scan.
    index('resolution_cycle_autoclose_idx')
      .on(t.workspaceId, t.resolvedAt)
      .where(sql`closed_at is null and resolved_at is not null`),
  ],
);
