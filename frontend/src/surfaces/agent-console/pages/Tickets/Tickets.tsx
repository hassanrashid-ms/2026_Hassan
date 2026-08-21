import { useEffect } from 'react'
import type { ConversationStatusValue } from '@support/types'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { claimConversation, fetchInbox, type ConversationListFilter } from '../../api/agentApi.ts'
import { loadAgentSession } from '../../lib/agentSession.ts'
import { createSocket } from '../../../../features/chat/api/socket.ts'
import { handleSessionExpired } from '../../lib/authErrorHandling.ts'
import { ConversationDetailPane } from '../../components/ConversationDetailPane.tsx'
import { ConversationRow } from '../Inbox/components/ConversationRow.tsx'

const COLUMNS: { title: string; filter: ConversationListFilter; claimable?: boolean }[] = [
  { title: 'Unassigned', filter: 'unassigned', claimable: true },
  { title: 'Bot Handling', filter: 'botHandling' },
  { title: 'Agent Assigned', filter: 'agentAssigned' },
  { title: 'Escalated', filter: 'escalated' },
]

function QueueColumn({ token, title, filter, claimable = false, onSelect }: { token: string; title: string; filter: ConversationListFilter; claimable?: boolean; onSelect: (id: string) => void }) {
  const queryClient = useQueryClient()
  const queue = useQuery({ queryKey: ['tickets', filter], queryFn: () => fetchInbox(token, filter) })
  const claim = useMutation({
    mutationFn: (conversationId: string) => claimConversation(token, conversationId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tickets'] }),
  })
  if (queue.data && queue.data.conversations.length === 0) return null
  return (
    <section className="flex h-[calc(100vh-12rem)] min-h-0 flex-col rounded-card border border-slate-200 bg-surface">
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted">{queue.data?.conversations.length ?? 0}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
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

  useEffect(() => {
    if (!session) return
    const socket = createSocket(session.token, 'agent')
    socket.on('connect_error', (error) => {
      if (error.message === 'unauthorized') handleSessionExpired()
    })
    socket.on('conversation:changed', (payload: { conversation_id?: unknown; status?: unknown }) => {
      const status = payload.status as ConversationStatusValue | undefined
      const filters: ConversationListFilter[] = status === 'bot_active' ? ['botHandling'] : ['unassigned', 'agentAssigned', 'escalated']
      for (const filter of filters) void queryClient.invalidateQueries({ queryKey: ['tickets', filter] })
      // The moved conversation's own detail query — read by ConversationDetailPane
      // whenever the row is no longer in any of the four queue columns (eg. taken
      // over into "mine", which has no column here) — must also refresh, or a
      // second agent already looking at this exact ticket never sees the
      // take-over without a reload.
      const changedId = payload.conversation_id
      if (typeof changedId === 'string') void queryClient.invalidateQueries({ queryKey: ['conversation', changedId, 'detail'] })
    })
    return () => {
      socket.close()
    }
  }, [session, queryClient])

  // Reactive, unlike a one-shot `queryClient.getQueryData` read: each column's
  // own useQuery below shares this cache entry, so a socket-driven
  // invalidate-and-refetch above needs `summary` to recompute when that data
  // changes, not just when `conversationId` changes.
  const queueQueries = useQueries({
    queries: COLUMNS.map(({ filter }) => ({
      queryKey: ['tickets', filter],
      queryFn: () => fetchInbox(session!.token, filter),
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
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {COLUMNS.map(({ title, filter, claimable }) => (
          <QueueColumn key={filter} token={session.token} title={title} filter={filter} claimable={claimable} onSelect={(id) => navigate(`/tickets/${id}`)} />
        ))}
      </div>
    </div>
  )
}
