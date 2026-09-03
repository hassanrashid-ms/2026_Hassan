import { useEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import type { ConversationStatusValue } from '@support/types';
import { useInfiniteQuery, useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  claimConversation,
  fetchInbox,
  sweepAssign,
  type ConversationListFilter,
  type SweepAssignStopReason,
  type TicketsQueryFilters,
} from '../../api/agentApi.ts';
import { loadAgentSession, canBuildForms } from '../../lib/agentSession.ts';
import { cn } from '../../lib/cn.ts';
import { toast } from 'sonner';
import { createSocket } from '../../../../features/chat/api/socket.ts';
import { handleSessionExpired } from '../../lib/authErrorHandling.ts';
import { ConversationDetailPane } from '../../components/ConversationDetailPane.tsx';
import { EmptyState } from '../../components/ui/empty-state.tsx';
import {
  ConversationRow,
  PRIORITY_BADGE_VARIANT,
  STATUS_BADGE_VARIANT,
  formatStatus,
} from '../Inbox/components/ConversationRow.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { tagBadgeClassName } from '../../lib/tagBadge.ts';
import { TicketsFilterBar } from './TicketsFilterBar.tsx';
import { useTicketsFilters } from './useTicketsFilters.ts';
import { QUEUE_OPTIONS } from './queues.ts';
import { SortableHeader, type SortState } from './SortableHeader.tsx';

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';

const COLUMNS: { title: string; filter: ConversationListFilter; claimable?: boolean }[] =
  QUEUE_OPTIONS.map((q) => ({
    title: q.title,
    filter: q.value,
    claimable: q.value === 'unassigned',
  }));

function toQueryFilters(f: ReturnType<typeof useTicketsFilters>[0]): TicketsQueryFilters {
  return {
    q: f.q || undefined,
    priority: f.priority.length ? f.priority : undefined,
    labelIds: f.labelIds.length ? f.labelIds : undefined,
    subintentIds: f.subintentIds.length ? f.subintentIds : undefined,
    assigneeIds: f.assigneeIds.length ? f.assigneeIds : undefined,
    olderThanHours: f.olderThanHours ? Number(f.olderThanHours) : undefined,
    statuses: f.statuses.length ? f.statuses : undefined,
    createdFrom: f.createdFrom || undefined,
    createdTo: f.createdTo || undefined,
    sortBy: f.sortBy,
    sortDir: f.sortDir,
    sortBy2: f.sortBy2,
    sortDir2: f.sortDir2,
  };
}

function hasActiveFilters(f: TicketsQueryFilters): boolean {
  return Boolean(
    f.q ||
      f.priority ||
      f.labelIds ||
      f.subintentIds ||
      f.assigneeIds ||
      f.olderThanHours ||
      f.statuses ||
      f.createdFrom ||
      f.createdTo,
  );
}

function SortableQueueColumn({
  id,
  col,
  token,
  queryFilters,
  filtersActive,
  onSelect,
  bulkAssignAvailable,
  bulkAssignPending,
  onBulkAssign,
}: {
  id: string;
  col: (typeof COLUMNS)[0];
  token: string;
  queryFilters: TicketsQueryFilters;
  filtersActive: boolean;
  onSelect: (id: string) => void;
  bulkAssignAvailable: boolean;
  bulkAssignPending: boolean;
  onBulkAssign: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <QueueColumn
        dragHandleProps={{ ...attributes, ...listeners }}
        token={token}
        title={col.title}
        filter={col.filter}
        claimable={col.claimable}
        queryFilters={queryFilters}
        filtersActive={filtersActive}
        onSelect={onSelect}
        bulkAssignAvailable={bulkAssignAvailable}
        bulkAssignPending={bulkAssignPending}
        onBulkAssign={onBulkAssign}
      />
    </div>
  );
}

function QueueColumn({
  token,
  title,
  filter,
  queryFilters,
  filtersActive,
  claimable = false,
  dragHandleProps,
  onSelect,
  bulkAssignAvailable,
  bulkAssignPending,
  onBulkAssign,
}: {
  token: string;
  title: string;
  filter: ConversationListFilter;
  queryFilters: TicketsQueryFilters;
  filtersActive: boolean;
  claimable?: boolean;
  dragHandleProps?: Record<string, any>;
  onSelect: (id: string) => void;
  bulkAssignAvailable: boolean;
  bulkAssignPending: boolean;
  onBulkAssign: () => void;
}) {
  const queryClient = useQueryClient();
  const queue = useInfiniteQuery({
    queryKey: ['tickets', filter, queryFilters],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      fetchInbox(token, filter, queryFilters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const claim = useMutation({
    mutationFn: (conversationId: string) => claimConversation(token, conversationId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tickets'] }),
  });

  const sectionRef = useRef<HTMLElement>(null);
  const [height] = useState(() => localStorage.getItem(`queueHeight_${filter}`) || '400px');

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const borderBoxHeight =
          entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
        if (borderBoxHeight > 50) {
          localStorage.setItem(`queueHeight_${filter}`, `${borderBoxHeight}px`);
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [filter]);

  const conversations = queue.data?.pages.flatMap((page) => page.conversations) ?? [];

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom && queue.hasNextPage && !queue.isFetchingNextPage) {
      void queue.fetchNextPage();
    }
  }

  if (queue.data && conversations.length === 0 && !filtersActive) return null;
  return (
    <section
      ref={sectionRef}
      style={{ height, minHeight: '150px' }}
      className="flex min-h-0 flex-col rounded-card border border-border bg-surface shadow-card resize-y overflow-hidden pb-1"
    >
      <div className="flex shrink-0 items-center justify-between rounded-t-card border-b border-border bg-accent-soft/40 px-3 py-2">
        <div className="flex items-center gap-2">
          {dragHandleProps && (
            <div
              {...dragHandleProps}
              className="cursor-grab active:cursor-grabbing text-muted hover:text-text"
            >
              <GripVertical className="size-4" />
            </div>
          )}
          <h2 className="text-sm font-semibold">{title}</h2>
        </div>
        <div className="flex items-center gap-2">
          {filter === 'unassigned' && bulkAssignAvailable && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={bulkAssignPending}
              onClick={onBulkAssign}
            >
              Bulk assign
            </Button>
          )}
          <span className="text-xs text-muted">{conversations.length}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" onScroll={handleScroll}>
        {conversations.length === 0 && filtersActive && (
          <p className="p-3 text-xs text-muted">No tickets match your filters.</p>
        )}
        {conversations.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            selected={false}
            onSelect={() => onSelect(conversation.id)}
            onClaim={claimable ? () => claim.mutate(conversation.id) : undefined}
            claiming={claim.isPending}
          />
        ))}
        {queue.isFetchingNextPage && <p className="p-3 text-xs text-muted">Loading more...</p>}
        {queue.isError && <p className="p-3 text-xs text-muted">Could not load tickets.</p>}
      </div>
    </section>
  );
}

function TicketsListView({
  token,
  queryFilters,
  sort,
  onSort,
  onSelect,
  bulkAssignAvailable,
  bulkAssignPending,
  onBulkAssign,
  unassignedCount,
}: {
  token: string;
  queryFilters: TicketsQueryFilters;
  sort: SortState;
  onSort: (next: SortState) => void;
  onSelect: (id: string) => void;
  bulkAssignAvailable: boolean;
  bulkAssignPending: boolean;
  onBulkAssign: () => void;
  unassignedCount: number;
}) {
  const queryClient = useQueryClient();
  const queue = useInfiniteQuery({
    queryKey: ['tickets', 'all', queryFilters],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      fetchInbox(token, 'all', queryFilters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const claim = useMutation({
    mutationFn: (conversationId: string) => claimConversation(token, conversationId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tickets'] }),
  });

  const conversations = queue.data?.pages.flatMap((page) => page.conversations) ?? [];

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom && queue.hasNextPage && !queue.isFetchingNextPage) {
      void queue.fetchNextPage();
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {bulkAssignAvailable && unassignedCount > 0 && (
        <div className="mb-2 flex items-center justify-between rounded-card border border-border bg-accent-soft/40 px-3 py-2">
          <p className="text-sm text-text">
            {unassignedCount} ticket{unassignedCount === 1 ? '' : 's'} waiting to be assigned
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={bulkAssignPending}
            onClick={onBulkAssign}
          >
            Bulk assign
          </Button>
        </div>
      )}
      <div
        style={{ height: '70vh' }}
        className="min-h-0 flex-1 overflow-auto rounded-card border border-border bg-bg shadow-card"
        onScroll={handleScroll}
      >
        <table className="w-full min-w-[860px] border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-accent-soft/40">
          <tr className="border-b border-border text-left text-xs font-semibold tracking-wide text-muted uppercase">
            <SortableHeader label="Player" sortKey="player" sort={sort} onSort={onSort} />
            <SortableHeader label="Status" sortKey="status" sort={sort} onSort={onSort} />
            <SortableHeader label="Priority" sortKey="priority" sort={sort} onSort={onSort} />
            <SortableHeader label="Assignee" sortKey="assignee" sort={sort} onSort={onSort} />
            <SortableHeader label="Last message" sortKey="lastMessage" sort={sort} onSort={onSort} />
            <SortableHeader label="Tags" sortKey="tags" sort={sort} onSort={onSort} />
            <SortableHeader label="Created" sortKey="created" sort={sort} onSort={onSort} />
            <SortableHeader label="Subintent" sortKey="subintent" sort={sort} onSort={onSort} />
            <SortableHeader label="Ticket #" sortKey="number" sort={sort} onSort={onSort} />
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {conversations.length === 0 && !queue.isLoading ? (
            <tr>
              <td colSpan={10} className="p-3 text-xs text-muted">
                No tickets match your filters.
              </td>
            </tr>
          ) : (
            conversations.map((conversation) => {
              const claimable =
                conversation.assigned_agent_id === null &&
                (conversation.status === 'open' || conversation.status === 'escalated');
              return (
                <tr
                  key={conversation.id}
                  tabIndex={0}
                  onClick={() => onSelect(conversation.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onSelect(conversation.id);
                  }}
                  className="cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-accent-soft/50"
                >
                  <td className="max-w-40 truncate px-4 py-2.5 font-medium">
                    {conversation.player.external_player_id}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={STATUS_BADGE_VARIANT[conversation.status]}>
                      {formatStatus(conversation.status)}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={PRIORITY_BADGE_VARIANT[conversation.priority]}>
                      {conversation.priority.toUpperCase()}
                    </Badge>
                  </td>
                  <td className="max-w-32 truncate px-4 py-2.5 text-muted">
                    {conversation.assigned_agent_name ?? 'Unassigned'}
                  </td>
                  <td className="max-w-xs truncate px-4 py-2.5 text-muted">
                    {conversation.last_message_preview ?? '(no messages)'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex max-w-[160px] flex-wrap items-center gap-1 overflow-hidden">
                      {conversation.tags.slice(0, 2).map((tag) => (
                        <Badge
                          key={tag.id}
                          className={cn('max-w-20 truncate', tagBadgeClassName(tag.colorIndex))}
                        >
                          {tag.name}
                        </Badge>
                      ))}
                      {conversation.tags.length > 2 && (
                        <span className="shrink-0 text-xs text-muted">
                          +{conversation.tags.length - 2}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {format(new Date(conversation.created_at), 'MMM d, yyyy h:mm a')}
                  </td>
                  <td className="max-w-32 truncate px-4 py-2.5 text-muted">
                    {conversation.subintent?.name ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">
                    {conversation.number}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {claimable && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={claim.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          claim.mutate(conversation.id);
                        }}
                      >
                        Claim
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
        </table>
        {queue.isFetchingNextPage && <p className="p-3 text-xs text-muted">Loading more...</p>}
        {queue.isError && <p className="p-3 text-xs text-muted">Could not load tickets.</p>}
      </div>
    </div>
  );
}

function sweepStopReasonText(reason: SweepAssignStopReason): string {
  switch (reason) {
    case 'no_active_agents':
      return 'no agents are assigned to this workspace';
    case 'all_at_capacity':
      return 'all agents are at capacity';
    case 'none_online':
    case 'queue_empty':
      return 'no agents are online';
  }
}

export function Tickets() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const session = loadAgentSession();
  const queryClient = useQueryClient();
  const sweep = useMutation({
    mutationFn: () => sweepAssign(session!.token),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets-summary'] });
      if (result.stopReason === 'queue_empty' && result.assignedCount === 0) {
        toast.success('No unassigned tickets.');
      } else if (result.remainingCount === 0) {
        toast.success(`Assigned ${result.assignedCount} tickets.`);
      } else {
        toast.warning(
          `Assigned ${result.assignedCount} tickets. ${result.remainingCount} remain unassigned — ${sweepStopReasonText(result.stopReason)}.`,
        );
      }
    },
    onError: () => toast.error("Couldn't run the assignment sweep."),
  });
  const canBulkAssign = Boolean(session && canBuildForms(session));
  const [filters, updateFilters] = useTicketsFilters();
  const queryFilters = toQueryFilters(filters);
  const filtersActive = hasActiveFilters(queryFilters);

  const sessionToken = session?.token;
  const sessionWorkspaceId = session?.workspaceId;

  useEffect(() => {
    if (!sessionToken) return;
    const socket = createSocket(sessionToken, 'agent', sessionWorkspaceId);
    socket.on('connect_error', (error) => {
      if (error.message === 'unauthorized') handleSessionExpired();
    });
    socket.on(
      'conversation:changed',
      (payload: { conversation_id?: unknown; status?: unknown }) => {
        const status = payload.status as ConversationStatusValue | undefined;
        const filtersToInvalidate: ConversationListFilter[] =
          status === 'bot_active'
            ? ['botHandling']
            : status === 'resolved'
              ? ['resolved']
              : status === 'closed'
                ? ['closed']
                : ['unassigned', 'agentAssigned', 'escalated'];
        for (const filter of filtersToInvalidate)
          void queryClient.invalidateQueries({ queryKey: ['tickets', filter] });
        void queryClient.invalidateQueries({ queryKey: ['tickets', 'all'] });
        const changedId = payload.conversation_id;
        if (typeof changedId === 'string')
          void queryClient.invalidateQueries({ queryKey: ['conversation', changedId, 'detail'] });
      },
    );
    return () => {
      socket.close();
    };
  }, [sessionToken, sessionWorkspaceId, queryClient]);

  // List view only renders the 'unassigned' banner count and (when a conversation is
  // selected) needs to find that conversation's summary — it never displays the other
  // five columns. Fetching all six on every filter/sort change was firing 6 parallel
  // GET requests per keystroke-driven filter update, burning through the reads-tier
  // rate limit; board view still needs all six to render its columns.
  const needsAllSummaries = filters.view === 'board' || Boolean(conversationId);
  const summaryQueries = useQueries({
    queries: COLUMNS.map(({ filter }) => ({
      queryKey: ['tickets-summary', filter, queryFilters],
      queryFn: () => fetchInbox(session!.token, filter, queryFilters),
      enabled: session !== null && (needsAllSummaries || filter === 'unassigned'),
    })),
  });

  const summary = (() => {
    if (!conversationId) return undefined;
    for (const query of summaryQueries) {
      const found = query.data?.conversations?.find(
        (conversation) => conversation.id === conversationId,
      );
      if (found) return found;
    }
    return undefined;
  })();

  const unassignedColumnIndex = COLUMNS.findIndex((c) => c.filter === 'unassigned');
  const unassignedCount = summaryQueries[unassignedColumnIndex]?.data?.conversations.length ?? 0;

  const [columnOrder, setColumnOrder] = useState<ConversationListFilter[]>(() => {
    const saved = localStorage.getItem('ticketsColumnOrder');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === COLUMNS.length) return parsed;
      } catch {}
    }
    return COLUMNS.map((c) => c.filter);
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!session) return null;
  if (conversationId) {
    return (
      <ConversationDetailPane
        token={session.token}
        agentId={session.agentId}
        conversationId={conversationId}
        summary={summary}
        onBack={() => navigate('/tickets')}
      />
    );
  }

  function handleDragEnd(event: any) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setColumnOrder((items) => {
        const oldIndex = items.indexOf(active.id as ConversationListFilter);
        const newIndex = items.indexOf(over.id as ConversationListFilter);
        const newItems = arrayMove(items, oldIndex, newIndex);
        localStorage.setItem('ticketsColumnOrder', JSON.stringify(newItems));
        return newItems;
      });
    }
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Tickets</h1>
          <p className="text-sm text-muted">All active queues at a glance</p>
        </div>
        <div className="flex shrink-0 gap-1 rounded-md border border-border bg-bg p-0.5 shadow-xs">
          <button
            type="button"
            aria-pressed={filters.view === 'board'}
            className={cn(
              'rounded px-3 py-1 text-xs font-medium transition-colors',
              filters.view === 'board'
                ? 'bg-accent text-accent-fg shadow-xs'
                : 'text-muted hover:text-text',
            )}
            onClick={() => updateFilters({ view: 'board' })}
          >
            Board
          </button>
          <button
            type="button"
            aria-pressed={filters.view === 'list'}
            className={cn(
              'rounded px-3 py-1 text-xs font-medium transition-colors',
              filters.view === 'list'
                ? 'bg-accent text-accent-fg shadow-xs'
                : 'text-muted hover:text-text',
            )}
            onClick={() => updateFilters({ view: 'list' })}
          >
            List
          </button>
        </div>
      </div>
      <div className="mb-4">
        <TicketsFilterBar token={session.token} filters={filters} onChange={updateFilters} />
      </div>
      {filters.view === 'list' ? (
        <TicketsListView
          token={session.token}
          queryFilters={queryFilters}
          sort={{
            primary: filters.sortBy,
            primaryDir: filters.sortDir,
            secondary: filters.sortBy2,
            secondaryDir: filters.sortDir2,
          }}
          onSort={(next) =>
            updateFilters({
              sortBy: next.primary,
              sortDir: next.primaryDir,
              sortBy2: next.secondary,
              sortDir2: next.secondaryDir,
            })
          }
          onSelect={(id) => navigate(`/tickets/${id}`)}
          bulkAssignAvailable={canBulkAssign}
          bulkAssignPending={sweep.isPending}
          onBulkAssign={() => sweep.mutate()}
          unassignedCount={unassignedCount}
        />
      ) : (
        <>
          {!filtersActive &&
            summaryQueries.every((q) => q.data) &&
            summaryQueries.every((q) => q.data!.conversations.length === 0) && (
              <EmptyState message="Nothing to show" />
            )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={columnOrder} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
                {[
                  columnOrder.filter((_, i) => i % 2 === 0),
                  columnOrder.filter((_, i) => i % 2 === 1),
                ].map((filters_, columnIndex) => (
                  <div key={columnIndex} className="flex flex-col gap-4">
                    {filters_.map((filter) => {
                      const col = COLUMNS.find((c) => c.filter === filter)!;
                      const queryIndex = COLUMNS.findIndex((c) => c.filter === filter);
                      const summaryQuery = summaryQueries[queryIndex];
                      const isHidden = Boolean(
                        summaryQuery?.data &&
                          summaryQuery.data.conversations.length === 0 &&
                          !filtersActive,
                      );
                      const excludedByStatusFilter =
                        filters.statuses.length > 0 && !filters.statuses.includes(filter);
                      if (isHidden || excludedByStatusFilter) return null;

                      return (
                        <SortableQueueColumn
                          key={filter}
                          id={filter}
                          col={col}
                          token={session.token}
                          queryFilters={queryFilters}
                          filtersActive={filtersActive}
                          onSelect={(id) => navigate(`/tickets/${id}`)}
                          bulkAssignAvailable={canBulkAssign}
                          bulkAssignPending={sweep.isPending}
                          onBulkAssign={() => sweep.mutate()}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </>
      )}
    </div>
  );
}
