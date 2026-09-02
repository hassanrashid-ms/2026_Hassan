import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { fetchMemberships } from '../api/agentApi.ts';
import {
  saveAgentSession,
  saveLastActiveWorkspaceId,
  type StoredAgentSession,
} from '../lib/agentSession.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx';

export function WorkspaceSwitcher({ session }: { session: StoredAgentSession }) {
  const membershipsQuery = useQuery({
    queryKey: ['memberships'],
    queryFn: () => fetchMemberships(session.token),
  });
  const memberships = membershipsQuery.data?.memberships ?? [];
  const current = memberships.find((m) => m.workspace_id === session.workspaceId);

  function selectWorkspace(membership: (typeof memberships)[number]) {
    if (membership.workspace_id === session.workspaceId) return;
    saveAgentSession({
      ...session,
      workspaceId: membership.workspace_id,
      workspaceSlug: membership.workspace_slug,
      role: membership.role,
    });
    saveLastActiveWorkspaceId(membership.workspace_id);
    // A full navigation, not a client-side reload: no query key in this app
    // is namespaced by workspace, so every workspace-scoped query needs a
    // fresh mount to stop showing the previous workspace's cached data.
    window.location.assign('/inbox');
  }

  // Nothing to switch between — show the workspace name as plain text so the
  // header's left slot still occupies space and the avatar/logout button on
  // the right stays pinned there (the header is `justify-between`).
  if (memberships.length <= 1) {
    return (
      <span className="text-sm font-medium text-text">
        {current?.workspace_name ?? session.workspaceSlug}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex items-center gap-1 text-sm font-medium text-text">
          {current?.workspace_name ?? session.workspaceSlug}
          <ChevronDown className="size-3.5 text-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {memberships.map((m) => (
          <DropdownMenuItem key={m.workspace_id} onSelect={() => selectWorkspace(m)}>
            {m.workspace_name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
