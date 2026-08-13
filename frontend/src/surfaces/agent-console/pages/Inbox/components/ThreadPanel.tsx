import { useEffect } from 'react'
import type { AgentMessageView, ConfirmPhaseValue, ConversationStatusValue } from '@support/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Clock, MessageSquare } from 'lucide-react'
import { askResolved, fetchConversationMessages, markAgentMessagesRead, sendAgentMessage } from '../../../api/agentApi.ts'
import { createSocket } from '../../../../../features/chat/api/socket.ts'
import { ChatThread } from '../../../../../features/chat/components/ChatThread.tsx'
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

export function ThreadPanel({
  token,
  conversationId,
  playerExternalId,
  status,
  confirmPhase,
  onBack,
}: {
  token: string
  conversationId: string | null
  playerExternalId?: string
  status?: ConversationStatusValue
  confirmPhase?: ConfirmPhaseValue
  onBack?: () => void
}) {
  const queryClient = useQueryClient()

  const messagesQuery = useQuery({
    queryKey: ['conversation', conversationId, 'messages'],
    queryFn: () => fetchConversationMessages(token, conversationId!),
    enabled: conversationId !== null,
  })

  const send = useMutation({
    mutationFn: ({ body, visibility }: { body: string; visibility?: 'public' | 'internal' }) =>
      sendAgentMessage(token, conversationId!, body, visibility),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] })
    },
  })

  const ask = useMutation({
    mutationFn: () => askResolved(token, conversationId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] })
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'mine'] })
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'unassigned'] })
    },
  })

  const askable = (status === 'open' || status === 'awaiting_player') && (confirmPhase ?? 'none') === 'none'
  const waiting = confirmPhase === 'agent_ask'

  useEffect(() => {
    if (!conversationId) return
    const socket = createSocket(token, 'agent')
    socket.emit('join_conversation', { conversation_id: conversationId })
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
    const messages = messagesQuery.data?.messages
    if (!conversationId || !messages || messages.length === 0) return
    const lastSeq = Math.max(...messages.map((m) => m.seq))
    void markAgentMessagesRead(token, conversationId, lastSeq)
  }, [token, conversationId, messagesQuery.data])

  if (!conversationId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
        <MessageSquare className="size-8" />
        <p className="text-sm">Select a conversation</p>
      </div>
    )
  }

  const chatMessages: ChatMessage[] = messagesQuery.data?.messages.map(toChatMessage) ?? []

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
        {(askable || waiting) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={!askable || ask.isPending}
            // A real tooltip primitive isn't in this surface yet; the native
            // title is enough for a disabled-state explanation.
            title={waiting ? 'Waiting on player' : undefined}
            onClick={() => ask.mutate()}
          >
            Ask if resolved
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {/* Keyed on the conversation so switching threads remounts the list at
            the bottom instead of holding the previous thread's scroll offset. */}
        <ChatThread key={conversationId} messages={chatMessages} currentAuthorType="agent" />
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
      <Composer onSend={(body, visibility) => send.mutate({ body, visibility })} disabled={send.isPending} allowVisibilityToggle />
    </div>
  )
}
