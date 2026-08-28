import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { agent, workspace } from './identity.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

/**
 * What the orchestrator gates on, and the prompt it sends.
 *
 * Every workspace has a real row from the moment it's provisioned — see
 * seedBotConfig in domain/bot/botConfig.ts. `prompt`, `rules` and
 * `tools_config` are NOT NULL: there is no more virtual "resolve absent to
 * default" for these three columns. A genuinely absent bot_config ROW (a
 * workspace that predates seeding, or a test that never seeded one) still
 * resolves to the off state on the catalog baseline — that collapse lives in
 * resolveBotConfig, the only place it's allowed to happen.
 */
export const botConfig = pgTable('bot_config', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  isProvisioned: boolean('is_provisioned').notNull().default(false),
  prompt: text('prompt').notNull(),
  /** RuleEntry[] — the toggleable catalog plus any admin-added custom rules. */
  rules: jsonb('rules').notNull(),
  /** ToolToggle[] — one entry per TOOL_CATALOG name (never 'handoff'). */
  toolsConfig: jsonb('tools_config').notNull(),
  /** LimitToggle[] — one entry per LIMIT_CATALOG key; see domain/bot/limitsCatalog.ts. */
  limitsConfig: jsonb('limits_config').notNull(),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
});

/**
 * A full snapshot of bot_config, one row per save. Unlike change_log (field-level,
 * generic across entity types), this is bot_config-specific and always carries all
 * four fields together, so "what did the whole bot look like at v3" is one row, not
 * a join across four change_log entries that may not even share a changed_at.
 *
 * Append-only, same enforcement as change_log: REVOKE UPDATE, DELETE in 002_rls.sql.
 *
 * `version` is 1-based per workspace, assigned as MAX(version)+1 inside the same
 * transaction as the bot_config write in saveBotConfig — never computed from row
 * count, which would be wrong the moment a version is ever skipped for any reason.
 *
 * `changed_fields` is computed at write time (which of prompt/rules/tools_config/
 * limits_config actually differ from the immediately prior version) so the version
 * list can show "v4 — Prompt, Rules" without loading two full snapshots per row.
 */
export const botConfigVersion = pgTable(
  'bot_config_version',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    prompt: text('prompt').notNull(),
    rules: jsonb('rules').notNull(),
    toolsConfig: jsonb('tools_config').notNull(),
    limitsConfig: jsonb('limits_config').notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'restrict' }),
    /** Subset of 'prompt' | 'rules' | 'tools_config' | 'limits_config'. */
    changedFields: text('changed_fields').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('bot_config_version_workspace_version_unique').on(t.workspaceId, t.version),
    index('bot_config_version_workspace_created_idx').on(t.workspaceId, t.createdAt),
    check('bot_config_version_has_changes', sql`array_length(${t.changedFields}, 1) > 0`),
  ],
);
