import { useEffect, useRef, useState } from 'react';
import type { ConversationStatusValue } from '@support/types';
import { useInfiniteQuery, useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  claimConversation,
  fetchInbox,
  type ConversationListFilter,
  type TicketsQueryFilters,
} from '../../api/agentApi.ts';
import { loadAgentSession } from '../../lib/agentSession.ts';
import { createSocket } from '../../../../features/chat/api/socket.ts';
import { handleSessionExpired } from '../../lib/authErrorHandling.ts';
import { ConversationDetailPane } from '../../components/ConversationDetailPane.tsx';
import { EmptyState } from '../../components/ui/empty-state.tsx';
import { ConversationRow } from '../Inbox/components/ConversationRow.tsx';
import { TicketsFilterBar } from './TicketsFilterBar.tsx';
import { useTicketsFilters } from './useTicketsFilters.ts';
import { QUEUE_OPTIONS } from './queues.ts';

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
  };
}

function hasActiveFilters(f: TicketsQueryFilters): boolean {
  return Boolean(
    f.q || f.priority || f.labelIds || f.subintentIds || f.assigneeIds || f.olderThanHours,
  );
}

function SortableQueueColumn({
  id,
  col,
  token,
  queryFilters,
  filtersActive,
  onSelect,
}: {
  id: string;
  col: (typeof COLUMNS)[0];
  token: string;
  queryFilters: TicketsQueryFilters;
  filtersActive: boolean;
  onSelect: (id: string) => void;
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
}: {
  token: string;
  title: string;
  filter: ConversationListFilter;
  queryFilters: TicketsQueryFilters;
  filtersActive: boolean;
  claimable?: boolean;
  dragHandleProps?: Record<string, any>;
  onSelect: (id: string) => void;
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
      className="flex min-h-0 flex-col rounded-card border border-slate-200 bg-surface resize-y overflow-hidden pb-1"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2">
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
        <span className="text-xs text-muted">{conversations.length}</span>
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

export function Tickets() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const session = loadAgentSession();
  const queryClient = useQueryClient();
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
        const changedId = payload.conversation_id;
        if (typeof changedId === 'string')
          void queryClient.invalidateQueries({ queryKey: ['conversation', changedId, 'detail'] });
      },
    );
    return () => {
      socket.close();
    };
  }, [sessionToken, sessionWorkspaceId, queryClient]);

  const summaryQueries = useQueries({
    queries: COLUMNS.map(({ filter }) => ({
      queryKey: ['tickets-summary', filter, queryFilters],
      queryFn: () => fetchInbox(session!.token, filter, queryFilters),
      enabled: session !== null,
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
      <div className="mb-4">
        <h1 className="text-lg font-semibold">Tickets</h1>
        <p className="text-sm text-muted">All active queues at a glance</p>
      </div>
      <TicketsFilterBar token={session.token} filters={filters} onChange={updateFilters} />
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
            ].map((filters, columnIndex) => (
              <div key={columnIndex} className="flex flex-col gap-4">
                {filters.map((filter) => {
                  const col = COLUMNS.find((c) => c.filter === filter)!;
                  const queryIndex = COLUMNS.findIndex((c) => c.filter === filter);
                  const summaryQuery = summaryQueries[queryIndex];
                  const isHidden = Boolean(
                    summaryQuery?.data &&
                    summaryQuery.data.conversations.length === 0 &&
                    !filtersActive,
                  );

                  if (isHidden) return null;

                  return (
                    <SortableQueueColumn
                      key={filter}
                      id={filter}
                      col={col}
                      token={session.token}
                      queryFilters={queryFilters}
                      filtersActive={filtersActive}
                      onSelect={(id) => navigate(`/tickets/${id}`)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
