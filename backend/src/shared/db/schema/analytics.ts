import { jsonb, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { DashboardLayout } from '@support/types';
import { agent, workspace } from './identity.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

/**
 * One row per agent per workspace: an agent's tile layout in workspace A
 * never affects workspace B. RLS (workspace_id) plus the route handler's own
 * `agentId = ctx.agentId` filter make this "my own resource".
 */
export const agentDashboardLayout = pgTable(
  'agent_dashboard_layout',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    layout: jsonb('layout').$type<DashboardLayout>().notNull(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.workspaceId] })],
);
