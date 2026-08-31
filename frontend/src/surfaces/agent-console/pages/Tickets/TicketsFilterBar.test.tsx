import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TicketsFilterBar } from './TicketsFilterBar.tsx';
import * as agentApi from '../../api/agentApi.ts';

vi.mock('../../api/agentApi.ts');

const EMPTY_FILTERS = {
  q: '',
  priority: [],
  labelIds: [],
  subintentIds: [],
  assigneeIds: [],
  olderThanHours: '',
  statuses: [],
  createdFrom: '',
  createdTo: '',
  view: 'board' as const,
  sortBy: 'priority',
  sortDir: 'asc' as const,
  sortBy2: 'created',
  sortDir2: 'asc' as const,
};

function renderBar(onChange = vi.fn()) {
  vi.mocked(agentApi.fetchTags).mockResolvedValue([]);
  vi.mocked(agentApi.fetchIntents).mockResolvedValue({ intents: [] });
  vi.mocked(agentApi.fetchWorkspaceAgents).mockResolvedValue({ agents: [] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onChange,
    ...render(
      <QueryClientProvider client={queryClient}>
        <TicketsFilterBar token="t" filters={EMPTY_FILTERS} onChange={onChange} />
      </QueryClientProvider>,
    ),
  };
}

describe('TicketsFilterBar', () => {
  it('renders a Priority filter control', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /Priority/ })).toBeInTheDocument();
  });

  it('debounces search input before calling onChange', async () => {
    const { onChange } = renderBar();
    await userEvent.type(screen.getByPlaceholderText(/Search/i), 'refund');

    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ q: 'refund' }), { timeout: 1000 });
  });

  it('toggling the Priority p1 option calls onChange with the selection', async () => {
    const { onChange } = renderBar();
    await userEvent.click(screen.getByRole('button', { name: /Priority/ }));
    await userEvent.click(await screen.findByText('P1'));

    expect(onChange).toHaveBeenCalledWith({ priority: ['p1'] });
  });

  it('renders a Status filter control', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /Status/ })).toBeInTheDocument();
  });

  it('toggling the Status Escalated option calls onChange with the selection', async () => {
    const { onChange } = renderBar();
    await userEvent.click(screen.getByRole('button', { name: /Status/ }));
    await userEvent.click(await screen.findByText('Escalated'));

    expect(onChange).toHaveBeenCalledWith({ statuses: ['escalated'] });
  });

  it('selecting a date range calls onChange with both bounds', async () => {
    const { onChange } = renderBar();
    await userEvent.click(screen.getByRole('button', { name: /Created date/ }));
    const day1 = await screen.findByRole('gridcell', { name: '1' });
    await userEvent.click(day1.querySelector('button')!);
    const day5 = screen.getByRole('gridcell', { name: '5' });
    await userEvent.click(day5.querySelector('button')!);

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        createdFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        createdTo: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
    );
  });

  it('disables Reset filters when no filters are active', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /Reset filters/ })).toBeDisabled();
  });

  it('enables Reset filters once a filter is set, and clears everything on click', async () => {
    const onChange = vi.fn();
    vi.mocked(agentApi.fetchTags).mockResolvedValue([]);
    vi.mocked(agentApi.fetchIntents).mockResolvedValue({ intents: [] });
    vi.mocked(agentApi.fetchWorkspaceAgents).mockResolvedValue({ agents: [] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TicketsFilterBar
          token="t"
          filters={{ ...EMPTY_FILTERS, priority: ['p1'] }}
          onChange={onChange}
        />
      </QueryClientProvider>,
    );

    const resetButton = screen.getByRole('button', { name: /Reset filters/ });
    expect(resetButton).not.toBeDisabled();
    await userEvent.click(resetButton);

    expect(onChange).toHaveBeenCalledWith({
      q: '',
      priority: [],
      labelIds: [],
      subintentIds: [],
      assigneeIds: [],
      olderThanHours: '',
      statuses: [],
      createdFrom: '',
      createdTo: '',
    });
  });
});
