import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ConversationPriority, IntentSubintentView, IntentView } from '@support/types'
import { archiveSubintent, mergeSubintent, moveSubintent, renameSubintent } from '../../../api/agentApi.ts'
import { isAdmin, type StoredAgentSession } from '../../../lib/agentSession.ts'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { Input } from '../../../components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select.tsx'

const PRIORITIES: ConversationPriority[] = ['p1', 'p2', 'p3', 'p4']
const OTHER_NAME = 'Other'

export function SubintentRow({
  token,
  session,
  subintent,
  parentIntent,
  allIntents,
  allSubintents,
}: {
  token: string
  session: StoredAgentSession
  subintent: IntentSubintentView
  parentIntent: IntentView
  allIntents: IntentView[]
  allSubintents: (IntentSubintentView & { intentId: string; intentName: string })[]
}) {
  const queryClient = useQueryClient()
  const admin = isAdmin(session)
  // Mirrors backend/src/domain/bot/fallbackSubintent.ts's resolution: the
  // isSystem intent's subintent literally named "Other" — UI-only, the real
  // guard is server-side per the archive/merge/move 409s.
  const isOther = parentIntent.isSystem && subintent.name === OTHER_NAME
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(subintent.name)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin-intents'] })

  const rename = useMutation({
    mutationFn: () => renameSubintent(token, subintent.id, { name }),
    onSuccess: () => {
      setEditing(false)
      void invalidate()
    },
  })

  const setPriority = useMutation({
    mutationFn: (defaultPriority: ConversationPriority) => renameSubintent(token, subintent.id, { defaultPriority }),
    onSuccess: () => void invalidate(),
  })

  const archive = useMutation({
    mutationFn: () => archiveSubintent(token, subintent.id),
    onSuccess: () => void invalidate(),
  })

  const move = useMutation({
    mutationFn: (intentId: string) => moveSubintent(token, subintent.id, intentId),
    onSuccess: () => void invalidate(),
  })

  const merge = useMutation({
    mutationFn: (intoId: string) => mergeSubintent(token, subintent.id, intoId),
    onSuccess: () => void invalidate(),
  })

  const moveTargets = allIntents.filter((i) => i.archivedAt === null && i.id !== parentIntent.id)
  const mergeTargets = allSubintents.filter((s) => s.archivedAt === null && s.id !== subintent.id)
  const disabledTitle = isOther ? 'The "Other" subintent can never be archived, merged, or moved.' : undefined

  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {editing ? (
          <>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-7 w-40 text-xs" />
            <Button type="button" size="sm" onClick={() => rename.mutate()} disabled={rename.isPending || !name}>
              Save
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <span className="text-xs">{subintent.name}</span>
            {subintent.archivedAt !== null && <Badge variant="secondary">Archived</Badge>}
          </>
        )}

        {admin && !editing && subintent.archivedAt === null && (
          <div className="ml-auto flex items-center gap-1">
            <Select value={subintent.defaultPriority ?? undefined} onValueChange={(value) => setPriority.mutate(value as ConversationPriority)}>
              <SelectTrigger className="h-7 w-20 text-xs">
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <span title={disabledTitle}>
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)} disabled={isOther}>
                Rename
              </Button>
            </span>

            <span title={disabledTitle}>
              <Select disabled={isOther} onValueChange={(intentId) => move.mutate(intentId)}>
                <SelectTrigger className="h-7 w-28 text-xs">
                  <SelectValue placeholder="Move to…" />
                </SelectTrigger>
                <SelectContent>
                  {moveTargets.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>

            <span title={disabledTitle}>
              <Select disabled={isOther} onValueChange={(intoId) => merge.mutate(intoId)}>
                <SelectTrigger className="h-7 w-32 text-xs">
                  <SelectValue placeholder="Merge into…" />
                </SelectTrigger>
                <SelectContent>
                  {mergeTargets.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.intentName} / {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>

            <span title={disabledTitle}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => archive.mutate()}
                disabled={isOther || archive.isPending}
              >
                Archive
              </Button>
            </span>
          </div>
        )}
      </div>
      {(archive.isError || move.isError || merge.isError || rename.isError) && (
        <p className="pl-0 text-xs text-red-600">
          {archive.error?.message ?? move.error?.message ?? merge.error?.message ?? rename.error?.message}
        </p>
      )}
    </li>
  )
}
