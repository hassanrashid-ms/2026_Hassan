import type { QueryClient } from '@tanstack/react-query';
import type { NavigateFunction } from 'react-router-dom';
import type {
  NotificationsResponse,
  NotificationView,
  TicketAssignedPayload,
} from '@support/types';
import { markNotificationRead } from '../api/agentApi.ts';
import { loadAgentSession, saveAgentSession, saveLastActiveWorkspaceId } from './agentSession.ts';

/**
 * Shared by NotificationBell's dropdown and the toast fired on `notification:new`
 * so opening a ticket behaves identically from either entry point: mark read,
 * then either navigate in place or, if the notification belongs to a
 * different workspace than the one currently active, swap workspace context
 * via a hard navigation — the in-memory query caches are scoped to the old
 * workspace, so a client-side route change alone would leave them stale.
 */
export async function openTicketFromNotification(
  token: string,
  notification: NotificationView,
  queryClient: QueryClient,
  navigate: NavigateFunction,
): Promise<void> {
  await markNotificationRead(token, notification.id);
  queryClient.setQueryData<NotificationsResponse>(['notifications'], (old) =>
    old
      ? {
          unread_count: Math.max(0, old.unread_count - (notification.read_at ? 0 : 1)),
          notifications: old.notifications.map((existing) =>
            existing.id === notification.id
              ? { ...existing, read_at: new Date().toISOString() }
              : existing,
          ),
        }
      : old,
  );

  const payload = notification.payload as TicketAssignedPayload;
  const current = loadAgentSession();
  if (current && payload.workspace_slug && current.workspaceSlug !== payload.workspace_slug) {
    saveAgentSession({ ...current, workspaceSlug: payload.workspace_slug, workspaceId: undefined });
    saveLastActiveWorkspaceId(''); // cleared; AgentConsoleShell's membership-fallback effect re-resolves workspaceId from the slug on next load
    if (notification.conversation_id) {
      window.location.assign(`/tickets/${notification.conversation_id}`);
    } else {
      window.location.reload();
    }
    return;
  }
  if (notification.conversation_id) navigate(`/tickets/${notification.conversation_id}`);
}
