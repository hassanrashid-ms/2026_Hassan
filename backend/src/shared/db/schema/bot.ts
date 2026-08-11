import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { workspace } from './identity.ts'

const tz = { withTimezone: true, mode: 'date' } as const

/**
 * What the orchestrator gates on, and the prompt it sends.
 *
 * `workspace_id` IS the primary key: one row per workspace is structural rather
 * than a unique key over a surrogate id. It is still a `workspace_id` column, so
 * 002_rls.sql's structural policy loop picks this table up with no edit to it.
 *
 * There is no `updated_by`, and no `last_sync_*`. WHO changed the config and what
 * it was before come from `change_log` — a denormalised copy here would be a
 * second source of truth that can drift from the rows it duplicates. Nothing
 * pushes bot config anywhere, so there is no sync status to record.
 *
 * No row exists until an admin first saves, and an absent row means exactly the
 * same thing as `is_provisioned = false` — see resolveBotConfig, which is the
 * only place that distinction is allowed to be resolved.
 */
export const botConfig = pgTable('bot_config', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  isProvisioned: boolean('is_provisioned').notNull().default(false),
  /** NULL means never customised, and resolves to DEFAULT_BOT_PROMPT. An empty
   *  or whitespace-only prompt is rejected before storage, so NULL stays the
   *  only representation of "no prompt". */
  prompt: text('prompt'),
  /** The behavioural constraints, stored apart from the prompt so an admin can
   *  rewrite the bot's persona without touching the safety rules, and so the two
   *  are audited as separate fields. They are only ever joined at send time, by
   *  buildSystemPrompt — never concatenated before storage. Same NULL semantics
   *  as `prompt`: NULL means never customised and resolves to DEFAULT_BOT_RULES. */
  rules: text('rules'),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  /** A convenience for the admin screen, not the audit record. Bumped explicitly
   *  by saveBotConfig — deliberately not a trigger, which would be a writer the
   *  audit path cannot see. */
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
})
