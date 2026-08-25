import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import { fetchGlobalInbox, type GlobalInboxTicket } from '../../api/agentApi.ts';
import { loadAgentSession, saveAgentSession, saveLastActiveWorkspaceId } from '../../lib/agentSession.ts';
import { ScrollArea } from '../../components/ui/scroll-area.tsx';
import { ConversationRow } from '../Inbox/components/ConversationRow.tsx';

export function GlobalInbox() {
  const navigate = useNavigate();
  const session = loadAgentSession();

  const inboxQuery = useQuery({
    queryKey: ['global-inbox'],
    queryFn: () => fetchGlobalInbox(session!.token),
    enabled: session !== null,
  });

  if (!session) return null;

  function openTicket(ticket: GlobalInboxTicket) {
    if (ticket.workspace.id !== session!.workspaceId) {
      saveAgentSession({
        ...session!,
        workspaceId: ticket.workspace.id,
        workspaceSlug: ticket.workspace.slug,
      });
      saveLastActiveWorkspaceId(ticket.workspace.id);
      // Full navigation: switching workspace needs every workspace-scoped
      // query to remount fresh, same rationale as WorkspaceSwitcher.tsx.
      window.location.assign(`/inbox/${ticket.id}`);
      return;
    }
    navigate(`/inbox/${ticket.id}`);
  }

  const failedCount = inboxQuery.data?.failed_workspaces.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {failedCount > 0 && (
        <div className="px-3 py-2 text-xs text-muted">
          {failedCount} workspace{failedCount === 1 ? '' : 's'} failed to load.
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3 text-sm font-semibold">Global Inbox</div>
        {inboxQuery.data?.conversations.map((ticket) => (
          <div key={ticket.id} className="flex items-center gap-2 px-3">
            <span className="text-xs text-muted">{ticket.workspace.slug}</span>
            <div className="min-w-0 flex-1">
              <ConversationRow
                conversation={ticket}
                selected={false}
                onSelect={() => openTicket(ticket)}
              />
            </div>
          </div>
        ))}
        {inboxQuery.data?.conversations.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-8 text-muted">
            <MessageSquare className="size-8" />
            <p className="text-sm">No active tickets across your workspaces.</p>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
