import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { fetchWorkspaces } from '../../api/adminApi.ts'
import { loadAdminSession } from '../../lib/adminSession.ts'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.tsx'
import { MembersTable } from './components/MembersTable.tsx'
import { SecretPanel } from './components/SecretPanel.tsx'

export function WorkspaceDetail() {
  const { id } = useParams<{ id: string }>()
  const session = loadAdminSession()

  // No single-workspace GET endpoint exists — list-and-find matches the shape
  // Overview already fetches, and shares its query cache when navigated from there.
  const workspacesQuery = useQuery({
    queryKey: ['adminWorkspaces'],
    queryFn: () => fetchWorkspaces(session!.token),
    enabled: !!session,
  })

  if (!session || !id) return null

  const workspace = workspacesQuery.data?.workspaces.find((w) => w.id === id)

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <Link to="/dashboard/overview" className="flex items-center gap-1 text-sm text-muted hover:text-text">
          <ArrowLeft className="size-4" />
          All workspaces
        </Link>
        {workspacesQuery.isPending && <h1 className="text-xl font-semibold text-muted">Loading…</h1>}
        {workspace && (
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-semibold">{workspace.name}</h1>
            <span className="text-sm text-muted">{workspace.slug}</span>
          </div>
        )}
        {workspacesQuery.isSuccess && !workspace && (
          <h1 className="text-xl font-semibold text-muted">Workspace not found</h1>
        )}
      </div>

      {workspace && (
        <Tabs defaultValue="members">
          <TabsList>
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="secret">Secret</TabsTrigger>
          </TabsList>
          <TabsContent value="members">
            <MembersTable token={session.token} workspaceId={workspace.id} />
          </TabsContent>
          <TabsContent value="secret">
            <SecretPanel token={session.token} workspaceId={workspace.id} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
