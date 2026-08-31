import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Tickets } from './Tickets.tsx';
import { loadAgentSession } from '../../lib/agentSession.ts';
import * as agentApi from '../../api/agentApi.ts';

vi.mock('../../lib/agentSession.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/agentSession.ts')>(
    '../../lib/agentSession.ts',
  );
  return { ...actual, loadAgentSession: vi.fn() };
});
vi.mock('../../../../features/chat/api/socket.ts', () => ({
  createSocket: () => ({ on: vi.fn(), close: vi.fn() }),
}));
vi.mock('../../api/agentApi.ts');

function renderTickets(path = '/tickets') {
  vi.mocked(loadAgentSession).mockReturnValue({
    token: 'tok',
    agentId: 'agent-1',
    workspaceId: 'ws-1',
  } as never);
  vi.mocked(agentApi.fetchTags).mockResolvedValue([]);
  vi.mocked(agentApi.fetchIntents).mockResolvedValue({ intents: [] });
  vi.mocked(agentApi.fetchWorkspaceAgents).mockResolvedValue({ agents: [] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tickets" element={<Tickets />} />
          <Route path="/tickets/:conversationId" element={<Tickets />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('Tickets filtering', () => {
  it('passes the active filters through to fetchInbox for every column', async () => {
    const fetchInboxSpy = vi
      .mocked(agentApi.fetchInbox)
      .mockResolvedValue({ conversations: [], nextCursor: null });
    renderTickets('/tickets?priority=p1');

    await waitFor(() =>
      expect(fetchInboxSpy).toHaveBeenCalledWith(
        'tok',
        'unassigned',
        expect.objectContaining({ priority: ['p1'] }),
      ),
    );
    expect(fetchInboxSpy).toHaveBeenCalledWith(
      'tok',
      'botHandling',
      expect.objectContaining({ priority: ['p1'] }),
    );
    expect(fetchInboxSpy).toHaveBeenCalledWith(
      'tok',
      'agentAssigned',
      expect.objectContaining({ priority: ['p1'] }),
    );
    expect(fetchInboxSpy).toHaveBeenCalledWith(
      'tok',
      'escalated',
      expect.objectContaining({ priority: ['p1'] }),
    );
  });

  it('shows a filtered-empty message distinct from a genuinely empty column', async () => {
    vi.mocked(agentApi.fetchInbox).mockImplementation((_token, status) =>
      Promise.resolve({ conversations: status === 'unassigned' ? [] : [], nextCursor: null }),
    );
    renderTickets('/tickets?priority=p1');

    await screen.findAllByText('No tickets match your filters.');
  });

  it('shows the default empty state with no filters active', async () => {
    vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [], nextCursor: null });
    renderTickets('/tickets');

    await waitFor(() => expect(agentApi.fetchInbox).toHaveBeenCalled());
    expect(screen.queryByText('No tickets match your filters.')).not.toBeInTheDocument();
  });
});

describe('Tickets pagination', () => {
  it('renders Resolved and Closed columns', async () => {
    vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [], nextCursor: null });
    renderTickets('/tickets');

    await screen.findByText('Resolved');
    await screen.findByText('Closed');
  });

  it('requests fetchInbox for the resolved and closed filters', async () => {
    const fetchInboxSpy = vi
      .mocked(agentApi.fetchInbox)
      .mockResolvedValue({ conversations: [], nextCursor: null });
    renderTickets('/tickets');

    await waitFor(() =>
      expect(fetchInboxSpy).toHaveBeenCalledWith('tok', 'resolved', expect.anything(), undefined),
    );
    expect(fetchInboxSpy).toHaveBeenCalledWith('tok', 'closed', expect.anything(), undefined);
  });

  it('fetches the next page when a column is scrolled near its bottom', async () => {
    const conversation = (id: string) => ({
      id,
      player: { external_player_id: 'p1' },
      status: 'open' as const,
      confirm_phase: 'none' as const,
      last_message_preview: null,
      last_message_at: null,
      assigned_agent_id: null,
      assigned_agent_name: null,
      priority: 'p3' as const,
      tags: [],
    });

    const fetchInboxSpy = vi
      .mocked(agentApi.fetchInbox)
      .mockImplementation((_t, status, _f, cursor) => {
        if (status !== 'unassigned')
          return Promise.resolve({ conversations: [], nextCursor: null });
        if (!cursor) {
          return Promise.resolve({ conversations: [conversation('c1')], nextCursor: 'page-2' });
        }
        return Promise.resolve({ conversations: [conversation('c2')], nextCursor: null });
      });

    renderTickets('/tickets');
    await waitFor(() =>
      expect(fetchInboxSpy).toHaveBeenCalledWith('tok', 'unassigned', expect.anything(), undefined),
    );
    await screen.findByText('p1');

    const scrollable = document.querySelector('.overflow-y-auto') as HTMLElement;
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scrollable, 'scrollTop', { value: 700, configurable: true });
    scrollable.dispatchEvent(new Event('scroll', { bubbles: true }));

    await waitFor(() =>
      expect(fetchInboxSpy).toHaveBeenCalledWith('tok', 'unassigned', expect.anything(), 'page-2'),
    );
  });
});

describe('Tickets view toggle', () => {
  it('defaults to board view with all six columns visible', async () => {
    vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [], nextCursor: null });
    renderTickets('/tickets');

    await screen.findByText('Unassigned');
    expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'List' })).toBeInTheDocument();
  });

  it('switches to list view and fetches the merged "all" filter', async () => {
    const fetchInboxSpy = vi
      .mocked(agentApi.fetchInbox)
      .mockResolvedValue({ conversations: [], nextCursor: null });
    renderTickets('/tickets?view=list');

    await waitFor(() =>
      expect(fetchInboxSpy).toHaveBeenCalledWith('tok', 'all', expect.anything(), undefined),
    );
    expect(screen.queryByText('Unassigned')).not.toBeInTheDocument();
  });

  it('hides board columns not in the Status filter', async () => {
    vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [], nextCursor: null });
    renderTickets('/tickets?statuses=unassigned');

    await screen.findByText('Unassigned');
    expect(screen.queryByText('Bot Handling')).not.toBeInTheDocument();
  });

  it('renders a claim action only for unassigned rows in list view', async () => {
    const row = (id: string, status: 'open' | 'escalated', assignedAgentId: string | null) => ({
      id,
      player: { external_player_id: id },
      status,
      confirm_phase: 'none' as const,
      last_message_preview: null,
      last_message_at: null,
      assigned_agent_id: assignedAgentId,
      assigned_agent_name: assignedAgentId ? 'Agent One' : null,
      priority: 'p3' as const,
      tags: [],
    });
    vi.mocked(agentApi.fetchInbox).mockResolvedValue({
      conversations: [row('unassigned-1', 'open', null), row('escalated-1', 'escalated', 'a1')],
      nextCursor: null,
    });
    renderTickets('/tickets?view=list');

    await screen.findByText('unassigned-1');
    const claimButtons = await screen.findAllByRole('button', { name: 'Claim' });
    expect(claimButtons).toHaveLength(1);
  });
});
