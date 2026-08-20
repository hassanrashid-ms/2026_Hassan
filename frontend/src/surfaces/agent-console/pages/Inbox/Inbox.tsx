import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchConversation, fetchInbox } from '../../api/agentApi.ts'
import { loadAgentSession, loadContextRailOpen, saveContextRailOpen } from '../../lib/agentSession.ts'
import { ConversationList } from './components/ConversationList.tsx'
import { ContextRail } from './components/ContextRail.tsx'
import { ThreadPanel } from './components/ThreadPanel.tsx'

export function Inbox() {
  const { conversationId } = useParams<{ conversationId?: string }>()
  const navigate = useNavigate()
  const session = loadAgentSession()
  const [railOpen, setRailOpen] = useState(loadContextRailOpen)

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
  const escalated = useQuery({
    queryKey: ['inbox', 'escalated'],
    queryFn: () => fetchInbox(session!.token, 'escalated'),
    enabled: session !== null,
  })

  const selected = useMemo(() => {
    if (!conversationId) return undefined
    const mineFound = mine.data?.conversations.find((c) => c.id === conversationId)
    if (mineFound) return { summary: mineFound, filter: 'mine' }
    const escalatedFound = escalated.data?.conversations.find((c) => c.id === conversationId)
    if (escalatedFound) return { summary: escalatedFound, filter: 'escalated' }
    return undefined
  }, [conversationId, mine.data, escalated.data])

  const detail = useQuery({
    queryKey: ['conversation', conversationId, 'detail'],
    queryFn: () => fetchConversation(session!.token, conversationId!),
    enabled: session !== null && conversationId != null,
  })

  if (!session) return null

  const selectedId = conversationId ?? null
  const status = selected?.summary.status ?? detail.data?.status
  const readOnly = status === 'resolved' || status === 'closed'

  const toggleRail = () => {
    setRailOpen((open) => {
      saveContextRailOpen(!open)
      return !open
    })
  }

  const openRail = (open: boolean) => {
    saveContextRailOpen(open)
    setRailOpen(open)
  }

  let isOwnedByMe = false
  if (selected?.filter === 'mine') isOwnedByMe = true
  else if (detail.isSuccess) isOwnedByMe = detail.data?.assigned_agent?.id === session.agentId

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
          playerExternalId={selected?.summary.player.external_player_id ?? detail.data?.player.external_player_id}
          status={status}
          confirmPhase={selected?.summary.confirm_phase}
          readOnly={readOnly}
          ticketNumber={detail.data?.number}
          resolutionSource={detail.data?.resolution_source}
          resolvedByAgentName={detail.data?.resolved_by_agent_name}
          // There is no resolved_at column; created_at is what the detail carries.
          openedAt={detail.data?.created_at}
          railOpen={railOpen}
          onToggleRail={toggleRail}
          onBack={() => navigate('/inbox')}
          takeOverAvailable={status === 'bot_active'}
          claimAvailable={
            !!status &&
            status !== 'resolved' &&
            status !== 'closed' &&
            status !== 'bot_active' &&
            !isOwnedByMe
          }
        />
      </div>
      {/* Slides in over the content — the layout above is untouched. */}
      {selectedId && (
        <ContextRail token={session.token} conversationId={selectedId} open={railOpen} onOpenChange={openRail} />
      )}
    </div>
  )
}
