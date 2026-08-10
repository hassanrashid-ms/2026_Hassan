import { useEffect } from 'react'
import type { AgentMessageView } from '@support/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchConversationMessages, markAgentMessagesRead, sendAgentMessage } from '../api/agentApi.ts'
import { loadAgentSession } from '../lib/agentSession.ts'
import { createSocket } from '../../../features/chat/api/socket.ts'
import { ChatThread } from '../../../features/chat/components/ChatThread.tsx'
import { Composer } from '../../../features/chat/components/Composer.tsx'
import type { ChatMessage } from '../../../features/chat/components/types.ts'

function toChatMessage(m: AgentMessageView): ChatMessage {
  return {
    id: m.id,
    authorType: m.author_type,
    body: m.body,
    createdAt: m.created_at,
    deliveryState: m.delivery_state,
    visibility: m.visibility,
  }
}

export function AgentConversation() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const session = loadAgentSession()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!session) navigate('/login')
  }, [session, navigate])

  const messagesQuery = useQuery({
    queryKey: ['conversation', id, 'messages'],
    queryFn: () => fetchConversationMessages(session!.token, id!),
    enabled: session !== null && id !== undefined,
  })

  const send = useMutation({
    mutationFn: ({ body, visibility }: { body: string; visibility?: 'public' | 'internal' }) =>
      sendAgentMessage(session!.token, id!, body, visibility),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', id, 'messages'] })
    },
  })

  useEffect(() => {
    if (!session || !id) return
    const socket = createSocket(session.token, 'agent')
    socket.emit('join_conversation', { conversation_id: id })
    socket.on('message:new', () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', id, 'messages'] })
    })
    return () => {
      socket.emit('leave_conversation', { conversation_id: id })
      socket.close()
    }
  }, [session, id, queryClient])

  useEffect(() => {
    const messages = messagesQuery.data?.messages
    if (!session || !id || !messages || messages.length === 0) return
    const lastSeq = Math.max(...messages.map((m) => m.seq))
    void markAgentMessagesRead(session.token, id, lastSeq)
  }, [session, id, messagesQuery.data])

  if (!session || !id) return null

  const chatMessages: ChatMessage[] = messagesQuery.data?.messages.map(toChatMessage) ?? []

  return (
    <main className="agent-conversation">
      <button type="button" onClick={() => navigate('/inbox')}>
        ← Back to inbox
      </button>
      <div className="agent-conversation__thread">
        <ChatThread messages={chatMessages} currentAuthorType="agent" />
      </div>
      <Composer
        onSend={(body, visibility) => send.mutate({ body, visibility })}
        disabled={send.isPending}
        allowVisibilityToggle
      />
    </main>
  )
}
