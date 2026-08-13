import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { TopBar } from '@/surfaces/webview/components/TopBar'
import { DebugDialog } from '@/surfaces/webview/components/DebugDialog'
import { ChatBubbles } from '@/surfaces/webview/components/chat/ChatBubbles'
import { ChatComposer } from '@/surfaces/webview/components/chat/ChatComposer'
import { SupportButton } from '@/surfaces/webview/components/SupportButton'
import { useSupport } from '@/surfaces/webview/components/SupportContext'
import { answerResolution, fetchPlayerMessages, markPlayerMessagesRead, sendPlayerMessage } from '@/features/chat/api/playerChatApi'
import { createSocket } from '@/features/chat/api/socket'
import { reconcilePending, type PendingMessage } from '@/features/chat/hooks/chatReconcile'
import type { ChatMessage } from '@/features/chat/components/types'

function toChatMessage(m: {
  id: string
  author_type: ChatMessage['authorType']
  body: string
  created_at: string
  delivery_state: NonNullable<ChatMessage['deliveryState']>
  read_at: string | null
}): ChatMessage {
  return {
    id: m.id,
    authorType: m.author_type,
    body: m.body,
    createdAt: m.created_at,
    deliveryState: m.delivery_state,
    readAt: m.read_at,
  }
}

/**
 * The chat that used to be a panel inside the support surface, now its own route.
 *
 * Everything below the presentation layer is the same code doing the same thing:
 * the same query keys, the same socket lifecycle, the same optimistic-send
 * handling, the same read-receipt effect. What was `chatOpen` state is now the
 * fact that this route is mounted.
 *
 * This screen deliberately does not depend on bootstrap having succeeded. It
 * needs boot.token and boot.sessionId, which exist the moment the URL parsed —
 * "no dead ends" outranks having complete data.
 */
export function SupportChat() {
  const { boot } = useSupport()
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<PendingMessage[]>([])
  const [debugOpen, setDebugOpen] = useState(false)

  const messagesQuery = useQuery({
    queryKey: ['playerMessages', boot?.sessionId],
    queryFn: () => fetchPlayerMessages(boot!.token, boot!.sessionId),
    enabled: boot !== null,
  })

  const send = useMutation({
    mutationFn: (body: string) => sendPlayerMessage(boot!.token, body, boot!.sessionId),
    onMutate: (body: string) => {
      const tempId = `temp-${Date.now()}-${Math.random()}`
      setPending((current) => [
        ...current,
        { tempId, id: tempId, authorType: 'player', body, createdAt: new Date().toISOString(), deliveryState: 'sending' },
      ])
      return { tempId }
    },
    onSuccess: () => {
      // Deliberately does not clear `pending` here: chatReconcile.ts's
      // reconcilePending drops a pending entry only once the refetched server
      // list actually contains a matching message, so the optimistic bubble
      // never disappears and reappears in the gap before that refetch lands.
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot?.sessionId] })
    },
    onError: (_error, _body, context) => {
      setPending((current) =>
        current.map((p) => (p.tempId === context?.tempId ? { ...p, deliveryState: 'failed' } : p)),
      )
    },
  })

  const answer = useMutation({
    mutationFn: (helped: boolean) => answerResolution(boot!.token, helped, boot!.sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot?.sessionId] })
    },
  })

  const onRetry = (failed: ChatMessage) => {
    setPending((current) => current.filter((p) => p.id !== failed.id))
    send.mutate(failed.body)
  }

  useEffect(() => {
    if (!boot) return
    const socket = createSocket(boot.token, 'player')
    socket.on('connect', () => {
      const conversationId = messagesQuery.data?.conversation_id
      if (conversationId) socket.emit('join_conversation', { conversation_id: conversationId })
    })
    socket.on('message:new', () => {
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot.sessionId] })
    })
    // The only signal for a decline: it posts no message and changes no status,
    // so nothing else would tell this screen to drop the banner.
    socket.on('conversation:phase_changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot.sessionId] })
    })
    // The payload's up_to_seq/read_at are deliberately unused. Refetching keeps
    // the "which messages count as read" rule in exactly one place — the server.
    socket.on('message:read', () => {
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot.sessionId] })
    })
    return () => {
      socket.close()
    }
  }, [boot, messagesQuery.data?.conversation_id, queryClient])

  useEffect(() => {
    const messages = messagesQuery.data?.messages
    if (!boot || !messages || messages.length === 0) return
    const lastSeq = Math.max(...messages.map((m) => m.seq))
    void markPlayerMessagesRead(boot.token, lastSeq)
  }, [boot, messagesQuery.data])

  const serverMessages: ChatMessage[] = messagesQuery.data?.messages.map(toChatMessage) ?? []
  const chatMessages = reconcilePending(serverMessages, pending)

  const settled = messagesQuery.data?.status === 'resolved' || messagesQuery.data?.status === 'closed'
  const confirmPending = (messagesQuery.data?.confirm_phase ?? 'none') !== 'none'

  return (
    <>
      <TopBar variant="chat" onOpenDebug={() => setDebugOpen(true)} />

      {/* min-h-0 is load-bearing: without it a flex child refuses to shrink below
          its content and the composer is pushed off the bottom of the viewport. */}
      <div className="min-h-0 flex-1">
        {messagesQuery.isPending ? null : chatMessages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <p className="text-lg font-semibold text-text">Say hello</p>
            <p className="text-base text-muted">Tell us what happened and we'll pick it up from here.</p>
          </div>
        ) : (
          <ChatBubbles messages={chatMessages} onRetry={onRetry} />
        )}
      </div>

      {confirmPending && (
        <div className="shrink-0 border-t border-muted/15 bg-surface px-4 py-3">
          <p className="text-base font-semibold text-text">Did this solve it?</p>
          <div className="mt-2 flex items-center gap-3">
            <SupportButton
              variant="soft"
              className="min-h-9 px-4 py-2 text-sm"
              disabled={answer.isPending}
              onClick={() => answer.mutate(true)}
            >
              Yes
            </SupportButton>
            <SupportButton
              variant="soft"
              className="min-h-9 px-4 py-2 text-sm"
              disabled={answer.isPending}
              onClick={() => answer.mutate(false)}
            >
              No
            </SupportButton>
          </div>
        </div>
      )}

      {settled && (
        <div className="shrink-0 border-t border-muted/15 bg-surface px-4 py-3">
          <p className="text-base font-semibold text-text">Your ticket is resolved.</p>
          <div className="mt-2 flex items-center gap-3">
            <p className="text-sm text-muted">Still facing issues?</p>
            <SupportButton
              variant="soft"
              className="min-h-9 px-4 py-2 text-sm"
              onClick={() => send.mutate("I'm still facing issues.")}
            >
              Yes
            </SupportButton>
          </div>
        </div>
      )}

      <ChatComposer onSend={(body) => send.mutate(body)} disabled={send.isPending} />

      <DebugDialog open={debugOpen} onOpenChange={setDebugOpen} />
    </>
  )
}
