import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createIntent, fetchIntents } from '../../../api/agentApi.ts'
import { Button } from '../../../components/ui/button.tsx'
import { Input } from '../../../components/ui/input.tsx'
import { ScrollArea } from '../../../components/ui/scroll-area.tsx'

export function CategorySidebar({ token }: { token: string }) {
  const queryClient = useQueryClient()
  const [newIntentName, setNewIntentName] = useState('')

  const intents = useQuery({ queryKey: ['admin-intents'], queryFn: () => fetchIntents(token) })

  const addIntent = useMutation({
    mutationFn: () => createIntent(token, newIntentName),
    onSuccess: () => {
      setNewIntentName('')
      void queryClient.invalidateQueries({ queryKey: ['admin-intents'] })
    },
  })

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-slate-200">
      <div className="p-3 text-sm font-semibold">Categories</div>
      <ScrollArea className="min-h-0 flex-1 px-3">
        <ul className="flex flex-col gap-2">
          {intents.data?.intents.map((intent) => (
            <li key={intent.id}>
              <p className="text-sm font-medium">{intent.name}</p>
              {intent.subintents.length > 0 && (
                <ul className="mt-1 flex flex-col gap-0.5 pl-3">
                  {intent.subintents.map((s) => (
                    <li key={s.id} className="text-xs text-muted">
                      {s.name}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </ScrollArea>
      <div className="flex flex-col gap-2 border-t border-slate-200 p-3">
        <Input
          placeholder="New category name"
          value={newIntentName}
          onChange={(e) => setNewIntentName(e.target.value)}
        />
        <Button type="button" size="sm" onClick={() => addIntent.mutate()} disabled={addIntent.isPending || !newIntentName}>
          Add Category
        </Button>
      </div>
    </div>
  )
}
