import { useEffect, useMemo, useRef, useState } from 'react'
import type { IntentView } from '@support/types'
import { CornerDownRight, Plus, X } from 'lucide-react'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog.tsx'
import { Input } from '../../../components/ui/input.tsx'
import { cn } from '../../../lib/cn.ts'

export type SubintentRow = { id: string; name: string; locked: boolean }
export type IntentGroup = { id: string; name: string; subintents: SubintentRow[]; bulkLocked: boolean }

export function buildGroupedSubintents(
  intents: IntentView[],
  query: string,
  currentFormId: string | null,
): IntentGroup[] {
  const q = query.trim().toLowerCase()
  const groups: IntentGroup[] = []

  for (const intent of intents) {
    const rows: SubintentRow[] = intent.subintents
      .filter((s) => s.archivedAt === null)
      .map((s) => ({ id: s.id, name: s.name, locked: s.formId !== null && s.formId !== currentFormId }))
    const bulkLocked = rows.some((r) => r.locked)

    if (q === '') {
      if (rows.length > 0) groups.push({ id: intent.id, name: intent.name, subintents: rows, bulkLocked })
      continue
    }

    if (intent.name.toLowerCase().includes(q)) {
      if (rows.length > 0) groups.push({ id: intent.id, name: intent.name, subintents: rows, bulkLocked })
      continue
    }

    const matching = rows.filter((r) => r.name.toLowerCase().includes(q))
    if (matching.length > 0) groups.push({ id: intent.id, name: intent.name, subintents: matching, bulkLocked })
  }

  return groups
}

function TriStateCheckbox({
  checked,
  indeterminate,
  disabled,
  onChange,
}: {
  checked: boolean
  indeterminate: boolean
  disabled: boolean
  onChange: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return <input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
}

export type ShownForPickerProps = {
  intents: IntentView[]
  selected: string[]
  onChange: (ids: string[]) => void
  currentFormId: string | null
  disabled: boolean
}

export function ShownForPicker({ intents, selected, onChange, currentFormId, disabled }: ShownForPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const allSubintents = useMemo(
    () => intents.flatMap((i) => i.subintents.filter((s) => s.archivedAt === null)),
    [intents],
  )
  const nameById = useMemo(() => new Map(allSubintents.map((s) => [s.id, s.name])), [allSubintents])
  const groups = useMemo(() => buildGroupedSubintents(intents, query, currentFormId), [intents, query, currentFormId])

  const removeChip = (id: string) => onChange(selected.filter((x) => x !== id))

  const toggleSubintent = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }

  const toggleIntent = (group: IntentGroup) => {
    const unlocked = group.subintents.filter((s) => !s.locked)
    const allSelected = unlocked.length > 0 && unlocked.every((s) => selected.includes(s.id))
    if (allSelected) {
      const unlockedIds = new Set(unlocked.map((s) => s.id))
      onChange(selected.filter((id) => !unlockedIds.has(id)))
    } else {
      const toAdd = unlocked.filter((s) => !selected.includes(s.id)).map((s) => s.id)
      onChange([...selected, ...toAdd])
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted">Shown for</label>
      <div className="flex flex-wrap items-center gap-2">
        {selected.map((id) => (
          <Badge key={id} variant="outline" className="gap-1">
            {nameById.get(id) ?? id}
            <button
              type="button"
              aria-label={`Remove ${nameById.get(id) ?? id}`}
              disabled={disabled}
              onClick={() => removeChip(id)}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Add sub-intents"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <Plus className="size-4" />
        </Button>
        {selected.length === 0 && allSubintents.length === 0 && (
          <span className="text-xs text-muted">No subintents available.</span>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Shown for</DialogTitle>
          </DialogHeader>

          <Input
            placeholder="Search intents or sub-intents..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="flex max-h-80 flex-col gap-2 overflow-y-auto border-t border-slate-200 pt-2">
            {groups.length === 0 ? (
              <span className="text-xs text-muted">No matching intents or sub-intents.</span>
            ) : (
              groups.map((group) => {
                const unlocked = group.subintents.filter((s) => !s.locked)
                const selectedUnlocked = unlocked.filter((s) => selected.includes(s.id))
                const checked = unlocked.length > 0 && selectedUnlocked.length === unlocked.length
                const indeterminate = selectedUnlocked.length > 0 && selectedUnlocked.length < unlocked.length

                return (
                  <div key={group.id} className="flex flex-col gap-1">
                    <label className="flex items-center gap-2 font-medium">
                      <TriStateCheckbox
                        checked={checked}
                        indeterminate={indeterminate}
                        disabled={group.bulkLocked}
                        onChange={() => toggleIntent(group)}
                      />
                      {group.name}
                    </label>
                    {group.subintents.map((s) => (
                      <label key={s.id} className={cn('flex items-center gap-2 pl-6', s.locked && 'opacity-50')}>
                        <CornerDownRight className="size-3 text-muted" />
                        <input
                          type="checkbox"
                          checked={selected.includes(s.id)}
                          disabled={s.locked}
                          onChange={() => toggleSubintent(s.id)}
                        />
                        {s.name}
                        {s.locked && <Badge variant="outline">assigned</Badge>}
                      </label>
                    ))}
                  </div>
                )
              })
            )}
          </div>

          <DialogFooter>
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
