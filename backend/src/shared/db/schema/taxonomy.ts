import { boolean, foreignKey, pgTable, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { conversationPriority } from './enums.ts'
import { form } from './forms.ts'
import { workspace } from './identity.ts'

const tz = { withTimezone: true, mode: 'date' } as const

export const intent = pgTable(
  'intent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** Guards 'Other' — checked in the archive handler when one ships. Not exposed by this slice's API. */
    isSystem: boolean('is_system').notNull().default(false),
    archivedAt: timestamp('archived_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('intent_workspace_name_uk').on(t.workspaceId, t.name)],
)

export const subintent = pgTable(
  'subintent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intent.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** No consumer yet — see the design doc. Column exists so routing work later needs no migration. */
    defaultPriority: conversationPriority('default_priority'),
    /** A subintent maps to AT MOST one form. NULL means this subintent never shows a form.
     *  FK declared here (many side). The composite FK below ensures cross-workspace safety. */
    formId: uuid('form_id'),
    /** No merge flow yet. Self-referential FK needs the AnyPgColumn getter form. */
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => subintent.id, { onDelete: 'restrict' }),
    archivedAt: timestamp('archived_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subintent_workspace_intent_name_uk').on(t.workspaceId, t.intentId, t.name),
    // Composite-FK parent key: conversation.subintent_id references (workspace_id, id)
    // together, so a conversation can never name another workspace's subintent — see
    // docs/decisions/2026-08-04-composite-foreign-keys-for-tenancy.md.
    unique('subintent_workspace_id_uk').on(t.workspaceId, t.id),
    // Composite, not a bare FK: RI checks run with row security suspended, so a
    // single-column FK would let workspace A point a subintent at workspace B's
    // form. See docs/decisions/2026-08-04-composite-foreign-keys-for-tenancy.md.
    foreignKey({
      name: 'subintent_form_fk',
      columns: [t.workspaceId, t.formId],
      foreignColumns: [form.workspaceId, form.id],
    }).onDelete('restrict'),
  ],
)
