import { useState } from 'react'
import type { AgentConversationSummary } from '@support/types'
import { useQuery } from '@tanstack/react-query'
import { fetchConversation } from '../api/agentApi.ts'
import { loadContextRailOpen, saveContextRailOpen } from '../lib/agentSession.ts'
import { ContextRail } from '../pages/Inbox/components/ContextRail.tsx'
import { ThreadPanel } from '../pages/Inbox/components/ThreadPanel.tsx'

/**
 * The thread + context rail for one open conversation, shared by Inbox and
 * Tickets so the two pages can't drift the way they did before this existed:
 * Inbox rendered the rail and Tickets didn't, and each page had its own
 * (differently buggy) copy of the ownership check. Anything about *viewing* a
 * single conversation belongs here; list/queue layout stays with each page.
 */
export function ConversationDetailPane({
  token,
  agentId,
  conversationId,
  summary,
  onBack,
}: {
  token: string
  agentId: string
  conversationId: string
  /**
   * The row from whichever queue list currently has this conversation cached,
   * if any — cheap enrichment so the header doesn't wait on `detail` alone.
   * Undefined is fine; every field it would supply falls back to `detail`.
   */
  summary?: AgentConversationSummary
  onBack: () => void
}) {
  const [railOpen, setRailOpen] = useState(loadContextRailOpen)

  const detail = useQuery({
    queryKey: ['conversation', conversationId, 'detail'],
    queryFn: () => fetchConversation(token, conversationId),
  })

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

  const status = summary?.status ?? detail.data?.status
  const readOnly = status === 'resolved' || status === 'closed'

  // "agentAssigned"/"escalated" queue buckets are every agent's queue, not the
  // viewer's own — a row found there can still be the viewer's own ticket, so
  // ownership has to come from the assigned-agent id itself, never from which
  // queue bucket the row was found in.
  const assignedAgentId = summary?.assigned_agent_id ?? detail.data?.assigned_agent?.id ?? null
  const assignedAgentName = detail.data?.assigned_agent?.display_name ?? null
  const isOwnedByMe = assignedAgentId === agentId

  return (
    <>
      <ThreadPanel
        token={token}
        conversationId={conversationId}
        playerExternalId={summary?.player.external_player_id ?? detail.data?.player.external_player_id}
        status={status}
        confirmPhase={summary?.confirm_phase}
        readOnly={readOnly}
        ticketNumber={detail.data?.number}
        resolutionSource={detail.data?.resolution_source}
        resolvedByAgentName={detail.data?.resolved_by_agent_name}
        // There is no resolved_at column; created_at is what the detail carries.
        openedAt={detail.data?.created_at}
        railOpen={railOpen}
        onToggleRail={toggleRail}
        onBack={onBack}
        takeOverAvailable={status === 'bot_active'}
        claimAvailable={!!status && status !== 'resolved' && status !== 'closed' && status !== 'bot_active' && !isOwnedByMe}
        assignedAgentId={assignedAgentId}
        assignedAgentName={assignedAgentName}
      />
      <ContextRail token={token} conversationId={conversationId} open={railOpen} onOpenChange={openRail} />
    </>
  )
}
