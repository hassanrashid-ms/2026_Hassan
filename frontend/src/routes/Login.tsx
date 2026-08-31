import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { devLogin, fetchAgents, fetchDevAgents } from '../surfaces/admin-console/api/adminApi.ts';
import { saveAdminSession } from '../surfaces/admin-console/lib/adminSession.ts';
import { fetchMemberships } from '../surfaces/agent-console/api/agentApi.ts';
import {
  loadLastActiveWorkspaceId,
  saveAgentSession,
  saveLastActiveWorkspaceId,
} from '../surfaces/agent-console/lib/agentSession.ts';
import { ApiError } from '../lib/httpClient.ts';
// Neither surface's shell is mounted for this page (it's the pre-session
// landing page for both), so its theme tokens aren't otherwise on the page —
// imported directly here rather than relying on AdminConsoleShell.tsx (or
// AgentConsoleShell.tsx) to have done it first.
import '../admin-console.css';

/**
 * One picker for both consoles, replacing the former AgentLogin.tsx and
 * AdminLogin.tsx. Stands in for Google OAuth until that slice ships — same
 * dev picker either page used, just no longer duplicated. Where the picked
 * agent lands is decided here, not chosen by the agent: a platform admin
 * (agent.is_admin) always lands in admin-console; anyone else lands in
 * agent-console via their most recent workspace, exactly as AgentLogin.tsx
 * did.
 */
export function Login() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const agentsQuery = useQuery({ queryKey: ['devAgents'], queryFn: fetchDevAgents });

  const onPick = async (agentId: string) => {
    setError(null);
    setPendingId(agentId);
    try {
      const login = await devLogin(agentId);

      // GET /admin/agents is gated by requireAdminAccess — a 403 here just
      // means this agent isn't a platform admin, not a failure to handle.
      let self: { is_admin: boolean; is_super_admin: boolean } | undefined;
      try {
        const { agents } = await fetchAgents(login.token);
        self = agents.find((a) => a.id === login.agent.id);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 403)) throw err;
      }

      if (self?.is_admin) {
        saveAdminSession({
          token: login.token,
          agentId: login.agent.id,
          displayName: login.agent.display_name,
          isSuperAdmin: self.is_super_admin,
        });
        navigate('/dashboard/overview');
        return;
      }

      const { memberships } = await fetchMemberships(login.token);
      if (memberships.length === 0) {
        setError(`${login.agent.display_name} has no workspace access yet.`);
        return;
      }

      const lastActiveId = loadLastActiveWorkspaceId();
      const chosen = memberships.find((m) => m.workspace_id === lastActiveId) ?? memberships[0]!;

      saveAgentSession({
        token: login.token,
        agentId: login.agent.id,
        displayName: login.agent.display_name,
        workspaceSlug: chosen.workspace_slug,
        workspaceId: chosen.workspace_id,
        role: chosen.role,
      });
      saveLastActiveWorkspaceId(chosen.workspace_id);
      navigate('/inbox');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in as that agent.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-bg text-text">
      <div className="w-full max-w-sm rounded-card border border-zinc-200 p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Sign in (dev picker)</h1>
        <p className="mt-1 text-sm text-muted">
          Stands in for Google OAuth until that slice ships.
        </p>

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
  );
}
