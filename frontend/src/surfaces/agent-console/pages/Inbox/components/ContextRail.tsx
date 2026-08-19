import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { fetchConversationContext } from '../../../api/agentApi.ts'
import { createSocket } from '../../../../../features/chat/api/socket.ts'
import { handleSessionExpired } from '../../../lib/authErrorHandling.ts'
import { ApiError } from '../../../../../lib/httpClient.ts'
import { Button } from '../../../components/ui/button.tsx'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../../../components/ui/sheet.tsx'
import { FormPanel } from './context/FormPanel.tsx'
import { PlayerStatePanel } from './context/PlayerStatePanel.tsx'
import { TicketList } from './context/TicketList.tsx'

export function ContextRail({
  token,
  conversationId,
  open,
  onOpenChange,
}: {
  token: string
  conversationId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Long staleTime: the snapshot is immutable by construction and ticket
  // history moves on the order of days. Navigating to another ticket changes the
  // key; the one exception is the effect below, which invalidates this query on
  // the single event that can move a form mid-read.
  const contextQuery = useQuery({
    queryKey: ['conversation', conversationId, 'context'],
    queryFn: () => fetchConversationContext(token, conversationId),
    staleTime: 5 * 60_000,
  })

  // The two narrow triggers. The staleTime above is not dropped: player state is
  // immutable by construction and ticket history moves on the order of days.
  // The exceptions are a form in progress (bot_active conversations sit in the
  // unassigned queue, so an agent can open a ticket mid-form) and a status
  // transition on the current ticket (escalate/un-escalate/resolve etc.), which
  // the cached ticket-history snapshot would otherwise carry stale. A missed
  // invalidation leaves the panel stale rather than wrong, and the next
  // navigation corrects it.
  useEffect(() => {
    const socket = createSocket(token, 'agent')
    // Inside 'connect', not once at setup: rooms live on the server's socket
    // instance, so every reconnect lands in a socket that has joined nothing.
    socket.on('connect', () => {
      socket.emit('join_conversation', { conversation_id: conversationId })
    })
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') handleSessionExpired()
    })
    socket.on('conversation:phase_changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'context'] })
    })
    socket.on('conversation:changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'context'] })
    })
    return () => {
      socket.emit('leave_conversation', { conversation_id: conversationId })
      socket.close()
    }
  }, [token, conversationId, queryClient])

  const error = contextQuery.error
  const notFound = error instanceof ApiError && error.status === 404

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="right"
        showOverlay={false}
        className="w-96 sm:max-w-96"
        // The rail sits beside a thread that stays live and clickable, so a
        // click on the transcript must not dismiss it.
        onInteractOutside={(e) => e.preventDefault()}
      >
        <SheetHeader>
          <SheetTitle>Context</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {contextQuery.isError ? (
            <div className="flex flex-col items-start gap-2 px-4 py-3">
              <p className="text-sm text-muted">{notFound ? 'Ticket not found' : 'Could not load context.'}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void contextQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : contextQuery.data ? (
            <>
              <PlayerStatePanel state={contextQuery.data.player_state} />
              <TicketList
                tickets={contextQuery.data.tickets}
                summary={contextQuery.data.summary}
                currentId={conversationId}
                onSelect={(id) => void navigate(`/inbox/${id}`)}
              />
              {/* Five states, and this is the one that renders nothing: no form
                  means no section, following the raw-is-{} precedent. */}
              {contextQuery.data.form ? <FormPanel form={contextQuery.data.form} /> : null}
            </>
          ) : (
            <p className="px-4 py-3 text-sm text-muted">Loading…</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
