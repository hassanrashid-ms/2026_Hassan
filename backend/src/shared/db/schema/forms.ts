import { sql } from 'drizzle-orm'
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { FormField } from '@support/types'
import { conversation } from './conversations.ts'
import { formFieldType, formStatus } from './enums.ts'
import { agent, workspace } from './identity.ts'

const tz = { withTimezone: true, mode: 'date' } as const

export const form = pgTable(
  'form',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    createdBy: uuid('created_by').references(() => agent.id, { onDelete: 'restrict' }),
    archivedAt: timestamp('archived_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('form_workspace_name_uk').on(t.workspaceId, t.name),
    // Composite-FK parent key: form_version, form_submission and subintent all reference (workspace_id, id).
    unique('form_workspace_id_uk').on(t.workspaceId, t.id),
  ],
)

export const formVersion = pgTable(
  'form_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    formId: uuid('form_id').notNull(),
    version: integer('version').notNull(),
    fields: jsonb('fields').$type<FormField[]>().notNull().default(sql`'[]'::jsonb`),
    publishedAt: timestamp('published_at', tz),
    publishedBy: uuid('published_by').references(() => agent.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('form_version_form_version_uk').on(t.formId, t.version),
    foreignKey({
      name: 'form_version_form_fk',
      columns: [t.workspaceId, t.formId],
      foreignColumns: [form.workspaceId, form.id],
    }).onDelete('restrict'),
  ],
)

export const formSubmission = pgTable(
  'form_submission',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').notNull(),
    formId: uuid('form_id').notNull(),
    formVersion: integer('form_version').notNull(),
    status: formStatus('status').notNull().default('in_progress'),
    startedAt: timestamp('started_at', tz).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', tz),
  },
  (t) => [
    uniqueIndex('form_submission_conversation_form_uk').on(t.conversationId, t.formId),
    unique('form_submission_workspace_id_uk').on(t.workspaceId, t.id),
    foreignKey({
      name: 'form_submission_conversation_fk',
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversation.workspaceId, conversation.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'form_submission_form_fk',
      columns: [t.workspaceId, t.formId],
      foreignColumns: [form.workspaceId, form.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'form_submission_version_fk',
      columns: [t.formId, t.formVersion],
      foreignColumns: [formVersion.formId, formVersion.version],
    }).onDelete('restrict'),
  ],
)

export const formAnswer = pgTable(
  'form_answer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    formSubmissionId: uuid('form_submission_id').notNull(),
    fieldKey: text('field_key').notNull(),
    fieldType: formFieldType('field_type').notNull(),
    value: jsonb('value').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    index('form_answer_submission_field_idx').on(t.formSubmissionId, t.fieldKey, t.createdAt),
    foreignKey({
      name: 'form_answer_submission_fk',
      columns: [t.workspaceId, t.formSubmissionId],
      foreignColumns: [formSubmission.workspaceId, formSubmission.id],
    }).onDelete('restrict'),
  ],
)
