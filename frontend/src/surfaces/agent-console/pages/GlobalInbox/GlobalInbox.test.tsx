import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GlobalInbox } from './GlobalInbox.tsx';
import * as agentApi from '../../api/agentApi.ts';
import * as agentSession from '../../lib/agentSession.ts';

function renderWithProviders() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <GlobalInbox />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const TICKET = {
  id: 'conv-1',
  player: { external_player_id: 'player-9' },
  status: 'open' as const,
  confirm_phase: 'none' as const,
  last_message_preview: 'Still stuck',
  last_message_at: '2026-08-20T10:00:00Z',
  assigned_agent_id: null,
  assigned_agent_name: null,
  priority: 'p1' as const,
  tags: [],
  created_at: '2026-08-20T09:00:00Z',
  subintent: null,
  number: 1,
  workspace: { id: 'workspace-b', slug: 'ws-b', name: 'Workspace B' },
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
    token: 'tok',
    agentId: 'agent-1',
    displayName: 'Ada',
    workspaceSlug: 'ws-a',
    workspaceId: 'workspace-a',
    role: 'agent',
  });
});

describe('GlobalInbox', () => {
  it('lists tickets merged across workspaces, with the owning workspace shown', async () => {
    vi.spyOn(agentApi, 'fetchGlobalInbox').mockResolvedValue({
      conversations: [TICKET],
      failed_workspaces: [],
    });

    renderWithProviders();

    expect(await screen.findByText('player-9')).toBeInTheDocument();
    expect(screen.getByText('Workspace B')).toBeInTheDocument();
  });

  it('shows a subtle indicator when some workspaces failed to load, without hiding the rest', async () => {
    vi.spyOn(agentApi, 'fetchGlobalInbox').mockResolvedValue({
      conversations: [TICKET],
      failed_workspaces: ['workspace-z'],
    });

    renderWithProviders();

    expect(await screen.findByText('player-9')).toBeInTheDocument();
    expect(screen.getByText(/1 workspace failed to load/i)).toBeInTheDocument();
  });

  it('clicking a ticket switches the active workspace to that ticket’s workspace', async () => {
    vi.spyOn(agentApi, 'fetchGlobalInbox').mockResolvedValue({
      conversations: [TICKET],
      failed_workspaces: [],
    });
    const saveSpy = vi.spyOn(agentSession, 'saveAgentSession').mockImplementation(() => {});
    const saveLastActiveSpy = vi
      .spyOn(agentSession, 'saveLastActiveWorkspaceId')
      .mockImplementation(() => {});
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign: assignSpy }, writable: true });

    renderWithProviders();

    const row = await screen.findByText('player-9');
    await userEvent.click(row);

    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'workspace-b', workspaceSlug: 'ws-b' }),
      ),
    );
    expect(saveLastActiveSpy).toHaveBeenCalledWith('workspace-b');
    expect(assignSpy).toHaveBeenCalledWith('/inbox/conv-1');
  });
});
