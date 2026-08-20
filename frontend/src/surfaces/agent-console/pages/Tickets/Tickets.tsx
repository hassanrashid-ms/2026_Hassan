import { useEffect, useMemo } from 'react'
import type { AgentConversationsResponse, ConversationStatusValue } from '@support/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { claimConversation, fetchConversation, fetchInbox, type ConversationListFilter } from '../../api/agentApi.ts'
import { loadAgentSession } from '../../lib/agentSession.ts'
import { createSocket } from '../../../../features/chat/api/socket.ts'
import { handleSessionExpired } from '../../lib/authErrorHandling.ts'
import { ConversationRow } from '../Inbox/components/ConversationRow.tsx'
import { ThreadPanel } from '../Inbox/components/ThreadPanel.tsx'

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
  const detail = useQuery({
    queryKey: ['conversation', conversationId, 'detail'],
    queryFn: () => fetchConversation(session!.token, conversationId!),
    enabled: session !== null && conversationId != null,
  })

  useEffect(() => {
    if (!session) return
    const socket = createSocket(session.token, 'agent')
    socket.on('connect_error', (error) => {
      if (error.message === 'unauthorized') handleSessionExpired()
    })
    socket.on('conversation:changed', (payload: { status?: unknown }) => {
      const status = payload.status as ConversationStatusValue | undefined
      const filters: ConversationListFilter[] = status === 'bot_active' ? ['botHandling'] : ['unassigned', 'agentAssigned', 'escalated']
      for (const filter of filters) void queryClient.invalidateQueries({ queryKey: ['tickets', filter] })
    })
    return () => {
      socket.close()
    }
  }, [session, queryClient])

  const selected = useMemo(() => {
    if (!conversationId) return undefined
    for (const { filter } of COLUMNS) {
      const data = queryClient.getQueryData<AgentConversationsResponse>(['tickets', filter])
      const found = data?.conversations.find((conversation) => conversation.id === conversationId)
      if (found) return { summary: found, filter }
    }
    return undefined
  }, [conversationId, queryClient])

  if (!session) return null
  if (conversationId) {
    const status = selected?.summary.status ?? detail.data?.status
    
    // Determine ownership immediately if we found it in a strictly filtered queue
    let isOwnedByMe = false
    if (selected?.filter === 'mine') isOwnedByMe = true
    else if (selected?.filter === 'unassigned' || selected?.filter === 'agentAssigned' || selected?.filter === 'botHandling') isOwnedByMe = false
    else if (detail.isSuccess) isOwnedByMe = detail.data?.assigned_agent?.id === session.agentId

    return (
      <ThreadPanel
        token={session.token}
        conversationId={conversationId}
        playerExternalId={selected?.summary.player.external_player_id ?? detail.data?.player.external_player_id}
        status={status}
        confirmPhase={selected?.summary.confirm_phase}
        readOnly={status === 'resolved' || status === 'closed'}
        ticketNumber={detail.data?.number}
        resolutionSource={detail.data?.resolution_source}
        resolvedByAgentName={detail.data?.resolved_by_agent_name}
        openedAt={detail.data?.created_at}
        takeOverAvailable={status === 'bot_active'}
        claimAvailable={
          !!status &&
          status !== 'resolved' &&
          status !== 'closed' &&
          status !== 'bot_active' &&
          !isOwnedByMe
        }
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
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-4">
        {COLUMNS.map(({ title, filter, claimable }) => (
          <QueueColumn key={filter} token={session.token} title={title} filter={filter} claimable={claimable} onSelect={(id) => navigate(`/tickets/${id}`)} />
        ))}
      </div>
    </div>
  )
}
