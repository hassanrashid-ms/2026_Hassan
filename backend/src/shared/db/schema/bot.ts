import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workspace } from './identity.ts';

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
