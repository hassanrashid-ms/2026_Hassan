import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { articleState, articleVersionStatus } from './enums.ts';
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
  /**
   * Cached current live version number, updated alongside title/body/keywords on
   * every publish. Lets list/detail views show "v{N}" with no join into
   * article_version. Meaningless (stays at its default) until the article's first
   * publish.
   */
  version: integer('version').notNull().default(1),
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
 *
 * `draftOnly`/`pendingRemovalAt`/`removedAt` stage attachment changes made while an
 * article's draft is being edited (see article_version below): a `draftOnly`
 * attachment isn't live yet, a `pendingRemovalAt` one is still live but staged for
 * removal, and `removedAt` is the final soft-removed state — never a DELETE.
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
  draftOnly: boolean('draft_only').notNull().default(false),
  pendingRemovalAt: timestamp('pending_removal_at', tz),
  removedAt: timestamp('removed_at', tz),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});

/**
 * Doubles as the draft store AND the version history — see
 * docs/specs/2026-08-28-articles-versioning-design.md. Exactly one `status='draft'`
 * row may exist per articleId (partial unique index below); `status='published'` rows
 * are the append-only history, one per publish; `status='discarded'` is where an
 * abandoned draft ends up (never deleted — support_app has no DELETE grant, see
 * 002_rls.sql).
 *
 * `version` is null while `status='draft'`, assigned as MAX(published version)+1 only
 * at publish time, inside the same transaction as the article/attachment writes.
 *
 * Published rows are append-only, enforced by a `BEFORE UPDATE OR DELETE` trigger
 * (see the hand-written article_version_append_only_trigger migration) rather than a
 * blanket REVOKE UPDATE on the table, since draft rows must stay mutable.
 */
export const articleVersion = pgTable(
  'article_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => article.id, { onDelete: 'restrict' }),
    status: articleVersionStatus('status').notNull().default('draft'),
    version: integer('version'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    keywords: text('keywords').array().notNull().default([]),
    attachmentIds: uuid('attachment_ids').array().notNull().default([]),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'restrict' }),
    /** Subset of 'title' | 'body' | 'keywords' | 'attachments' — computed at publish time. */
    changedFields: text('changed_fields').array().notNull().default([]),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('article_version_article_version_unique').on(t.articleId, t.version),
    index('article_version_article_created_idx').on(t.articleId, t.createdAt),
  ],
);
