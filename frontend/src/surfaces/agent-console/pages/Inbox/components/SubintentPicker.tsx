import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchIntents, reclassifyConversation } from '../../../api/agentApi.ts'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '../../../components/ui/command.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.tsx'

interface SubintentOption {
  id: string
  name: string
  intentName: string
}

export function SubintentPicker({
  token,
  conversationId,
  currentSubintentId,
  currentSubintentName,
}: {
  token: string
  conversationId: string
  currentSubintentId?: string | null
  currentSubintentName?: { intent_name: string; subintent_name: string } | null
}) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()

  const intentsQuery = useQuery({
    queryKey: ['intents'],
    queryFn: () => fetchIntents(token),
    enabled: open,
  })

  // Flatten and filter archived intents/subintents
  const subintents: SubintentOption[] = []
  if (intentsQuery.data?.intents) {
    for (const intent of intentsQuery.data.intents) {
      if (intent.archivedAt) continue
      for (const subintent of intent.subintents) {
        if (subintent.archivedAt) continue
        subintents.push({
          id: subintent.id,
          name: subintent.name,
          intentName: intent.name,
        })
      }
    }
  }

  const reclassify = useMutation({
    mutationFn: (subintentId: string) => reclassifyConversation(token, conversationId, subintentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'context'] })
      setOpen(false)
    },
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {currentSubintentName ? (
          <Badge variant="outline" className="cursor-pointer">
            {currentSubintentName.intent_name} · {currentSubintentName.subintent_name}
          </Badge>
        ) : (
          <Button type="button" variant="outline" size="sm">
            Set classification
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="p-0">
        <Command shouldFilter={false}>
          <CommandList>
            {subintents.length === 0 && <CommandEmpty>No subintents found.</CommandEmpty>}
            {/* Group subintents by intent */}
            {Array.from(new Map(subintents.map((s) => [s.intentName, s])).entries()).map(([intentName]) => {
              const intentSubintents = subintents.filter((s) => s.intentName === intentName)
              return (
                <CommandGroup key={intentName} heading={intentName}>
                  {intentSubintents.map((sub) => (
                    <CommandItem
                      key={sub.id}
                      value={sub.id}
                      onSelect={() => reclassify.mutate(sub.id)}
                    >
                      {sub.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
