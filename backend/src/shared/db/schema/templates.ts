// backend/src/shared/db/schema/templates.ts
import { boolean, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agent, workspace } from './identity.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

export const templateKind = pgEnum('template_kind', ['system', 'canned']);

/**
 * Both the configurable system messages (no_agents_online, handoff,
 * form_summary_completed/partial/skipped) and the agent canned-reply library
 * live in one table, discriminated by `kind`. A genuinely absent row for a
 * `system` key is not an error — loadTemplates() in templateService.ts
 * collapses it to the hardcoded default, the same pattern resolveBotConfig
 * uses for bot_config. `handoff` is the only key with more than one active
 * row per workspace; the others are singletons enforced in templateService,
 * not by a DB constraint (an admin PATCHing two rows active in a race is a
 * cosmetic "which one wins" question, not a correctness one, and adding a
 * partial-unique-index for it is not worth it for this feature).
 */
export const messageTemplate = pgTable('message_template', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  kind: templateKind('kind').notNull(),
  /** 'no_agents_online' | 'handoff' | 'form_summary_completed' | 'form_summary_partial' | 'form_summary_skipped' for kind='system'; null for kind='canned'. */
  key: text('key'),
  /** Display name for a canned reply, e.g. "Intro". Null for kind='system'. */
  label: text('label'),
  body: text('body').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdByAgentId: uuid('created_by_agent_id').references(() => agent.id, {
    onDelete: 'restrict',
  }),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
});
