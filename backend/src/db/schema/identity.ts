import { sql } from 'drizzle-orm'
import { customType, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { agentStatus, workspaceRole } from './enums.ts'

/** Case-insensitive email, per the schema spec. Requires the citext extension. */
const citext = customType<{ data: string }>({ dataType: () => 'citext' })

const tz = { withTimezone: true, mode: 'date' } as const

/** One of only two unscoped tables. No RLS policy, no workspace_id. */
export const workspace = pgTable('workspace', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /** sha256 of the random half of the workspace secret. See auth/workspaceSecret.ts. */
  secretHash: text('secret_hash').notNull(),
  /** Set to refuse token minting without deleting anything. */
  disabledAt: timestamp('disabled_at', tz),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
})

/** The other unscoped table: one login per person, global across workspaces. */
export const agent = pgTable('agent', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  status: agentStatus('status').notNull().default('active'),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
})

/** The hinge: a global agent holds a per-workspace role. */
export const workspaceMember = pgTable(
  'workspace_member',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'restrict' }),
    role: workspaceRole('role').notNull(),
    deactivatedAt: timestamp('deactivated_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workspace_member_workspace_agent_uk').on(t.workspaceId, t.agentId)],
)
