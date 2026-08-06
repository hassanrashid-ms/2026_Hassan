import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { claimConversation, fetchInbox } from '../api/agentApi.ts'
import { loadAgentSession } from '../lib/agentSession.ts'
import { createSocket } from '../lib/socket.ts'

export function AgentInbox() {
  const navigate = useNavigate()
  const session = loadAgentSession()
  const queryClient = useQueryClient()
  const [claimNotice, setClaimNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!session) navigate('/login')
  }, [session, navigate])

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

  const claim = useMutation({
    mutationFn: (conversationId: string) => claimConversation(session!.token, conversationId),
    onSuccess: (result) => {
      setClaimNotice(result.claimed ? null : 'Already claimed by someone else.')
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    },
  })

  useEffect(() => {
    if (!session) return
    const socket = createSocket(session.token, 'agent')
    socket.on('conversation:changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    })
    return () => {
      socket.close()
    }
  }, [session, queryClient])

  if (!session) return null

  return (
    <main className="agent-inbox">
      <h1>Inbox — {session.displayName}</h1>
      {claimNotice && <p className="notice">{claimNotice}</p>}

      <section>
        <h2>Unassigned</h2>
        <ul>
          {unassigned.data?.conversations.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => navigate(`/conversations/${c.id}`)}>
                {c.player.external_player_id} — {c.last_message_preview ?? '(no messages)'}
              </button>
              <button type="button" onClick={() => claim.mutate(c.id)} disabled={claim.isPending}>
                Claim
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Mine</h2>
        <ul>
          {mine.data?.conversations.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => navigate(`/conversations/${c.id}`)}>
                {c.player.external_player_id} — {c.last_message_preview ?? '(no messages)'}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
