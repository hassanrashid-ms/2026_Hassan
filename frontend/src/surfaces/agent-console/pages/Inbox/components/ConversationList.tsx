import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { claimConversation, fetchInbox } from '../../../api/agentApi.ts'
import { createSocket } from '../../../../../features/chat/api/socket.ts'
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
    socket.on('conversation:changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    })
    return () => {
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
