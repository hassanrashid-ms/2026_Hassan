import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agent, workspace } from './identity.ts';
import { conversation } from './conversations.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    conversationId: uuid('conversation_id').references(() => conversation.id, {
      onDelete: 'restrict',
    }),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    readAt: timestamp('read_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [index('notification_agent_workspace_read_idx').on(t.agentId, t.workspaceId, t.readAt)],
);
