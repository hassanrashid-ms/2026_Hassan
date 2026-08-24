import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { reassignConversation, fetchWorkspaceAgents } from '../../../api/agentApi.ts'
import { Button } from '../../../components/ui/button.tsx'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../../../components/ui/command.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.tsx'

export function AssignPicker({
  token,
  conversationId,
  currentAssigneeId,
  currentAssigneeName,
}: {
  token: string
  conversationId: string
  currentAssigneeId?: string | null
  currentAssigneeName?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const queryClient = useQueryClient()

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query), 250)
    return () => clearTimeout(handle)
  }, [query])

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => fetchWorkspaceAgents(token),
    enabled: open,
  })

  const results = (agentsQuery.data?.agents ?? []).filter((a) =>
    a.display_name.toLowerCase().includes(debounced.toLowerCase())
  )

  const invalidateContext = () => {
    void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'detail'] })
    void queryClient.invalidateQueries({ queryKey: ['tickets'] })
    void queryClient.invalidateQueries({ queryKey: ['inbox', 'mine'] })
  }

  const reassign = useMutation({
    mutationFn: (agentId: string) => reassignConversation(token, conversationId, agentId),
    onSuccess: invalidateContext,
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          {currentAssigneeName || 'Unassigned'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search agents..." value={query} onValueChange={setQuery} />
          <CommandList>
            {results.length === 0 && debounced === '' && <CommandEmpty>No agents found.</CommandEmpty>}
            <CommandGroup>
              {results.map((agent) => (
                <CommandItem
                  key={agent.id}
                  value={agent.id}
                  onSelect={() => {
                    reassign.mutate(agent.id)
                    setOpen(false)
                  }}
                >
                  {agent.display_name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
