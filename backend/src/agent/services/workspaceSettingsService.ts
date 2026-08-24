import { eq } from 'drizzle-orm';
import { workspace } from '../../shared/db/schema/index.ts';
import { withoutWorkspace, withWorkspace } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import { appendChangeLog } from '../../shared/changeLog/appendChangeLog.ts';

/** Entity type for the workspace-settings change_log rows. entityId is the workspace id itself, same convention as bot_config. */
export const WORKSPACE_SETTINGS_ENTITY_TYPE = 'workspace_settings';

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
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [before] = await tx
      .select(COLUMNS)
      .from(workspace)
      .where(eq(workspace.id, ctx.workspaceId))
      .limit(1);
    if (!before) throw new Error('workspace row missing for its own session');

    const [after] = await tx
      .update(workspace)
      .set(args)
      .where(eq(workspace.id, ctx.workspaceId))
      .returning(COLUMNS);
    if (!after) throw new Error('workspace row missing for its own session');

    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: WORKSPACE_SETTINGS_ENTITY_TYPE,
      entityId: ctx.workspaceId,
      actorId: ctx.agentId,
      changes: [
        {
          field: 'max_assigned_tickets',
          before: before.maxAssignedTickets,
          after: after.maxAssignedTickets,
        },
        { field: 'auto_close_days', before: before.autoCloseDays, after: after.autoCloseDays },
        {
          field: 'inactivity_window_hours',
          before: before.inactivityWindowHours,
          after: after.inactivityWindowHours,
        },
        {
          field: 'form_timeout_minutes',
          before: before.formTimeoutMinutes,
          after: after.formTimeoutMinutes,
        },
      ],
    });

    return toView(after);
  });
}
