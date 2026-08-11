import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchInbox } from '../../api/agentApi.ts'
import { loadAgentSession } from '../../lib/agentSession.ts'
import { ConversationList } from './components/ConversationList.tsx'
import { ThreadPanel } from './components/ThreadPanel.tsx'

export function Inbox() {
  const { conversationId } = useParams<{ conversationId?: string }>()
  const navigate = useNavigate()
  const session = loadAgentSession()

  // Both queries are already cached by ConversationList under the same keys;
  // this lookup is just to find the selected row's player id + status for
  // ThreadPanel's header without re-fetching or duplicating that state.
  const unassigned = useQuery({
    queryKey: ['inbox', 'unassigned'],
    queryFn: () => fetchInbox(session!.token, 'unassigned'),
    enabled: session !== null,
  })
  const mine = useQuery({
    queryKey: ['inbox', 'mine'],
    queryFn: () => fetchInbox(session!.token, 'mine'),
    enabled: session !== null,
  })

  const selected = useMemo(() => {
    if (!conversationId) return undefined
    return (
      unassigned.data?.conversations.find((c) => c.id === conversationId) ??
      mine.data?.conversations.find((c) => c.id === conversationId)
    )
  }, [conversationId, unassigned.data, mine.data])

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
        <ThreadPanel
          token={session.token}
          conversationId={selectedId}
          playerExternalId={selected?.player.external_player_id}
          status={selected?.status}
          onBack={() => navigate('/inbox')}
        />
      </div>
    </div>
  )
}
