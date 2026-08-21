import { useEffect } from 'react'
import type { ConversationStatusValue } from '@support/types'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { claimConversation, fetchInbox, type ConversationListFilter, type TicketsQueryFilters } from '../../api/agentApi.ts'
import { loadAgentSession } from '../../lib/agentSession.ts'
import { createSocket } from '../../../../features/chat/api/socket.ts'
import { handleSessionExpired } from '../../lib/authErrorHandling.ts'
import { ConversationDetailPane } from '../../components/ConversationDetailPane.tsx'
import { ConversationRow } from '../Inbox/components/ConversationRow.tsx'
import { TicketsFilterBar } from './TicketsFilterBar.tsx'
import { useTicketsFilters } from './useTicketsFilters.ts'

const COLUMNS: { title: string; filter: ConversationListFilter; claimable?: boolean }[] = [
  { title: 'Unassigned', filter: 'unassigned', claimable: true },
  { title: 'Bot Handling', filter: 'botHandling' },
  { title: 'Agent Assigned', filter: 'agentAssigned' },
  { title: 'Escalated', filter: 'escalated' },
]

function toQueryFilters(f: ReturnType<typeof useTicketsFilters>[0]): TicketsQueryFilters {
  return {
    q: f.q || undefined,
    priority: f.priority.length ? f.priority : undefined,
    labelIds: f.labelIds.length ? f.labelIds : undefined,
    subintentIds: f.subintentIds.length ? f.subintentIds : undefined,
    assigneeIds: f.assigneeIds.length ? f.assigneeIds : undefined,
    olderThanHours: f.olderThanHours ? Number(f.olderThanHours) : undefined,
  }
}

function hasActiveFilters(f: TicketsQueryFilters): boolean {
  return Boolean(f.q || f.priority || f.labelIds || f.subintentIds || f.assigneeIds || f.olderThanHours)
}

function QueueColumn({
  token,
  title,
  filter,
  queryFilters,
  filtersActive,
  claimable = false,
  onSelect,
}: {
  token: string
  title: string
  filter: ConversationListFilter
  queryFilters: TicketsQueryFilters
  filtersActive: boolean
  claimable?: boolean
  onSelect: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const queue = useQuery({
    queryKey: ['tickets', filter, queryFilters],
    queryFn: () => fetchInbox(token, filter, queryFilters),
  })
  const claim = useMutation({
    mutationFn: (conversationId: string) => claimConversation(token, conversationId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tickets'] }),
  })
  if (queue.data && queue.data.conversations.length === 0 && !filtersActive) return null
  return (
    <section className="flex h-[calc(100vh-12rem)] min-h-0 flex-col rounded-card border border-slate-200 bg-surface">
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted">{queue.data?.conversations.length ?? 0}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {queue.data?.conversations.length === 0 && filtersActive && (
          <p className="p-3 text-xs text-muted">No tickets match your filters.</p>
        )}
        {queue.data?.conversations.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            selected={false}
            onSelect={() => onSelect(conversation.id)}
            onClaim={claimable ? () => claim.mutate(conversation.id) : undefined}
            claiming={claim.isPending}
          />
        ))}
        {queue.isError && <p className="p-3 text-xs text-muted">Could not load tickets.</p>}
      </div>
    </section>
  )
}

export function Tickets() {
  const { conversationId } = useParams<{ conversationId?: string }>()
  const navigate = useNavigate()
  const session = loadAgentSession()
  const queryClient = useQueryClient()
  const [filters, updateFilters] = useTicketsFilters()
  const queryFilters = toQueryFilters(filters)
  const filtersActive = hasActiveFilters(queryFilters)

  useEffect(() => {
    if (!session) return
    const socket = createSocket(session.token, 'agent')
    socket.on('connect_error', (error) => {
      if (error.message === 'unauthorized') handleSessionExpired()
    })
    socket.on('conversation:changed', (payload: { conversation_id?: unknown; status?: unknown }) => {
      const status = payload.status as ConversationStatusValue | undefined
      const filtersToInvalidate: ConversationListFilter[] =
        status === 'bot_active' ? ['botHandling'] : ['unassigned', 'agentAssigned', 'escalated']
      for (const filter of filtersToInvalidate) void queryClient.invalidateQueries({ queryKey: ['tickets', filter] })
      const changedId = payload.conversation_id
      if (typeof changedId === 'string') void queryClient.invalidateQueries({ queryKey: ['conversation', changedId, 'detail'] })
    })
    return () => {
      socket.close()
    }
  }, [session, queryClient])

  const queueQueries = useQueries({
    queries: COLUMNS.map(({ filter }) => ({
      queryKey: ['tickets', filter, queryFilters],
      queryFn: () => fetchInbox(session!.token, filter, queryFilters),
      enabled: session !== null,
    })),
  })

  const summary = (() => {
    if (!conversationId) return undefined
    for (const query of queueQueries) {
      const found = query.data?.conversations.find((conversation) => conversation.id === conversationId)
      if (found) return found
    }
    return undefined
  })()

  if (!session) return null
  if (conversationId) {
    return (
      <ConversationDetailPane
        token={session.token}
        agentId={session.agentId}
        conversationId={conversationId}
        summary={summary}
        onBack={() => navigate('/tickets')}
      />
    )
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">Tickets</h1>
        <p className="text-sm text-muted">All active queues at a glance</p>
      </div>
      <TicketsFilterBar token={session.token} filters={filters} onChange={updateFilters} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {COLUMNS.map(({ title, filter, claimable }) => (
          <QueueColumn
            key={filter}
            token={session.token}
            title={title}
            filter={filter}
            queryFilters={queryFilters}
            filtersActive={filtersActive}
            claimable={claimable}
            onSelect={(id) => navigate(`/tickets/${id}`)}
          />
        ))}
      </div>
    </div>
  )
}
