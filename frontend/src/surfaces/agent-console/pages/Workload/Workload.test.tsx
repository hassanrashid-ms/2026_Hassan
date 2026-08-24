import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Workload } from './Workload.tsx';
import { loadAgentSession } from '../../lib/agentSession.ts';
import * as agentApi from '../../api/agentApi.ts';

vi.mock('../../lib/agentSession.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/agentSession.ts')>(
    '../../lib/agentSession.ts',
  );
  return { ...actual, loadAgentSession: vi.fn() };
});

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
  return rows.map((row) => within(row).getAllByRole('cell')[0]?.textContent);
}

beforeEach(() => {
  vi.mocked(loadAgentSession).mockReturnValue({
    token: 't',
    agentId: 'a1',
    displayName: 'A',
    workspaceSlug: 'ws',
  });
  vi.spyOn(agentApi, 'fetchWorkload').mockResolvedValue({
    agents: [
      { agentId: '1', agentName: 'Alice', openCount: 3, resolved7d: 10 },
      { agentId: '2', agentName: 'Bob', openCount: 8, resolved7d: 2 },
      { agentId: '3', agentName: 'Carol', openCount: 5, resolved7d: 20 },
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
