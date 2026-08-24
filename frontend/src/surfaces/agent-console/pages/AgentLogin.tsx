import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { devLogin, fetchDevAgents } from '../api/agentApi.ts'
import { saveAgentSession } from '../lib/agentSession.ts'

export function AgentLogin() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const agentsQuery = useQuery({ queryKey: ['devAgents'], queryFn: fetchDevAgents })

  const onPick = async (agentId: string) => {
    const result = await devLogin(agentId)
    // A global admin has no fixed workspace to log into here — this picker is
    // for agents working tickets in one workspace. Admins sign in through the
    // admin console and open a specific workspace's console from there
    // (see 2026-08-21-superadmin-workspace-console-access-design.md).
    if (!result.workspace) {
      setError(`${result.agent.display_name} is an admin — sign in from the admin console instead.`)
      return
    }
    saveAgentSession({
      token: result.token,
      agentId: result.agent.id,
      displayName: result.agent.display_name,
      workspaceSlug: result.workspace.slug,
      workspaceId: result.workspace.id,
    })
    navigate('/inbox')
  }

  return (
    <main className="agent-login">
      <h1>Sign in (dev picker)</h1>
      <p className="notice">Stands in for Google OAuth until that slice ships.</p>
      {agentsQuery.isPending && <p>Loading agents…</p>}
      {agentsQuery.isError && <p className="notice">Could not load agents.</p>}
      {error && <p className="notice">{error}</p>}
      <ul>
        {agentsQuery.data?.agents.map((agent) => (
          <li key={agent.id}>
            <button type="button" onClick={() => onPick(agent.id)}>
              {agent.display_name} ({agent.email})
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}
