import { useEffect, useState } from 'react'
import type { TagView } from '@support/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { attachTag, createTag, fetchTags } from '../../../api/agentApi.ts'
import { Button } from '../../../components/ui/button.tsx'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../../../components/ui/command.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.tsx'

export function TagPicker({
  token,
  conversationId,
  attachedTagIds,
}: {
  token: string
  conversationId: string
  attachedTagIds: string[]
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const queryClient = useQueryClient()

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query), 250)
    return () => clearTimeout(handle)
  }, [query])

  const tagsQuery = useQuery({
    queryKey: ['tags', debounced],
    queryFn: () => fetchTags(token, debounced || undefined),
    enabled: open,
  })

  const results = (tagsQuery.data ?? []).filter((t) => !attachedTagIds.includes(t.id))

  const invalidateContext = () => {
    void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'context'] })
    // Tag attach has no socket event (unlike status changes), so the inbox
    // row's tags are otherwise only refreshed by a full page reload.
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
  }

  const attach = useMutation({
    mutationFn: (tagId: string) => attachTag(token, conversationId, tagId),
    onSuccess: invalidateContext,
  })

  const createAndAttach = useMutation({
    mutationFn: async (name: string) => {
      const tag: TagView = await createTag(token, name)
      await attachTag(token, conversationId, tag.id)
      return tag
    },
    onSuccess: () => {
      invalidateContext()
      setQuery('')
    },
  })

  const trimmed = query.trim()
  const exactMatch = results.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label="Add tag">
          <Plus className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search tags..." value={query} onValueChange={setQuery} />
          <CommandList>
            {results.length === 0 && trimmed === '' && <CommandEmpty>No tags found.</CommandEmpty>}
            <CommandGroup>
              {results.map((tag) => (
                <CommandItem
                  key={tag.id}
                  value={tag.id}
                  onSelect={() => attach.mutate(tag.id)}
                >
                  {tag.name}
                </CommandItem>
              ))}
              {trimmed !== '' && !exactMatch && (
                <CommandItem value={`create-${trimmed}`} onSelect={() => createAndAttach.mutate(trimmed)}>
                  Create "{trimmed}"
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
