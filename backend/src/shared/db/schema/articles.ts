import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { articleState } from './enums.ts';
import { agent, workspace } from './identity.ts';
import { intent } from './taxonomy.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

export const article = pgTable('article', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
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
});

/**
 * No row exists until the object is HEAD-verified and claimed — same convention as
 * chat's `attachment` table (conversations.ts). Mirrors it exactly: no `status`
 * column, `storageKey` required from the start.
 */
export const articleAttachment = pgTable('article_attachment', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  articleId: uuid('article_id')
    .notNull()
    .references(() => article.id, { onDelete: 'restrict' }),
  storageKey: text('storage_key').notNull(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});
