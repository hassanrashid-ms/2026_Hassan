import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { MessageSquare } from 'lucide-react'
import { fetchInbox } from '../../api/agentApi.ts'
import { loadAgentSession } from '../../lib/agentSession.ts'
import { ConversationDetailPane } from '../../components/ConversationDetailPane.tsx'
import { ConversationList } from './components/ConversationList.tsx'

export function Inbox() {
  const { conversationId } = useParams<{ conversationId?: string }>()
  const navigate = useNavigate()
  const session = loadAgentSession()

  // Already cached by ConversationList under the same keys; this lookup is
  // just to find the selected row for ConversationDetailPane's header without
  // re-fetching or duplicating that state.
  const mine = useQuery({
    queryKey: ['inbox', 'mine'],
    queryFn: () => fetchInbox(session!.token, 'mine'),
    enabled: session !== null,
  })
  const escalated = useQuery({
    queryKey: ['inbox', 'escalated'],
    queryFn: () => fetchInbox(session!.token, 'escalated'),
    enabled: session !== null,
  })

  const summary = useMemo(() => {
    if (!conversationId) return undefined
    return (
      mine.data?.conversations.find((c) => c.id === conversationId) ??
      escalated.data?.conversations.find((c) => c.id === conversationId)
    )
  }, [conversationId, mine.data, escalated.data])

  if (!session) return null

  const selectedId = conversationId ?? null

  return (
    <div className="flex h-full min-h-0">
      {/* Below the md breakpoint, a selected conversation replaces the list
          full-screen (back affordance via ThreadPanel's onBack) since
          side-by-side doesn't fit narrow viewports. */}
      <div className={selectedId ? 'hidden w-80 shrink-0 border-r border-slate-200 md:block' : 'w-full shrink-0 border-r border-slate-200 md:w-80'}>
        <ConversationList token={session.token} selectedId={selectedId} onSelect={(id) => navigate(`/inbox/${id}`)} />
      </div>
      <div className={selectedId ? 'min-w-0 flex-1' : 'hidden flex-1 md:block'}>
        {selectedId ? (
          <ConversationDetailPane
            token={session.token}
            agentId={session.agentId}
            conversationId={selectedId}
            summary={summary}
            onBack={() => navigate('/inbox')}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
            <MessageSquare className="size-8" />
            <p className="text-sm">Select a conversation</p>
          </div>
        )}
      </div>
    </div>
  )
}
