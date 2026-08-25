import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { devLogin, fetchDevAgents, fetchMemberships } from '../api/agentApi.ts';
import {
  loadLastActiveWorkspaceId,
  saveAgentSession,
  saveLastActiveWorkspaceId,
} from '../lib/agentSession.ts';

export function AgentLogin() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const agentsQuery = useQuery({ queryKey: ['devAgents'], queryFn: fetchDevAgents });

  const onPick = async (agentId: string) => {
    const result = await devLogin(agentId);
    const { memberships } = await fetchMemberships(result.token);

    if (memberships.length === 0) {
      setError(`${result.agent.display_name} has no workspace access yet.`);
      return;
    }

    const lastActiveId = loadLastActiveWorkspaceId();
    const chosen = memberships.find((m) => m.workspace_id === lastActiveId) ?? memberships[0]!;

    saveAgentSession({
      token: result.token,
      agentId: result.agent.id,
      displayName: result.agent.display_name,
      workspaceSlug: chosen.workspace_slug,
      workspaceId: chosen.workspace_id,
      role: chosen.role,
    });
    saveLastActiveWorkspaceId(chosen.workspace_id);
    navigate('/inbox');
  };

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
  );
}
