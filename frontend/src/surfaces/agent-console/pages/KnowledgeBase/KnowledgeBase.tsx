import { useState } from 'react'
import { loadAgentSession } from '../../lib/agentSession.ts'
import { CategorySidebar } from './components/CategorySidebar.tsx'
import { ArticleTable } from './components/ArticleTable.tsx'
import { ArticleEditorSheet } from './components/ArticleEditorSheet.tsx'

export function KnowledgeBase() {
  const session = loadAgentSession()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)

  if (!session) return null

  return (
    <div className="flex h-full min-h-0">
      <div className="w-56 shrink-0">
        <CategorySidebar token={session.token} />
      </div>
      <div className="min-w-0 flex-1">
        <ArticleTable
          token={session.token}
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
      <ArticleEditorSheet
        token={session.token}
        articleId={selectedId}
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open)
          if (!open) setSelectedId(null)
        }}
        onCreated={(id) => setSelectedId(id)}
      />
    </div>
  )
}
