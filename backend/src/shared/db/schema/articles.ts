import { index, pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core'
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
  summary: text('summary'),
  state: articleState('state').notNull().default('draft'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => agent.id, { onDelete: 'restrict' }),
  publishedBy: uuid('published_by').references(() => agent.id, { onDelete: 'restrict' }),
  publishedAt: timestamp('published_at', tz),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
})

export const articlePhrasing = pgTable('article_phrasing', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  articleId: uuid('article_id')
    .notNull()
    .references(() => article.id, { onDelete: 'restrict' }),
  phrase: text('phrase').notNull(),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
})

/** Schema-only in this slice — nothing writes to it until bot retrieval lands. */
export const articleEmbedding = pgTable(
  'article_embedding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    articleId: uuid('article_id')
      .notNull()
      .references(() => article.id, { onDelete: 'restrict' }),
    /** 'summary' | 'phrasing' */
    source: text('source').notNull(),
    phrasingId: uuid('phrasing_id').references(() => articlePhrasing.id, { onDelete: 'restrict' }),
    embedding: vector('embedding', { dimensions: 1536 }),
    model: text('model'),
    syncedAt: timestamp('synced_at', tz),
  },
  (t) => [index('article_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops'))],
)

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
