import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AgentConsoleShell } from './AgentConsoleShell.tsx';
import { loadAgentSession, type StoredAgentSession } from '../lib/agentSession.ts';

vi.mock('../lib/agentSession.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/agentSession.ts')>(
    '../lib/agentSession.ts',
  );
  return { ...actual, loadAgentSession: vi.fn(actual.loadAgentSession) };
});

function setLocation(url: string) {
  window.history.pushState(null, '', url);
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/inbox']}>
      <Routes>
        <Route path="/login" element={<div>Login Screen</div>} />
        <Route path="*" element={<AgentConsoleShell />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AgentConsoleShell console-boot bootstrap', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.pushState(null, '', '/');
  });

  it('consumes an admin deep-link (query + fragment), saves it as a session, and scrubs the token from the URL', async () => {
    setLocation('/inbox?workspace=ws-1&agentId=admin-1&name=Ada%20Admin#t=admin.jwt.token');

    renderShell();

    expect(await screen.findByText('Ada Admin')).toBeInTheDocument();

    const session = loadAgentSession();
    expect(session).toMatchObject({
      token: 'admin.jwt.token',
      agentId: 'admin-1',
      displayName: 'Ada Admin',
      workspaceId: 'ws-1',
    });

    // Fragment is gone; the query string (not a secret) is left alone.
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?workspace=ws-1&agentId=admin-1&name=Ada%20Admin');
  });

  it('redirects to /login when there is no existing session and no boot data in the URL', async () => {
    setLocation('/inbox');

    renderShell();

    expect(await screen.findByText('Login Screen')).toBeInTheDocument();
  });
});

const AGENT_SESSION: StoredAgentSession = {
  token: 't',
  agentId: 'a1',
  displayName: 'Agent A',
  workspaceSlug: 'ws',
  role: 'agent',
};
const TEAM_LEAD_SESSION: StoredAgentSession = { ...AGENT_SESSION, role: 'team_lead' };
const ADMIN_SESSION: StoredAgentSession = { ...AGENT_SESSION, role: 'admin' };

describe('AgentConsoleShell Workload nav gating', () => {
  it('hides the Workload nav item for an agent role session', () => {
    vi.mocked(loadAgentSession).mockReturnValue(AGENT_SESSION);

    renderShell();

    expect(screen.queryByRole('link', { name: /workload/i })).not.toBeInTheDocument();
  });

  it('shows the Workload nav item for a team_lead role session', () => {
    vi.mocked(loadAgentSession).mockReturnValue(TEAM_LEAD_SESSION);

    renderShell();

    expect(screen.getByRole('link', { name: /workload/i })).toBeInTheDocument();
  });

  it('shows the Workload nav item for an admin role session', () => {
    vi.mocked(loadAgentSession).mockReturnValue(ADMIN_SESSION);

    renderShell();

    expect(screen.getByRole('link', { name: /workload/i })).toBeInTheDocument();
  });
});
