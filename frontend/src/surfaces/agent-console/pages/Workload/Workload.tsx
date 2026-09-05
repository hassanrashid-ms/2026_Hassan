import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import {
  fetchWorkload,
  type AgentWorkloadEntry,
  type AgentWorkloadResponse,
  type DisplayStatus,
} from '../../api/agentApi.ts';
import { loadAgentSession } from '../../lib/agentSession.ts';
import { createSocket } from '../../../../features/chat/api/socket.ts';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.tsx';
import { Avatar, AvatarFallback } from '../../components/ui/avatar.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { PresenceDot } from '../../components/PresenceDot.tsx';
import { EmptyState } from '../../components/ui/empty-state.tsx';
import { cn } from '../../lib/cn.ts';

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

type SortColumn = 'agent' | 'open' | 'escalated' | 'overdue' | 'resolved7d';
type SortDirection = 'asc' | 'desc';

const COLUMNS: { key: SortColumn; label: string }[] = [
  { key: 'agent', label: 'Agent' },
  { key: 'open', label: 'Open' },
  { key: 'escalated', label: 'Escalated' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'resolved7d', label: 'Resolved (7d)' },
];

const ROLE_LABEL: Record<AgentWorkloadEntry['role'], string> = {
  agent: 'Agent',
  team_lead: 'Team lead',
};

function initialsFor(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function sortAgents(
  agents: AgentWorkloadEntry[],
  column: SortColumn,
  direction: SortDirection,
): AgentWorkloadEntry[] {
  const sorted = [...agents].sort((a, b) => {
    let cmp: number;
    if (column === 'agent') cmp = a.agentName.localeCompare(b.agentName);
    else if (column === 'open') cmp = a.openCount - b.openCount;
    else if (column === 'escalated') cmp = a.escalatedCount - b.escalatedCount;
    else if (column === 'overdue') cmp = a.overdueCount - b.overdueCount;
    else cmp = a.resolved7d - b.resolved7d;
    return direction === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

export function Workload() {
  const session = loadAgentSession();
  const queryClient = useQueryClient();
  // Default sort is Open descending.
  const [sortColumn, setSortColumn] = useState<SortColumn>('open');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const workload = useQuery({
    queryKey: ['workload'],
    queryFn: () => fetchWorkload(session!.token),
    enabled: session !== null,
  });

  const sessionToken = session?.token;
  const sessionWorkspaceId = session?.workspaceId;

  useEffect(() => {
    if (!sessionToken) return;
    const socket = createSocket(sessionToken, 'agent', sessionWorkspaceId);
    socket.on(
      'presence_changed',
      (payload: {
        agentId: string;
        status: DisplayStatus;
        onLeaveSince?: string | null;
        onLeaveUntil?: string | null;
      }) => {
        queryClient.setQueryData<AgentWorkloadResponse>(['workload'], (current) => {
          if (!current) return current;
          return {
            agents: current.agents.map((agent) =>
              agent.agentId === payload.agentId
                ? {
                    ...agent,
                    status: payload.status,
                    onLeaveSince:
                      payload.status === 'on_leave'
                        ? (payload.onLeaveSince ?? agent.onLeaveSince)
                        : null,
                    onLeaveUntil:
                      payload.status === 'on_leave'
                        ? (payload.onLeaveUntil ?? agent.onLeaveUntil)
                        : null,
                  }
                : agent,
            ),
          };
        });
      },
    );
    return () => {
      socket.close();
    };
  }, [sessionToken, sessionWorkspaceId, queryClient]);

  if (!session) return null;

  function handleSort(column: SortColumn) {
    if (column === sortColumn) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  }

  const agents = workload.data?.agents ?? [];
  const sortedAgents = sortAgents(agents, sortColumn, sortDirection);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-slate-200 p-3">
        <h1 className="text-sm font-semibold">Team</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {workload.data && sortedAgents.length === 0 ? (
          <EmptyState message="Nothing to show" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {COLUMNS.map((col) => (
                  <TableHead key={col.key}>
                    <button
                      type="button"
                      onClick={() => handleSort(col.key)}
                      className={cn(
                        'flex items-center gap-1 text-xs font-medium text-muted hover:text-text',
                      )}
                    >
                      {col.label}
                      {sortColumn === col.key &&
                        (sortDirection === 'asc' ? (
                          <ArrowUp className="size-3" />
                        ) : (
                          <ArrowDown className="size-3" />
                        ))}
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedAgents.map((agent) => {
                const atCapacity = agent.openCount >= agent.capacityMax;
                return (
                  <TableRow key={agent.agentId}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <div className="relative">
                          <Avatar className="size-6">
                            <AvatarFallback className="text-xs">
                              {initialsFor(agent.agentName)}
                            </AvatarFallback>
                          </Avatar>
                          <PresenceDot
                            status={agent.status}
                            className="absolute -right-0.5 -bottom-0.5 size-2"
                          />
                        </div>
                        <span data-testid="agent-name">{agent.agentName}</span>
                        {agent.agentId === session.agentId && <Badge variant="outline">You</Badge>}
                        <Badge variant="secondary">{ROLE_LABEL[agent.role]}</Badge>
                        {agent.status === 'on_leave' && agent.onLeaveSince && (
                          <span data-testid="leave-duration" className="text-xs text-muted">
                            on leave {daysSince(agent.onLeaveSince)}d
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span
                        data-testid="capacity-cell"
                        data-at-capacity={atCapacity}
                        className={cn(atCapacity && 'font-medium text-amber-700')}
                      >
                        {agent.openCount}/{agent.capacityMax}
                      </span>
                    </TableCell>
                    <TableCell data-testid="escalated-count">{agent.escalatedCount}</TableCell>
                    <TableCell data-testid="overdue-count">{agent.overdueCount}</TableCell>
                    <TableCell>{agent.resolved7d}</TableCell>
                  </TableRow>
                );
              })}
              {workload.isError && (
                <TableRow>
                  <TableCell colSpan={5} className="text-xs text-muted">
                    Could not load workload.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
