import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AdminConsoleShell } from './AdminConsoleShell.tsx';
import { loadAdminSession } from '../lib/adminSession.ts';
import * as adminApi from '../api/adminApi.ts';

function setLocation(url: string) {
  window.history.pushState(null, '', url);
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/overview']}>
      <Routes>
        <Route path="/dashboard/login" element={<div>Login Screen</div>} />
        <Route path="/dashboard" element={<AdminConsoleShell />}>
          <Route path="overview" element={<div>Overview Screen</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('AdminConsoleShell admin-console-boot bootstrap', () => {
  it('consumes an agent-console deep-link (query + fragment), confirms admin via GET /admin/agents, saves it as a session, and scrubs the token', async () => {
    setLocation('/dashboard/overview?agentId=a1&name=Agent%20A#t=agent.jwt.token');
    vi.spyOn(adminApi, 'fetchAgents').mockResolvedValue({
      agents: [
        {
          id: 'a1',
          display_name: 'Agent A',
          email: 'a1@example.com',
          status: 'active',
          is_admin: true,
          is_super_admin: false,
        },
      ],
    });

    renderShell();

    expect(await screen.findByText('Overview Screen')).toBeInTheDocument();

    const session = loadAdminSession();
    expect(session).toMatchObject({
      token: 'agent.jwt.token',
      agentId: 'a1',
      displayName: 'Agent A',
      isSuperAdmin: false,
    });

    expect(window.location.hash).toBe('');
  });

  it('redirects to /dashboard/login when the boot token is not actually an admin', async () => {
    setLocation('/dashboard/overview?agentId=a1&name=Agent%20A#t=not-an-admin-token');
    vi.spyOn(adminApi, 'fetchAgents').mockRejectedValue(new Error('403'));

    renderShell();

    expect(await screen.findByText('Login Screen')).toBeInTheDocument();
  });

  it('redirects to /dashboard/login when there is no existing session and no boot data in the URL', async () => {
    setLocation('/dashboard/overview');

    renderShell();

    expect(await screen.findByText('Login Screen')).toBeInTheDocument();
  });
});
