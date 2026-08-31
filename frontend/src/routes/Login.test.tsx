import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Login } from './Login.tsx';
import * as adminApi from '../surfaces/admin-console/api/adminApi.ts';
import * as agentApi from '../surfaces/agent-console/api/agentApi.ts';
import { loadAdminSession } from '../surfaces/admin-console/lib/adminSession.ts';
import { loadAgentSession } from '../surfaces/agent-console/lib/agentSession.ts';
import { ApiError } from '../lib/httpClient.ts';

function renderLogin() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/inbox" element={<div>Inbox Screen</div>} />
          <Route path="/dashboard/overview" element={<div>Overview Screen</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(adminApi, 'fetchDevAgents').mockResolvedValue({
    agents: [{ id: 'a1', email: 'a1@example.com', display_name: 'Agent A' }],
  });
});

describe('Login', () => {
  it('lands a platform admin in admin-console', async () => {
    vi.spyOn(adminApi, 'devLogin').mockResolvedValue({
      token: 't',
      agent: { id: 'a1', display_name: 'Agent A' },
      workspace: null,
    });
    vi.spyOn(adminApi, 'fetchAgents').mockResolvedValue({
      agents: [
        {
          id: 'a1',
          email: 'a1@example.com',
          display_name: 'Agent A',
          status: 'active',
          is_admin: true,
          is_super_admin: true,
        },
      ],
    });

    renderLogin();
    const user = userEvent.setup();
    await user.click(await screen.findByText('Agent A (a1@example.com)'));

    expect(await screen.findByText('Overview Screen')).toBeInTheDocument();
    expect(loadAdminSession()).toMatchObject({ token: 't', agentId: 'a1', isSuperAdmin: true });
    expect(loadAgentSession()).toBeNull();
  });

  it('lands a non-admin agent in agent-console via their memberships', async () => {
    vi.spyOn(adminApi, 'devLogin').mockResolvedValue({
      token: 't',
      agent: { id: 'a1', display_name: 'Agent A' },
      workspace: null,
    });
    vi.spyOn(adminApi, 'fetchAgents').mockRejectedValue(new ApiError('forbidden', 403));
    vi.spyOn(agentApi, 'fetchMemberships').mockResolvedValue({
      memberships: [
        { workspace_id: 'ws-1', workspace_slug: 'acme', workspace_name: 'Acme', role: 'agent' },
      ],
    });

    renderLogin();
    const user = userEvent.setup();
    await user.click(await screen.findByText('Agent A (a1@example.com)'));

    expect(await screen.findByText('Inbox Screen')).toBeInTheDocument();
    expect(loadAgentSession()).toMatchObject({
      token: 't',
      agentId: 'a1',
      workspaceId: 'ws-1',
      role: 'agent',
    });
    expect(loadAdminSession()).toBeNull();
  });
});
