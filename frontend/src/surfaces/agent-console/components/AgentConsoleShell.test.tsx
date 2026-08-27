import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentConsoleShell } from './AgentConsoleShell.tsx';
import { loadAgentSession, saveAgentSession, type StoredAgentSession } from '../lib/agentSession.ts';
import { fetchMemberships, fetchPresence, updatePresence } from '../api/agentApi.ts';
import { createSocket } from '../../../features/chat/api/socket.ts';

vi.mock('../lib/agentSession.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/agentSession.ts')>(
    '../lib/agentSession.ts',
  );
  return { ...actual, loadAgentSession: vi.fn(actual.loadAgentSession) };
});

vi.mock('../api/agentApi.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/agentApi.ts')>('../api/agentApi.ts');
  return {
    ...actual,
    fetchPresence: vi.fn(),
    updatePresence: vi.fn(),
    fetchMemberships: vi.fn(),
  };
});

vi.mock('../../../features/chat/api/socket.ts');

/** Captures the handlers the shell registers so a test can fire a server event. */
function fakeSocket() {
  const handlers: Record<string, (payload?: unknown) => void> = {};
  const socket = {
    on: (event: string, handler: (payload?: unknown) => void) => {
      handlers[event] = handler;
    },
    emit: vi.fn(),
    close: vi.fn(),
  };
  vi.mocked(createSocket).mockReturnValue(socket as never);
  return handlers;
}

function setLocation(url: string) {
  window.history.pushState(null, '', url);
}

beforeEach(() => {
  fakeSocket();
  vi.mocked(fetchPresence).mockResolvedValue({ status: 'offline' });
  vi.mocked(updatePresence).mockResolvedValue(undefined);
  vi.mocked(fetchMemberships).mockResolvedValue({ memberships: [] });
});

function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/inbox']}>
        <Routes>
          <Route path="/login" element={<div>Login Screen</div>} />
          <Route path="*" element={<AgentConsoleShell />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
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

    expect(screen.queryByRole('link', { name: /team/i })).not.toBeInTheDocument();
  });

  it('shows the Workload nav item for a team_lead role session', () => {
    vi.mocked(loadAgentSession).mockReturnValue(TEAM_LEAD_SESSION);

    renderShell();

    expect(screen.getByRole('link', { name: /team/i })).toBeInTheDocument();
  });

  it('shows the Workload nav item for an admin role session', () => {
    vi.mocked(loadAgentSession).mockReturnValue(ADMIN_SESSION);

    renderShell();

    expect(screen.getByRole('link', { name: /team/i })).toBeInTheDocument();
  });
});

describe('AgentConsoleShell Bot Config nav gating', () => {
  // "See bot config · trigger manual sync" is Team Lead + Admin per the
  // permission matrix (docs/project-overview.md) — only editing the
  // prompt/rules is Admin-only, so the nav item (and its route guard) must
  // not be gated tighter than that.
  it('hides Bot Config for an agent role session', () => {
    vi.mocked(loadAgentSession).mockReturnValue(AGENT_SESSION);

    renderShell();

    expect(screen.queryByRole('link', { name: /bot config/i })).not.toBeInTheDocument();
  });

  it('shows Bot Config for a team_lead role session', () => {
    vi.mocked(loadAgentSession).mockReturnValue(TEAM_LEAD_SESSION);

    renderShell();

    expect(screen.getByRole('link', { name: /bot config/i })).toBeInTheDocument();
  });

  it('shows Bot Config for an admin role session', () => {
    vi.mocked(loadAgentSession).mockReturnValue(ADMIN_SESSION);

    renderShell();

    expect(screen.getByRole('link', { name: /bot config/i })).toBeInTheDocument();
  });
});

describe('AgentConsoleShell role reconciliation', () => {
  beforeEach(async () => {
    // Earlier describe blocks in this file leave loadAgentSession pinned to a
    // fixed mockReturnValue (e.g. AGENT_SESSION) — nothing in this file resets
    // mocks between tests, so that pin would otherwise leak in here and shadow
    // the real localStorage-backed implementation these tests rely on.
    const actual =
      await vi.importActual<typeof import('../lib/agentSession.ts')>('../lib/agentSession.ts');
    vi.mocked(loadAgentSession).mockImplementation(actual.loadAgentSession);
  });

  it('reconciles a stale role badge once membership data confirms a promotion to team lead in the current workspace', async () => {
    // loadAgentSession is a spy wrapping the real implementation (backed by
    // localStorage) — seeding it directly here, rather than overriding it
    // with a fixed mockReturnValue, is what lets the badge actually observe
    // the saveAgentSession() call the fix under test performs.
    saveAgentSession({
      token: 't',
      agentId: 'a1',
      displayName: 'Agent A',
      workspaceSlug: 'ws',
      workspaceId: 'ws-1',
      role: 'agent',
    });
    vi.mocked(fetchMemberships).mockResolvedValue({
      memberships: [
        { workspace_id: 'ws-1', workspace_slug: 'ws', workspace_name: 'Ws', role: 'team_lead' },
      ],
    });

    renderShell();

    expect(await screen.findByText('Team Lead')).toBeInTheDocument();
    expect(screen.queryByText('Agent')).not.toBeInTheDocument();
  });

  it('leaves the role badge alone when the membership role matches the session already', async () => {
    saveAgentSession({
      token: 't',
      agentId: 'a1',
      displayName: 'Agent A',
      workspaceSlug: 'ws',
      workspaceId: 'ws-1',
      role: 'team_lead',
    });
    vi.mocked(fetchMemberships).mockResolvedValue({
      memberships: [
        { workspace_id: 'ws-1', workspace_slug: 'ws', workspace_name: 'Ws', role: 'team_lead' },
      ],
    });

    renderShell();

    expect(await screen.findByText('Team Lead')).toBeInTheDocument();
  });
});

describe('AgentConsoleShell presence dropdown', () => {
  beforeEach(() => {
    vi.mocked(loadAgentSession).mockReturnValue(AGENT_SESSION);
  });

  it('seeds the status dot from GET /agent/presence on mount', async () => {
    vi.mocked(fetchPresence).mockResolvedValue({ status: 'away' });

    renderShell();

    const dot = await screen.findByTestId('presence-dot');
    expect(dot).toHaveAttribute('data-status', 'away');
    expect(fetchPresence).toHaveBeenCalledWith('t');
  });

  it('defaults to offline while the presence fetch is in flight', () => {
    vi.mocked(fetchPresence).mockReturnValue(new Promise(() => {}));

    renderShell();

    expect(screen.getByTestId('presence-dot')).toHaveAttribute('data-status', 'offline');
  });

  it('offers only Online and Away, never Offline or On Leave', async () => {
    renderShell();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /agent a/i }));

    expect(screen.getByRole('menuitem', { name: 'Online' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Away' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Offline' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'On Leave' })).not.toBeInTheDocument();
  });

  it('optimistically updates the dot and calls PATCH /agent/presence on selection', async () => {
    vi.mocked(fetchPresence).mockResolvedValue({ status: 'offline' });
    renderShell();
    const user = userEvent.setup();
    await screen.findByTestId('presence-dot');

    await user.click(screen.getByRole('button', { name: /agent a/i }));
    await user.click(screen.getByRole('menuitem', { name: 'Away' }));

    expect(screen.getByTestId('presence-dot')).toHaveAttribute('data-status', 'away');
    expect(updatePresence).toHaveBeenCalledWith('t', 'away');
  });

  it('updates the dot when a presence_changed event arrives for this agent', async () => {
    const handlers = fakeSocket();
    renderShell();
    await screen.findByTestId('presence-dot');

    handlers['presence_changed']?.({ agentId: 'a1', status: 'away' });

    expect(await screen.findByTestId('presence-dot')).toHaveAttribute('data-status', 'away');
  });

  it('ignores presence_changed events for other agents', async () => {
    const handlers = fakeSocket();
    vi.mocked(fetchPresence).mockResolvedValue({ status: 'online' });
    renderShell();
    await screen.findByTestId('presence-dot');

    handlers['presence_changed']?.({ agentId: 'someone-else', status: 'away' });

    expect(screen.getByTestId('presence-dot')).toHaveAttribute('data-status', 'online');
  });

  it('re-fetches presence when the socket connects, so a slow handshake self-corrects instead of sticking on the stale mount-time snapshot', async () => {
    const handlers = fakeSocket();
    // The mount-time REST snapshot races the socket's own connect+increment
    // and can land first, showing offline while the socket is still
    // handshaking — the socket's own 'connect' event must re-fetch to
    // correct it once this connection is actually live.
    vi.mocked(fetchPresence).mockResolvedValueOnce({ status: 'offline' });
    renderShell();
    expect(await screen.findByTestId('presence-dot')).toHaveAttribute('data-status', 'offline');

    vi.mocked(fetchPresence).mockResolvedValueOnce({ status: 'online' });
    handlers['connect']?.();

    await waitFor(() =>
      expect(screen.getByTestId('presence-dot')).toHaveAttribute('data-status', 'online'),
    );
  });
});
