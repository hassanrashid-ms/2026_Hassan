import { foreignKey, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { conversation } from './conversations.ts'
import { workspace } from './identity.ts'

const tz = { withTimezone: true, mode: 'date' } as const

export const tag = pgTable(
  'tag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    /** As typed, for display. */
    name: text('name').notNull(),
    /** trim + lowercase, for dedup/lookup. */
    normalizedName: text('normalized_name').notNull(),
    /** 0..N-1 into the fixed palette, set once at creation. */
    colorIndex: integer('color_index').notNull(),
    archivedAt: timestamp('archived_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tag_workspace_normalized_name_uk').on(t.workspaceId, t.normalizedName),
    // Composite-FK parent key: conversation_tag references (workspace_id, id)
    // together, see docs/decisions/2026-08-04-composite-foreign-keys-for-tenancy.md.
    unique('tag_workspace_id_uk').on(t.workspaceId, t.id),
  ],
)

export const conversationTag = pgTable(
  'conversation_tag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    tagId: uuid('tag_id').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    /** null = currently attached. */
    removedAt: timestamp('removed_at', tz),
  },
  (t) => [
    // One row per (conversation, tag) pair for the life of the conversation.
    uniqueIndex('conversation_tag_pair_uk').on(t.conversationId, t.tagId),
    // Composite, not a bare FK: RI checks run with row security suspended, so a
    // single-column FK would let workspace A point a conversation_tag at
    // workspace B's conversation. See docs/decisions/2026-08-04-composite-foreign-keys-for-tenancy.md.
    foreignKey({
      name: 'conversation_tag_conversation_fk',
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversation.workspaceId, conversation.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'conversation_tag_tag_fk',
      columns: [t.workspaceId, t.tagId],
      foreignColumns: [tag.workspaceId, tag.id],
    }).onDelete('restrict'),
  ],
)
