import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { fetchGlobalInbox, type GlobalInboxTicket } from '../../api/agentApi.ts';
import {
  loadAgentSession,
  saveAgentSession,
  saveLastActiveWorkspaceId,
} from '../../lib/agentSession.ts';
import { ScrollArea } from '../../components/ui/scroll-area.tsx';
import { EmptyState } from '../../components/ui/empty-state.tsx';
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

  // Groups preserve the backend's per-workspace ordering (first appearance),
  // so each workspace's own tickets stay sorted by priority/recency together.
  const groups: { workspace: GlobalInboxTicket['workspace']; tickets: GlobalInboxTicket[] }[] = [];
  for (const ticket of inboxQuery.data?.conversations ?? []) {
    const group = groups.find((g) => g.workspace.id === ticket.workspace.id);
    if (group) group.tickets.push(ticket);
    else groups.push({ workspace: ticket.workspace, tickets: [ticket] });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {failedCount > 0 && (
        <div className="px-3 py-2 text-xs text-muted">
          {failedCount} workspace{failedCount === 1 ? '' : 's'} failed to load.
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3 text-sm font-semibold">Global Inbox</div>
        {groups.map((group) => (
          <div key={group.workspace.id}>
            <div className="px-3 py-2 text-sm font-bold text-text">{group.workspace.name}</div>
            {group.tickets.map((ticket) => (
              <ConversationRow
                key={ticket.id}
                conversation={ticket}
                selected={false}
                onSelect={() => openTicket(ticket)}
              />
            ))}
          </div>
        ))}
        {inboxQuery.data?.conversations.length === 0 && <EmptyState message="Nothing to show" />}
      </ScrollArea>
    </div>
  );
}
