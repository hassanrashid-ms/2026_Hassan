import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { articleState } from './enums.ts'
import { agent, workspace } from './identity.ts'
import { intent } from './taxonomy.ts'

const tz = { withTimezone: true, mode: 'date' } as const

export const article = pgTable('article', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  /** Nullable = uncategorized. Articles reference intent, never subintent. */
  intentId: uuid('intent_id').references(() => intent.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  keywords: text('keywords').array().notNull().default([]),
  state: articleState('state').notNull().default('draft'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => agent.id, { onDelete: 'restrict' }),
  publishedBy: uuid('published_by').references(() => agent.id, { onDelete: 'restrict' }),
  publishedAt: timestamp('published_at', tz),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
})

/** Schema-only in this slice — no upload endpoint, storage_key stays null. */
export const articleAttachment = pgTable('article_attachment', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  articleId: uuid('article_id')
    .notNull()
    .references(() => article.id, { onDelete: 'restrict' }),
  filename: text('filename').notNull(),
  storageKey: text('storage_key'),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
})
