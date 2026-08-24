import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Workload } from './Workload.tsx';
import { loadAgentSession } from '../../lib/agentSession.ts';
import * as agentApi from '../../api/agentApi.ts';
import { createSocket } from '../../../../features/chat/api/socket.ts';

vi.mock('../../lib/agentSession.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/agentSession.ts')>(
    '../../lib/agentSession.ts',
  );
  return { ...actual, loadAgentSession: vi.fn() };
});

vi.mock('../../../../features/chat/api/socket.ts');

/** Captures the handlers Workload registers so a test can fire a server event. */
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

function renderWithClient() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Workload />
    </QueryClientProvider>,
  );
}

function rowNames() {
  const rows = screen.getAllByRole('row').slice(1); // drop header row
  return rows.map((row) => within(row).getByTestId('agent-name').textContent);
}

let socketHandlers: Record<string, (payload?: unknown) => void> = {};

beforeEach(() => {
  socketHandlers = fakeSocket();
  vi.mocked(loadAgentSession).mockReturnValue({
    token: 't',
    agentId: 'a1',
    displayName: 'A',
    workspaceSlug: 'ws',
  });
  vi.spyOn(agentApi, 'fetchWorkload').mockResolvedValue({
    agents: [
      {
        agentId: '1',
        agentName: 'Alice',
        openCount: 3,
        resolved7d: 10,
        status: 'online',
        onLeaveSince: null,
        onLeaveUntil: null,
      },
      {
        agentId: '2',
        agentName: 'Bob',
        openCount: 8,
        resolved7d: 2,
        status: 'away',
        onLeaveSince: null,
        onLeaveUntil: null,
      },
      {
        agentId: '3',
        agentName: 'Carol',
        openCount: 5,
        resolved7d: 20,
        status: 'offline',
        onLeaveSince: null,
        onLeaveUntil: null,
      },
    ],
  });
});

describe('Workload sorting', () => {
  it('defaults to Open descending', async () => {
    renderWithClient();

    await screen.findByText('Alice');
    expect(rowNames()).toEqual(['Bob', 'Carol', 'Alice']);
  });

  it('re-sorts by Agent ascending then descending on repeated clicks, without refetching', async () => {
    const user = userEvent.setup();
    renderWithClient();

    await screen.findByText('Alice');
    const fetchCountAfterLoad = vi.mocked(agentApi.fetchWorkload).mock.calls.length;

    // First click on a new column sorts descending by that column...
    await user.click(screen.getByRole('button', { name: /^agent$/i }));
    expect(rowNames()).toEqual(['Carol', 'Bob', 'Alice']);

    // ...second click on the same column flips to ascending.
    await user.click(screen.getByRole('button', { name: /^agent$/i }));
    expect(rowNames()).toEqual(['Alice', 'Bob', 'Carol']);

    // Sorting is client-only re-ordering of already-loaded data — no refetch.
    expect(agentApi.fetchWorkload).toHaveBeenCalledTimes(fetchCountAfterLoad);
  });

  it('re-sorts by Resolved (7d) descending on first click', async () => {
    const user = userEvent.setup();
    renderWithClient();

    await screen.findByText('Alice');

    await user.click(screen.getByRole('button', { name: /resolved/i }));
    expect(rowNames()).toEqual(['Carol', 'Alice', 'Bob']);
  });

  it('re-sorts by Open ascending on click since it starts sorted descending', async () => {
    const user = userEvent.setup();
    renderWithClient();

    await screen.findByText('Alice');

    await user.click(screen.getByRole('button', { name: /^open$/i }));
    expect(rowNames()).toEqual(['Alice', 'Carol', 'Bob']);
  });
});

function rowStatuses() {
  const rows = screen.getAllByRole('row').slice(1); // drop header row
  return rows.map((row) => {
    const cell = within(row).getAllByRole('cell')[0]!;
    return within(cell).getByTestId('presence-dot').getAttribute('data-status');
  });
}

describe('Workload presence', () => {
  it('renders a status dot for each agent', async () => {
    renderWithClient();

    await screen.findByText('Alice');
    // Default sort is Open descending: Bob, Carol, Alice.
    expect(rowStatuses()).toEqual(['away', 'offline', 'online']);
  });

  it('patches a row in place on a presence_changed event, without refetching', async () => {
    renderWithClient();

    await screen.findByText('Alice');
    const fetchCountAfterLoad = vi.mocked(agentApi.fetchWorkload).mock.calls.length;

    socketHandlers['presence_changed']?.({ agentId: '3', status: 'online' });

    await screen.findByText('Carol');
    expect(rowStatuses()).toEqual(['away', 'online', 'online']);
    expect(agentApi.fetchWorkload).toHaveBeenCalledTimes(fetchCountAfterLoad);
  });
});

describe('Workload leave toggle', () => {
  it('requires confirming in a dialog before calling setAgentLeave', async () => {
    const user = userEvent.setup();
    vi.spyOn(agentApi, 'setAgentLeave').mockResolvedValue({
      status: 'on_leave',
      onLeaveSince: '2026-08-20T00:00:00.000Z',
      onLeaveUntil: null,
    });
    renderWithClient();

    await screen.findByText('Alice');
    const fetchCountAfterLoad = vi.mocked(agentApi.fetchWorkload).mock.calls.length;

    const aliceRow = screen.getByText('Alice').closest('tr')!;
    await user.click(within(aliceRow).getByRole('button', { name: /set on leave/i }));

    // The click alone must not call the API — a dialog confirmation is required.
    const dialog = await screen.findByRole('dialog');
    expect(agentApi.setAgentLeave).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /^set on leave$/i }));

    expect(agentApi.setAgentLeave).toHaveBeenCalledWith('t', '1', true, undefined);
    expect(await within(aliceRow).findByRole('button', { name: /clear leave/i })).toBeInTheDocument();
    expect(await within(aliceRow).findByText(/on leave/i)).toBeInTheDocument();
    expect(agentApi.fetchWorkload).toHaveBeenCalledTimes(fetchCountAfterLoad);
  });

  it('passes the entered day count through to setAgentLeave', async () => {
    const user = userEvent.setup();
    vi.spyOn(agentApi, 'setAgentLeave').mockResolvedValue({
      status: 'on_leave',
      onLeaveSince: '2026-08-24T00:00:00.000Z',
      onLeaveUntil: '2026-08-29T00:00:00.000Z',
    });
    renderWithClient();

    await screen.findByText('Alice');
    const aliceRow = screen.getByText('Alice').closest('tr')!;
    await user.click(within(aliceRow).getByRole('button', { name: /set on leave/i }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('spinbutton'), '5');
    await user.click(within(dialog).getByRole('button', { name: /^set on leave$/i }));

    expect(agentApi.setAgentLeave).toHaveBeenCalledWith('t', '1', true, 5);
  });

  it('clearing leave sends onLeave: false after confirmation', async () => {
    const user = userEvent.setup();
    vi.mocked(agentApi.fetchWorkload).mockResolvedValue({
      agents: [
        {
          agentId: '1',
          agentName: 'Alice',
          openCount: 3,
          resolved7d: 10,
          status: 'on_leave',
          onLeaveSince: '2026-08-20T00:00:00.000Z',
          onLeaveUntil: null,
        },
      ],
    });
    vi.spyOn(agentApi, 'setAgentLeave').mockResolvedValue({
      status: 'online',
      onLeaveSince: null,
      onLeaveUntil: null,
    });
    renderWithClient();

    await screen.findByText('Alice');
    const aliceRow = screen.getByText('Alice').closest('tr')!;
    await user.click(within(aliceRow).getByRole('button', { name: /clear leave/i }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^clear leave$/i }));

    expect(agentApi.setAgentLeave).toHaveBeenCalledWith('t', '1', false, undefined);
  });
});
