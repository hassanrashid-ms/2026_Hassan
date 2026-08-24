import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { devLogin, fetchAgents, fetchDevAgents } from '../api/adminApi.ts'
import { saveAdminSession } from '../lib/adminSession.ts'
import { ApiError } from '../../../lib/httpClient.ts'
import '../../../admin-console.css'

/**
 * Stands in for the real Google OAuth sign-in ([[agent-auth-google-oauth-domain-restricted]]
 * in memory), same as agent-console/pages/AgentLogin.tsx — out of scope here per the spec.
 * Unlike the agent picker, this one also confirms the picked agent is globally
 * `is_admin` before saving a session, since /admin/* rejects anyone who isn't
 * with 403 regardless of what this page lets through.
 */
export function AdminLogin() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const agentsQuery = useQuery({ queryKey: ['adminDevAgents'], queryFn: fetchDevAgents })

  const onPick = async (agentId: string) => {
    setError(null)
    setPendingId(agentId)
    try {
      const login = await devLogin(agentId)

      // GET /admin/agents is itself gated by requireAdminAccess — a genuine
      // non-admin 403s on this call before we ever get to read is_admin off
      // its response, so that 403 IS the "not an admin" answer, not a generic
      // failure. Only a non-403 (network, 5xx) falls through to the catch below.
      let agentsResult: { agents: Awaited<ReturnType<typeof fetchAgents>>['agents'] } | undefined
      try {
        agentsResult = await fetchAgents(login.token)
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          setError(`${login.agent.display_name} is not an admin.`)
          return
        }
        throw err
      }

      const self = agentsResult.agents.find((a) => a.id === login.agent.id)
      if (!self?.is_admin) {
        setError(`${login.agent.display_name} is not an admin.`)
        return
      }
      saveAdminSession({
        token: login.token,
        agentId: login.agent.id,
        displayName: login.agent.display_name,
        isSuperAdmin: self.is_super_admin,
      })
      navigate('/dashboard/overview')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in as that agent.')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-bg text-text">
      <div className="w-full max-w-sm rounded-card border border-zinc-200 p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Admin sign-in (dev picker)</h1>
        <p className="mt-1 text-sm text-muted">Stands in for Google OAuth until that slice ships.</p>

        {agentsQuery.isPending && <p className="mt-4 text-sm text-muted">Loading agents…</p>}
        {agentsQuery.isError && <p className="mt-4 text-sm text-red-600">Could not load agents.</p>}
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

        <ul className="mt-4 flex flex-col gap-1">
          {agentsQuery.data?.agents.map((agent) => (
            <li key={agent.id}>
              <button
                type="button"
                disabled={pendingId === agent.id}
                onClick={() => onPick(agent.id)}
                className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent-soft disabled:opacity-50"
              >
                {agent.display_name} ({agent.email})
              </button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  )
}
