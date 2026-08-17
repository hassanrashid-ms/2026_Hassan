import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { fetchConversationContext } from '../../../api/agentApi.ts'
import { ApiError } from '../../../../../lib/httpClient.ts'
import { Button } from '../../../components/ui/button.tsx'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../../../components/ui/sheet.tsx'
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

  // Long staleTime and no socket wiring: the snapshot is immutable by
  // construction and ticket history moves on the order of days. Only navigating
  // to another ticket changes the key.
  const contextQuery = useQuery({
    queryKey: ['conversation', conversationId, 'context'],
    queryFn: () => fetchConversationContext(token, conversationId),
    staleTime: 5 * 60_000,
  })

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
            </>
          ) : (
            <p className="px-4 py-3 text-sm text-muted">Loading…</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
