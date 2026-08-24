import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { fetchWorkload, type AgentWorkloadEntry } from '../../api/agentApi.ts';
import { loadAgentSession } from '../../lib/agentSession.ts';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.tsx';
import { cn } from '../../lib/cn.ts';

type SortColumn = 'agent' | 'open' | 'resolved7d';
type SortDirection = 'asc' | 'desc';

const COLUMNS: { key: SortColumn; label: string }[] = [
  { key: 'agent', label: 'Agent' },
  { key: 'open', label: 'Open' },
  { key: 'resolved7d', label: 'Resolved (7d)' },
];

function sortAgents(
  agents: AgentWorkloadEntry[],
  column: SortColumn,
  direction: SortDirection,
): AgentWorkloadEntry[] {
  const sorted = [...agents].sort((a, b) => {
    let cmp: number;
    if (column === 'agent') cmp = a.agentName.localeCompare(b.agentName);
    else if (column === 'open') cmp = a.openCount - b.openCount;
    else cmp = a.resolved7d - b.resolved7d;
    return direction === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

export function Workload() {
  const session = loadAgentSession();
  // Default sort is Open descending.
  const [sortColumn, setSortColumn] = useState<SortColumn>('open');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const workload = useQuery({
    queryKey: ['workload'],
    queryFn: () => fetchWorkload(session!.token),
    enabled: session !== null,
  });

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
        <h1 className="text-sm font-semibold">Workload</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
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
            {sortedAgents.map((agent) => (
              <TableRow key={agent.agentId}>
                <TableCell className="font-medium">{agent.agentName}</TableCell>
                <TableCell>{agent.openCount}</TableCell>
                <TableCell>{agent.resolved7d}</TableCell>
              </TableRow>
            ))}
            {workload.isError && (
              <TableRow>
                <TableCell colSpan={3} className="text-xs text-muted">
                  Could not load workload.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
