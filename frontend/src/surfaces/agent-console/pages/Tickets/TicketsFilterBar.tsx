import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { fetchIntents, fetchTags, fetchWorkspaceAgents } from '../../api/agentApi.ts'
import { Input } from '../../components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select.tsx'
import { MultiSelectFilter } from '../../components/MultiSelectFilter.tsx'
import type { TicketsFilters } from './useTicketsFilters.ts'

const PRIORITY_OPTIONS = [
  { value: 'p1', label: 'P1' },
  { value: 'p2', label: 'P2' },
  { value: 'p3', label: 'P3' },
  { value: 'p4', label: 'P4' },
]

const AGE_OPTIONS = [
  { value: 'any', label: 'Any age' },
  { value: '4', label: 'Older than 4 hours' },
  { value: '24', label: 'Older than 1 day' },
  { value: '72', label: 'Older than 3 days' },
]

const SEARCH_DEBOUNCE_MS = 300

export function TicketsFilterBar({
  token,
  filters,
  onChange,
}: {
  token: string
  filters: TicketsFilters
  onChange: (next: Partial<TicketsFilters>) => void
}) {
  const [searchInput, setSearchInput] = useState(filters.q)

  // The URL is the source of truth (back/forward, a bookmarked filtered
  // board), so a change made anywhere else — not just from typing here —
  // has to resync this field.
  useEffect(() => setSearchInput(filters.q), [filters.q])

  useEffect(() => {
    if (searchInput === filters.q) return
    const timer = setTimeout(() => onChange({ q: searchInput }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  const tagsQuery = useQuery({ queryKey: ['tags', ''], queryFn: () => fetchTags(token) })
  const intentsQuery = useQuery({ queryKey: ['intents'], queryFn: () => fetchIntents(token) })
  const agentsQuery = useQuery({ queryKey: ['workspaceAgents'], queryFn: () => fetchWorkspaceAgents(token) })

  const labelOptions = (tagsQuery.data ?? []).map((tag) => ({ value: tag.id, label: tag.name }))
  const subintentOptions = (intentsQuery.data?.intents ?? []).flatMap((intent) =>
    intent.subintents.map((sub) => ({ value: sub.id, label: `${intent.name} / ${sub.name}` })),
  )
  const agentOptions = (agentsQuery.data?.agents ?? []).map((a) => ({ value: a.id, label: a.display_name }))

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input
          placeholder="Search ticket #, player, or subintent..."
          className="w-64 pl-8"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
      </div>
      <MultiSelectFilter label="Priority" options={PRIORITY_OPTIONS} selected={filters.priority} onChange={(v) => onChange({ priority: v })} />
      <MultiSelectFilter label="Label" options={labelOptions} selected={filters.labelIds} onChange={(v) => onChange({ labelIds: v })} />
      <MultiSelectFilter label="Subintent" options={subintentOptions} selected={filters.subintentIds} onChange={(v) => onChange({ subintentIds: v })} />
      <MultiSelectFilter label="Assignee" options={agentOptions} selected={filters.assigneeIds} onChange={(v) => onChange({ assigneeIds: v })} />
      <Select value={filters.olderThanHours || 'any'} onValueChange={(v) => onChange({ olderThanHours: v === 'any' ? '' : v })}>
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AGE_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
