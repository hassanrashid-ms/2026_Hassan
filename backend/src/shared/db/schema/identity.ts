import { sql } from 'drizzle-orm'
import { boolean, customType, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { agentStatus, workspaceRole } from './enums.ts'

/** Case-insensitive email, per the schema spec. Requires the citext extension. */
const citext = customType<{ data: string }>({ dataType: () => 'citext' })

const tz = { withTimezone: true, mode: 'date' } as const

/** One of only two unscoped tables. No RLS policy, no workspace_id. */
export const workspace = pgTable('workspace', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  // secretHash removed — see workspaceSecret below.
  /**
   * The per-workspace ticket counter. Bumped inside the conversation-insert
   * transaction by allocateTicketNumber(), exactly as message_seq is bumped by
   * postMessage(). Not a bigserial: a global sequence would make #1042 a count
   * of every ticket across every tenant, so each workspace would see a sparse
   * sequence and could infer its neighbours' volume from the gaps.
   */
  ticketSeq: integer('ticket_seq').notNull().default(0),
  /**
   * How many days a `resolved` conversation waits before runAutoClose flips it
   * to `closed`. Per-workspace because support cadences differ per game; a
   * column rather than an env var so one noisy tenant can be tuned alone.
   */
  autoCloseDays: integer('auto_close_days').notNull().default(7),
  /** Set to refuse token minting without deleting anything. */
  disabledAt: timestamp('disabled_at', tz),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
})

/**
 * The other unscoped table: one login per person, global across workspaces.
 *
 * Holds a Google identity, not a credential — there are no passwords in the
 * product. See docs/decisions/2026-08-04-agent-auth-google-oauth.md.
 */
export const agent = pgTable('agent', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The Google account address. Case-insensitive because Google addresses are. */
  email: citext('email').notNull().unique(),
  /** The Google `sub` claim. Nullable only until a seeded row's first real login. */
  googleSubject: text('google_subject').unique(),
  displayName: text('display_name').notNull(),
  status: agentStatus('status').notNull().default('active'),
  /** Global: grants access to every workspace. Only a super admin may toggle this. See requireAdminRole. */
  isAdmin: boolean('is_admin').notNull().default(false),
  /** Global: may toggle isAdmin/isSuperAdmin on any agent. */
  isSuperAdmin: boolean('is_super_admin').notNull().default(false),
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

/**
 * Replaces the single `workspace.secret_hash`. Rotation inserts a new row rather
 * than overwriting one, so the previous secret can keep working for a grace
 * window while a game studio redeploys with the new one. See auth/workspaceSecret.ts.
 */
export const workspaceSecret = pgTable('workspace_secret', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  secretHash: text('secret_hash').notNull(),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  /** Null = no expiry (the current active secret). Set on rotation for the row it replaces. */
  expiresAt: timestamp('expires_at', tz),
  /** Set only if an admin manually revokes ahead of expiry. */
  revokedAt: timestamp('revoked_at', tz),
})
