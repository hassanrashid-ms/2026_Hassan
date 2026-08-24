import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { fetchAgents, setAdminFlag, setSuperAdminFlag } from '../../api/adminApi.ts'
import { ApiError } from '../../../../lib/httpClient.ts'
import { loadAdminSession } from '../../lib/adminSession.ts'
import { Input } from '../../components/ui/input.tsx'
import { Switch } from '../../components/ui/switch.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.tsx'

function reportError(error: unknown) {
  toast.error(error instanceof ApiError ? error.message : 'Something went wrong. Please try again.')
}

/**
 * Global, not workspace-scoped: an admin has implicit access to every
 * workspace, so this lives at the top level next to Overview rather than
 * behind any single workspace's detail page. Super-admin only — grants/revokes
 * the is_admin/is_super_admin flags themselves.
 */
export function Admins() {
  const session = loadAdminSession()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')

  const agentsQuery = useQuery({
    queryKey: ['adminAgentDirectory', query],
    queryFn: () => fetchAgents(session!.token, query || undefined),
    enabled: !!session,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['adminAgentDirectory'] })

  const adminMutation = useMutation({
    mutationFn: (args: { id: string; isAdmin: boolean }) => setAdminFlag(session!.token, args.id, args.isAdmin),
    onSuccess: invalidate,
    onError: reportError,
  })

  const superAdminMutation = useMutation({
    mutationFn: (args: { id: string; isSuperAdmin: boolean }) =>
      setSuperAdminFlag(session!.token, args.id, args.isSuperAdmin),
    onSuccess: invalidate,
    onError: reportError,
  })

  if (!session) return null

  if (!session.isSuperAdmin) {
    return (
      <div className="flex h-full flex-col gap-4 p-6">
        <h1 className="text-sm font-semibold">Admins</h1>
        <p className="text-sm text-muted">Only a super admin can manage admin access.</p>
      </div>
    )
  }

  const agents = agentsQuery.data?.agents ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200 p-4">
        <h1 className="text-sm font-semibold">Admins</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Input
          placeholder="Search by name or email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-4 max-w-sm"
        />

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Admin</TableHead>
              <TableHead>Super admin</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agentsQuery.isPending && (
              <TableRow>
                <TableCell colSpan={3} className="text-muted">
                  Loading…
                </TableCell>
              </TableRow>
            )}
            {agentsQuery.isSuccess && agents.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-muted">
                  No agents found.
                </TableCell>
              </TableRow>
            )}
            {agents.map((agent) => (
              <TableRow key={agent.id}>
                <TableCell>
                  <div className="flex flex-col">
                    <span>{agent.display_name}</span>
                    <span className="text-xs text-muted">{agent.email}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <Switch
                    checked={agent.is_admin}
                    disabled={agent.id === session.agentId}
                    onCheckedChange={(checked) => adminMutation.mutate({ id: agent.id, isAdmin: checked })}
                  />
                </TableCell>
                <TableCell>
                  <Switch
                    checked={agent.is_super_admin}
                    disabled={agent.id === session.agentId}
                    onCheckedChange={(checked) => superAdminMutation.mutate({ id: agent.id, isSuperAdmin: checked })}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
