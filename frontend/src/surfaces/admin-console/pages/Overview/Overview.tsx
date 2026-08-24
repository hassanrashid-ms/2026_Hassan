import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ExternalLink, Pencil, Plus } from 'lucide-react'
import { fetchWorkspaces, type WorkspaceSummary } from '../../api/adminApi.ts'
import { loadAdminSession } from '../../lib/adminSession.ts'
import { Button } from '../../components/ui/button.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.tsx'
import { Skeleton } from '../../components/ui/skeleton.tsx'
import { CreateWorkspaceDialog } from './components/CreateWorkspaceDialog.tsx'
import { RenameWorkspaceDialog } from './components/RenameWorkspaceDialog.tsx'

export function Overview() {
  const session = loadAdminSession()
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<WorkspaceSummary | null>(null)

  const workspacesQuery = useQuery({
    queryKey: ['adminWorkspaces'],
    queryFn: () => fetchWorkspaces(session!.token),
    enabled: session !== null,
  })

  if (!session) return null

  const workspaces = workspacesQuery.data?.workspaces ?? []

  // Reuses the admin's own login token as-is — no new token is minted (see
  // 2026-08-21-superadmin-workspace-console-access-design.md). Only the token
  // goes in the fragment; workspace/agent id and display name aren't secrets,
  // so the query string is fine for them (mirrors lib/boot.ts's convention).
  const openConsole = (workspaceId: string) => {
    const query = new URLSearchParams({ workspace: workspaceId, agentId: session.agentId, name: session.displayName })
    const fragment = new URLSearchParams({ t: session.token })
    window.open(`/inbox?${query.toString()}#${fragment.toString()}`, '_blank', 'noopener')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200 p-4">
        <h1 className="text-sm font-semibold">Workspaces</h1>
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          Create Workspace
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {workspacesQuery.isPending && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        )}

        {workspacesQuery.isError && <p className="text-sm text-red-600">Could not load workspaces.</p>}

        {workspacesQuery.isSuccess && workspaces.length === 0 && (
          <p className="text-sm text-muted">No workspaces yet.</p>
        )}

        {workspaces.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {workspaces.map((workspace) => (
              <Card
                key={workspace.id}
                className="cursor-pointer transition-shadow hover:shadow-md"
                onClick={() => navigate(`/dashboard/workspaces/${workspace.id}`)}
              >
                <CardHeader className="flex-row items-start justify-between">
                  <CardTitle className="text-base">{workspace.name}</CardTitle>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={(e) => {
                        e.stopPropagation()
                        openConsole(workspace.id)
                      }}
                    >
                      <ExternalLink className="size-3.5" />
                      <span className="sr-only">Open console</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={(e) => {
                        e.stopPropagation()
                        setRenameTarget(workspace)
                      }}
                    >
                      <Pencil className="size-3.5" />
                      <span className="sr-only">Rename</span>
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-1 text-sm text-muted">
                  <span>{workspace.slug}</span>
                  <span>
                    {workspace.member_count} {workspace.member_count === 1 ? 'member' : 'members'}
                  </span>
                  <span>Created {new Date(workspace.created_at).toLocaleDateString()}</span>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
      <RenameWorkspaceDialog
        workspace={renameTarget}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null)
        }}
      />
    </div>
  )
}
