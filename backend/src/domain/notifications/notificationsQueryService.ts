import { and, desc, eq, isNull } from 'drizzle-orm';
import pLimit from 'p-limit';
import type { NotificationView } from '@support/types';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import { notification } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import {
  listActiveMembershipsForAgent,
  listAllWorkspaces,
} from '../../shared/db/workspaceMembership.ts';
import { toNotificationView } from './notifyAgent.ts';

const PER_WORKSPACE_CAP = 20;
const TOTAL_CAP = 20;
const SCATTER_CONCURRENCY = 10;

async function targetWorkspaceIds(ctx: AgentContext): Promise<string[]> {
  return ctx.isAdmin
    ? (await listAllWorkspaces()).map((w) => w.workspaceId)
    : (await listActiveMembershipsForAgent(ctx.agentId)).map((m) => m.workspaceId);
}

export async function listNotificationsForAgent(
  ctx: AgentContext,
): Promise<{ notifications: NotificationView[]; unread_count: number }> {
  const workspaceIds = await targetWorkspaceIds(ctx);
  const limit = pLimit(SCATTER_CONCURRENCY);

  const slices = await Promise.all(
    workspaceIds.map((wsId) =>
      limit(() =>
        withWorkspace(wsId, async (tx) => {
          const rows = await tx
            .select()
            .from(notification)
            .where(eq(notification.agentId, ctx.agentId))
            .orderBy(desc(notification.createdAt))
            .limit(PER_WORKSPACE_CAP);
          const unread = rows.filter((r) => r.readAt === null).length;
          return { views: rows.map(toNotificationView), unread };
        }),
      ),
    ),
  );

  const merged = slices
    .flatMap((s) => s.views)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, TOTAL_CAP);
  const unread_count = slices.reduce((sum, s) => sum + s.unread, 0);

  return { notifications: merged, unread_count };
}

export async function markNotificationRead(
  ctx: AgentContext,
  notificationId: string,
): Promise<boolean> {
  const workspaceIds = await targetWorkspaceIds(ctx);
  const limit = pLimit(SCATTER_CONCURRENCY);

  const results = await Promise.all(
    workspaceIds.map((wsId) =>
      limit(() =>
        withWorkspace(wsId, async (tx) => {
          const updated = await tx
            .update(notification)
            .set({ readAt: new Date() })
            .where(and(eq(notification.id, notificationId), eq(notification.agentId, ctx.agentId)))
            .returning({ id: notification.id });
          return updated.length > 0;
        }),
      ),
    ),
  );

  return results.some(Boolean);
}

export async function markAllNotificationsRead(ctx: AgentContext): Promise<number> {
  const workspaceIds = await targetWorkspaceIds(ctx);
  const limit = pLimit(SCATTER_CONCURRENCY);

  const counts = await Promise.all(
    workspaceIds.map((wsId) =>
      limit(() =>
        withWorkspace(wsId, async (tx) => {
          const updated = await tx
            .update(notification)
            .set({ readAt: new Date() })
            .where(and(eq(notification.agentId, ctx.agentId), isNull(notification.readAt)))
            .returning({ id: notification.id });
          return updated.length;
        }),
      ),
    ),
  );

  return counts.reduce((sum, c) => sum + c, 0);
}
