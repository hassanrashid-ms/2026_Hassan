import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RequireRole } from './RequireRole.tsx';
import { loadAgentSession, type StoredAgentSession } from '../lib/agentSession.ts';

vi.mock('../lib/agentSession.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/agentSession.ts')>(
    '../lib/agentSession.ts',
  );
  return { ...actual, loadAgentSession: vi.fn() };
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/inbox" element={<div>Inbox page</div>} />
        <Route
          path="/forms"
          element={
            <RequireRole allow={(s) => s?.role === 'team_lead' || s?.role === 'admin'}>
              <div>Forms page</div>
            </RequireRole>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const AGENT_SESSION: StoredAgentSession = {
  token: 't',
  agentId: 'a1',
  displayName: 'Agent A',
  workspaceSlug: 'ws',
  role: 'agent',
};

describe('RequireRole', () => {
  it('renders the page when the session role passes the check', () => {
    vi.mocked(loadAgentSession).mockReturnValue({ ...AGENT_SESSION, role: 'team_lead' });

    renderAt('/forms');

    expect(screen.getByText('Forms page')).toBeInTheDocument();
  });

  it('redirects to /inbox instead of rendering the page when the role fails the check', () => {
    vi.mocked(loadAgentSession).mockReturnValue(AGENT_SESSION);

    renderAt('/forms');

    expect(screen.queryByText('Forms page')).not.toBeInTheDocument();
    expect(screen.getByText('Inbox page')).toBeInTheDocument();
  });

  it('redirects when there is no session at all', () => {
    vi.mocked(loadAgentSession).mockReturnValue(null);

    renderAt('/forms');

    expect(screen.queryByText('Forms page')).not.toBeInTheDocument();
    expect(screen.getByText('Inbox page')).toBeInTheDocument();
  });
});
