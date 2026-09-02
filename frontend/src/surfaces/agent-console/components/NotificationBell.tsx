import { Bell } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationsResponse, NotificationView, TicketAssignedPayload } from '@support/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx';
import { Badge } from './ui/badge.tsx';
import { fetchNotifications, markAllNotificationsRead } from '../api/agentApi.ts';
import { type StoredAgentSession } from '../lib/agentSession.ts';
import { openTicketFromNotification } from '../lib/notificationNavigation.ts';

export function NotificationBell({ session }: { session: StoredAgentSession }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => fetchNotifications(session.token),
  });

  const notifications = data?.notifications ?? [];
  const unreadCount = data?.unread_count ?? 0;

  async function handleSelect(n: NotificationView) {
    await openTicketFromNotification(session.token, n, queryClient, navigate);
  }

  async function handleMarkAllRead() {
    await markAllNotificationsRead(session.token);
    queryClient.setQueryData<NotificationsResponse>(['notifications'], (old) =>
      old
        ? {
            unread_count: 0,
            notifications: old.notifications.map((n) => ({
              ...n,
              read_at: n.read_at ?? new Date().toISOString(),
            })),
          }
        : old,
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative flex size-8 items-center justify-center rounded-md text-muted hover:bg-accent-soft/60 hover:text-text"
        >
          <Bell className="size-4.5" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full border-none bg-red-500 px-1 text-[10px] text-white"
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </Badge>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={12} className="w-80">
        <div className="flex items-center justify-between px-2 py-1.5">
          <DropdownMenuLabel className="p-0">Notifications</DropdownMenuLabel>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={() => void handleMarkAllRead()}
              className="text-xs font-medium text-accent hover:underline"
            >
              Mark all as read
            </button>
          )}
        </div>
        <DropdownMenuSeparator />
        {notifications.length === 0 && (
          <div className="px-2 py-6 text-center text-sm text-muted">No notifications yet.</div>
        )}
        {/* Capped and scrollable — the query already keeps at most 20, which
            is more than fits in a dropdown without one. Header/label above
            stays pinned; only this list scrolls. */}
        <div className="max-h-96 overflow-y-auto">
          {notifications.map((n) => {
            const payload = n.payload as TicketAssignedPayload;
            return (
              <DropdownMenuItem
                key={n.id}
                onSelect={() => void handleSelect(n)}
                className={n.read_at ? undefined : 'bg-accent-soft/60'}
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-text">
                    Ticket #{payload.ticket_number} assigned to you
                  </span>
                  <span className="text-xs text-muted">
                    {payload.workspace_name} · {payload.priority?.toUpperCase()}
                  </span>
                </div>
              </DropdownMenuItem>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
