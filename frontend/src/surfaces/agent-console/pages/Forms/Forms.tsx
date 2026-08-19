import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { loadAgentSession } from '../../lib/agentSession.ts'
import { FormTable } from './components/FormTable.tsx'
import { FormEditorSheet } from './components/FormEditorSheet.tsx'

export function Forms() {
  const session = loadAgentSession()
  // Same deep-link pattern as KnowledgeBase: /forms/:id opens the sheet
  // directly, in-page selection just sets state without touching the URL.
  const { id: routeFormId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<string | null>(routeFormId ?? null)
  const [sheetOpen, setSheetOpen] = useState(routeFormId !== undefined)

  if (!session) return null

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1">
        <FormTable
          token={session.token}
          session={session}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id)
            setSheetOpen(true)
          }}
          onNew={() => {
            setSelectedId(null)
            setSheetOpen(true)
          }}
        />
      </div>
      <FormEditorSheet
        token={session.token}
        session={session}
        formId={selectedId}
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open)
          if (!open) {
            setSelectedId(null)
            if (routeFormId) navigate('/forms', { replace: true })
          }
        }}
        onCreated={(id) => setSelectedId(id)}
      />
    </div>
  )
}
