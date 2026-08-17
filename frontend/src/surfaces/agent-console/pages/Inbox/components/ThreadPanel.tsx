import { useEffect, useState } from 'react'
import type {
  AgentMessageView,
  ConfirmPhaseValue,
  ConversationStatusValue,
  ResolutionSourceValue,
} from '@support/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Archive, Clock, MessageSquare, PanelRight } from 'lucide-react'
import { askResolved, fetchConversationMessages, markAgentMessagesRead, sendAgentMessage } from '../../../api/agentApi.ts'
import { createSocket } from '../../../../../features/chat/api/socket.ts'
import { ChatThread } from '../../../../../features/chat/components/ChatThread.tsx'
import { reconcilePending, type PendingMessage } from '../../../../../features/chat/hooks/chatReconcile.ts'
import { Composer } from '../../../../../features/chat/components/Composer.tsx'
import type { ChatMessage } from '../../../../../features/chat/components/types.ts'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { STATUS_BADGE_VARIANT } from './ConversationRow.tsx'

function toChatMessage(m: AgentMessageView): ChatMessage {
  return {
    id: m.id,
    authorType: m.author_type,
    body: m.body,
    createdAt: m.created_at,
    deliveryState: m.delivery_state,
    readAt: m.read_at,
    visibility: m.visibility,
  }
}

function formatTicketDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "Resolved by Sam" / "Resolved by the bot" / "Closed" when no source is known. */
function resolverLabel(source: ResolutionSourceValue | null | undefined, agentName: string | null | undefined): string {
  if (source === 'agent') return `Resolved by ${agentName ?? 'an agent'}`
  if (source === 'bot') return 'Resolved by the bot'
  return 'Closed'
}

export function ThreadPanel({
  token,
  conversationId,
  playerExternalId,
  status,
  confirmPhase,
  readOnly = false,
  ticketNumber,
  resolutionSource,
  resolvedByAgentName,
  openedAt,
  railOpen = false,
  onToggleRail,
  onBack,
}: {
  token: string
  conversationId: string | null
  playerExternalId?: string
  status?: ConversationStatusValue
  confirmPhase?: ConfirmPhaseValue
  readOnly?: boolean
  ticketNumber?: number
  resolutionSource?: ResolutionSourceValue | null
  resolvedByAgentName?: string | null
  openedAt?: string
  railOpen?: boolean
  onToggleRail?: () => void
  onBack?: () => void
}) {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<PendingMessage[]>([])

  const messagesQuery = useQuery({
    queryKey: ['conversation', conversationId, 'messages'],
    queryFn: () => fetchConversationMessages(token, conversationId!),
    enabled: conversationId !== null,
  })

  const send = useMutation({
    mutationFn: ({ body, visibility }: { body: string; visibility?: 'public' | 'internal' }) =>
      sendAgentMessage(token, conversationId!, body, visibility),
    // The same optimistic handling the webview has had all along. Without it the
    // composer cleared and nothing appeared until the round trip finished, so a
    // slow send looked like a message that had vanished.
    onMutate: ({ body, visibility }) => {
      const tempId = `temp-${Date.now()}-${Math.random()}`
      setPending((current) => [
        ...current,
        {
          tempId,
          id: tempId,
          authorType: 'agent',
          body,
          createdAt: new Date().toISOString(),
          deliveryState: 'sending',
          visibility: visibility ?? 'public',
        },
      ])
      return { tempId }
    },
    onSuccess: (data, _variables, context) => {
      // `pending` is deliberately not cleared here: stamping the id the server
      // gave this message lets reconcilePending drop the bubble only once the
      // refetched list actually contains it, so it never blinks out in the gap
      // before that lands.
      setPending((current) =>
        current.map((p) => (p.tempId === context?.tempId ? { ...p, serverId: data.message.id } : p)),
      )
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] })
    },
    onError: (_error, _variables, context) => {
      setPending((current) =>
        current.map((p) => (p.tempId === context?.tempId ? { ...p, deliveryState: 'failed' } : p)),
      )
    },
  })

  const onRetry = (failed: ChatMessage) => {
    setPending((current) => current.filter((p) => p.id !== failed.id))
    send.mutate({ body: failed.body, visibility: failed.visibility })
  }

  const ask = useMutation({
    mutationFn: () => askResolved(token, conversationId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] })
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'mine'] })
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'unassigned'] })
    },
  })

  const askable =
    !readOnly && (status === 'open' || status === 'awaiting_player') && (confirmPhase ?? 'none') === 'none'
  const waiting = confirmPhase === 'agent_ask'

  // An optimistic bubble belongs to the thread it was typed in. Switching
  // conversations must drop it, or a send that is still in flight reappears
  // over someone else's transcript.
  useEffect(() => {
    setPending([])
  }, [conversationId])

  useEffect(() => {
    if (!conversationId) return
    const socket = createSocket(token, 'agent')
    // Inside 'connect', not once at setup: rooms live on the server's socket
    // instance, so every reconnect — a backend restart, a laptop waking, a
    // dropped websocket — lands in a socket that has joined nothing. Emitting
    // once meant the panel went quiet after the first blip and only recovered
    // on remount, which reads as "read receipts stopped working".
    socket.on('connect', () => {
      socket.emit('join_conversation', { conversation_id: conversationId })
    })
    socket.on('message:new', () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] })
    })
    socket.on('message:read', () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] })
    })
    // The player's answer arrives as a message; this is what tells the panel the
    // question is no longer outstanding, which no message body states.
    socket.on('conversation:phase_changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'mine'] })
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'unassigned'] })
    })
    return () => {
      socket.emit('leave_conversation', { conversation_id: conversationId })
      socket.close()
    }
  }, [token, conversationId, queryClient])

  useEffect(() => {
    // read_at is set once and never rewritten, so glancing at a June ticket for
    // context would permanently stamp receipts the player is shown. Reading
    // history must not write history.
    if (readOnly) return
    const messages = messagesQuery.data?.messages
    if (!conversationId || !messages || messages.length === 0) return
    const lastSeq = Math.max(...messages.map((m) => m.seq))
    void markAgentMessagesRead(token, conversationId, lastSeq)
  }, [token, conversationId, messagesQuery.data, readOnly])

  if (!conversationId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
        <MessageSquare className="size-8" />
        <p className="text-sm">Select a conversation</p>
      </div>
    )
  }

  const serverMessages: ChatMessage[] = messagesQuery.data?.messages.map(toChatMessage) ?? []
  const chatMessages = reconcilePending(serverMessages, pending)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-3">
        {onBack && (
          <Button type="button" variant="ghost" size="icon" onClick={onBack} aria-label="Back to list">
            <ArrowLeft className="size-4" />
          </Button>
        )}
        <span className="text-sm font-medium">{playerExternalId}</span>
        {status && <Badge variant={STATUS_BADGE_VARIANT[status]}>{status}</Badge>}
        <div className="ml-auto flex items-center gap-2">
          {/* Hidden outright when read-only: a disabled control here explains nothing. */}
          {!readOnly && (askable || waiting) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!askable || ask.isPending}
              // A real tooltip primitive isn't in this surface yet; the native
              // title is enough for a disabled-state explanation.
              title={waiting ? 'Waiting on player' : undefined}
              onClick={() => ask.mutate()}
            >
              Ask if resolved
            </Button>
          )}
          {onToggleRail && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Player context"
              aria-pressed={railOpen}
              onClick={onToggleRail}
            >
              <PanelRight className="size-4" />
            </Button>
          )}
        </div>
      </div>
      {/* Without this an agent lands on June's transcript and reasonably
          concludes the live ticket changed under them. */}
      {readOnly && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900"
        >
          <Archive className="size-3.5 shrink-0" />
          Viewing an earlier ticket
          {ticketNumber != null && ` · #${ticketNumber}`}
          {/* "opened", not "resolved": the only date the API carries is
              created_at, and labelling it with the ticket's status would put a
              date in front of the agent that is not the date of that status. */}
          {openedAt && ` · ${status ?? 'resolved'} · opened ${formatTicketDate(openedAt)}`}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {/* Keyed on the conversation so switching threads remounts the list at
            the bottom instead of holding the previous thread's scroll offset.

            Not rendered until the messages are here. Virtuoso applies
            initialTopMostItemIndex once, at mount — mounting it against the
            empty list this query starts with spent that on nothing, and where
            the thread opened was then left to followOutput catching the first
            data arrival. Mounting with the real transcript makes the initial
            position the deterministic thing it reads as. */}
        {messagesQuery.data ? (
          <ChatThread key={conversationId} messages={chatMessages} currentAuthorType="agent" onRetry={onRetry} playerLabel={playerExternalId} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            {messagesQuery.isError ? 'Could not load this conversation.' : 'Loading…'}
          </div>
        )}
      </div>
      {/* The ask used to be visible only as a disabled header button with a
          native title. It is a state the whole panel is in — the agent is
          blocked on the player — so it says so where the agent is looking. */}
      {waiting && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900"
        >
          <Clock className="size-3.5 shrink-0" />
          Waiting on the player&rsquo;s answer to &ldquo;Did this solve it?&rdquo;
        </div>
      )}
      {/* No longer disabled on send.isPending: the optimistic bubble is the
          feedback now, and greying the composer for the length of a round trip
          was the most visible part of the lag it was meant to explain. Each
          send is independent, so a second one need not wait on the first. */}
      <Composer
        onSend={(body, visibility) => send.mutate({ body, visibility })}
        allowVisibilityToggle
        disabled={readOnly}
        placeholder={readOnly ? resolverLabel(resolutionSource, resolvedByAgentName) : undefined}
      />
    </div>
  )
}
