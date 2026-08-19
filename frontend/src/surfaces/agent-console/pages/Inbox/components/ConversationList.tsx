import { useEffect, useState } from 'react'
import type { AgentConversationsResponse, ConversationStatusValue } from '@support/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { claimConversation, fetchInbox } from '../../../api/agentApi.ts'
import { createSocket } from '../../../../../features/chat/api/socket.ts'
import { handleSessionExpired } from '../../../lib/authErrorHandling.ts'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs.tsx'
import { ScrollArea } from '../../../components/ui/scroll-area.tsx'
import { ConversationRow } from './ConversationRow.tsx'

export function ConversationList({
  token,
  selectedId,
  onSelect,
}: {
  token: string
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const [claimNotice, setClaimNotice] = useState<string | null>(null)

  const unassigned = useQuery({
    queryKey: ['inbox', 'unassigned'],
    queryFn: () => fetchInbox(token, 'unassigned'),
  })
  const mine = useQuery({
    queryKey: ['inbox', 'mine'],
    queryFn: () => fetchInbox(token, 'mine'),
  })

  const claim = useMutation({
    mutationFn: (conversationId: string) => claimConversation(token, conversationId),
    onSuccess: (result) => {
      setClaimNotice(result.claimed ? null : 'Already claimed by someone else.')
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    },
  })

  useEffect(() => {
    const socket = createSocket(token, 'agent')
    let refetchTimer: ReturnType<typeof setTimeout> | undefined

    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') handleSessionExpired()
    })

    /**
     * The badge updates from the socket payload; this only catches up the fields
     * the payload does not carry (`last_message_preview`, `last_message_at`, and
     * which tab a row belongs in). Trailing and coalesced, so a burst of inbound
     * messages costs one round trip instead of one per message, and the status
     * never waits on it — which matters because a refetch here is a full API
     * round trip and the console talks to the API through a tunnel.
     */
    const scheduleRefetch = () => {
      if (refetchTimer) clearTimeout(refetchTimer)
      refetchTimer = setTimeout(() => {
        refetchTimer = undefined
        void queryClient.invalidateQueries({ queryKey: ['inbox'] })
      }, 1000)
    }

    socket.on('conversation:changed', (payload: { conversation_id?: unknown; status?: unknown }) => {
      const { conversation_id: id, status } = payload
      if (typeof id !== 'string' || typeof status !== 'string') {
        scheduleRefetch()
        return
      }

      let patched = false
      for (const key of [['inbox', 'unassigned'], ['inbox', 'mine']]) {
        queryClient.setQueryData<AgentConversationsResponse>(key, (current) => {
          if (!current) return current
          const index = current.conversations.findIndex((c) => c.id === id)
          if (index === -1) return current
          const conversations = current.conversations.slice()
          conversations[index] = { ...conversations[index]!, status: status as ConversationStatusValue }
          patched = true
          return { ...current, conversations }
        })
      }

      // An id in neither list is a conversation that just appeared, or one that
      // moved between Unassigned and Mine. Neither can be rendered from
      // {id, status} alone, so that case still needs the server — immediately,
      // not on the trailing timer, or a new conversation would appear late.
      if (!patched) {
        void queryClient.invalidateQueries({ queryKey: ['inbox'] })
        return
      }
      scheduleRefetch()
    })

    return () => {
      if (refetchTimer) clearTimeout(refetchTimer)
      socket.close()
    }
  }, [token, queryClient])

  return (
    <Tabs defaultValue="unassigned" className="flex h-full min-h-0 flex-col gap-0">
      <div className="p-2">
        <TabsList className="w-full">
          <TabsTrigger value="unassigned">Unassigned</TabsTrigger>
          <TabsTrigger value="mine">Mine</TabsTrigger>
        </TabsList>
      </div>
      {claimNotice && <p className="px-4 pb-2 text-xs text-amber-700">{claimNotice}</p>}

      <TabsContent value="unassigned" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          {unassigned.data?.conversations.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              selected={c.id === selectedId}
              onSelect={() => onSelect(c.id)}
              onClaim={() => claim.mutate(c.id)}
              claiming={claim.isPending}
            />
          ))}
        </ScrollArea>
      </TabsContent>

      <TabsContent value="mine" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          {mine.data?.conversations.map((c) => (
            <ConversationRow key={c.id} conversation={c} selected={c.id === selectedId} onSelect={() => onSelect(c.id)} />
          ))}
        </ScrollArea>
      </TabsContent>
    </Tabs>
  )
}
