import { eq } from 'drizzle-orm';
import { workspace } from '../../shared/db/schema/index.ts';
import { withoutWorkspace } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';

export type WorkspaceSettingsView = {
  max_assigned_tickets: number;
  auto_close_days: number;
  inactivity_window_hours: number;
  form_timeout_minutes: number;
};

const COLUMNS = {
  maxAssignedTickets: workspace.maxAssignedTickets,
  autoCloseDays: workspace.autoCloseDays,
  inactivityWindowHours: workspace.inactivityWindowHours,
  formTimeoutMinutes: workspace.formTimeoutMinutes,
};

function toView(row: {
  maxAssignedTickets: number;
  autoCloseDays: number;
  inactivityWindowHours: number;
  formTimeoutMinutes: number;
}): WorkspaceSettingsView {
  return {
    max_assigned_tickets: row.maxAssignedTickets,
    auto_close_days: row.autoCloseDays,
    inactivity_window_hours: row.inactivityWindowHours,
    form_timeout_minutes: row.formTimeoutMinutes,
  };
}

export async function getWorkspaceSettings(ctx: AgentContext): Promise<WorkspaceSettingsView> {
  const [row] = await withoutWorkspace(async (tx) =>
    tx.select(COLUMNS).from(workspace).where(eq(workspace.id, ctx.workspaceId)).limit(1),
  );
  if (!row) throw new Error('workspace row missing for its own session');
  return toView(row);
}

export async function saveWorkspaceSettings(
  ctx: AgentContext,
  args: {
    maxAssignedTickets: number;
    autoCloseDays: number;
    inactivityWindowHours: number;
    formTimeoutMinutes: number;
  },
): Promise<WorkspaceSettingsView> {
  const [row] = await withoutWorkspace(async (tx) =>
    tx
      .update(workspace)
      .set(args)
      .where(eq(workspace.id, ctx.workspaceId))
      .returning(COLUMNS),
  );
  if (!row) throw new Error('workspace row missing for its own session');
  return toView(row);
}
