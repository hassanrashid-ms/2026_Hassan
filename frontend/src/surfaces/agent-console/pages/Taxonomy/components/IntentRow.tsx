import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { IntentSubintentView, IntentView } from '@support/types'
import { archiveIntent, createSubintent, renameIntent } from '../../../api/agentApi.ts'
import { isAdmin, type StoredAgentSession } from '../../../lib/agentSession.ts'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { Input } from '../../../components/ui/input.tsx'
import { SubintentRow } from './SubintentRow.tsx'

export function IntentRow({
  token,
  session,
  intent,
  allIntents,
  allSubintents,
}: {
  token: string
  session: StoredAgentSession
  intent: IntentView
  allIntents: IntentView[]
  allSubintents: (IntentSubintentView & { intentId: string; intentName: string })[]
}) {
  const queryClient = useQueryClient()
  const admin = isAdmin(session)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(intent.name)
  const [addingSubintent, setAddingSubintent] = useState(false)
  const [newSubintentName, setNewSubintentName] = useState('')

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin-intents'] })

  const rename = useMutation({
    mutationFn: () => renameIntent(token, intent.id, name),
    onSuccess: () => {
      setEditing(false)
      void invalidate()
    },
  })

  const archive = useMutation({
    mutationFn: () => archiveIntent(token, intent.id),
    onSuccess: () => void invalidate(),
  })

  const addSubintent = useMutation({
    mutationFn: () => createSubintent(token, intent.id, newSubintentName),
    onSuccess: () => {
      setNewSubintentName('')
      setAddingSubintent(false)
      void invalidate()
    },
  })

  const hasActiveSubintents = intent.subintents.some((s) => s.archivedAt === null)
  const archiveDisabled = intent.isSystem || hasActiveSubintents
  // A published-article block is the third condition in the design spec, but
  // detecting it here would mean fetching articles this tree never loads —
  // that case surfaces through archive.error's server message instead.
  const archiveDisabledReason = intent.isSystem
    ? 'The "Other" intent can never be archived.'
    : hasActiveSubintents
      ? 'Archive or move every subintent under this intent first.'
      : undefined

  return (
    <li className={intent.archivedAt !== null ? 'opacity-60' : undefined}>
      <div className="flex items-center gap-2">
        {editing ? (
          <>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 w-48" />
            <Button type="button" size="sm" onClick={() => rename.mutate()} disabled={rename.isPending || !name}>
              Save
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <span className="text-sm font-medium">{intent.name}</span>
            {intent.archivedAt !== null && <Badge variant="secondary">Archived</Badge>}
          </>
        )}
        {admin && !editing && intent.archivedAt === null && (
          <div className="ml-auto flex items-center gap-1">
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Rename
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAddingSubintent(true)}>
              + Add subintent
            </Button>
            <span title={archiveDisabledReason}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => archive.mutate()}
                disabled={archiveDisabled || archive.isPending}
              >
                Archive
              </Button>
            </span>
          </div>
        )}
      </div>
      {archive.isError && <p className="pl-0 text-xs text-red-600">{archive.error?.message}</p>}
      {addingSubintent && (
        <div className="mt-1 flex items-center gap-2 pl-3">
          <Input
            placeholder="New subintent name"
            value={newSubintentName}
            onChange={(e) => setNewSubintentName(e.target.value)}
            className="h-8 w-48"
          />
          <Button
            type="button"
            size="sm"
            onClick={() => addSubintent.mutate()}
            disabled={addSubintent.isPending || !newSubintentName}
          >
            Add
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setAddingSubintent(false)}>
            Cancel
          </Button>
        </div>
      )}
      {intent.subintents.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1 pl-3">
          {intent.subintents.map((subintent) => (
            <SubintentRow
              key={subintent.id}
              token={token}
              session={session}
              subintent={subintent}
              parentIntent={intent}
              allIntents={allIntents}
              allSubintents={allSubintents}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
