import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AssignPicker } from './AssignPicker.tsx';
import { fetchWorkspaceAgents, reassignConversation } from '../../../api/agentApi.ts';

vi.mock('../../../api/agentApi.ts');

function renderPicker(currentAssigneeId?: string | null, currentAssigneeName?: string | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AssignPicker
        token="t"
        conversationId="c1"
        currentAssigneeId={currentAssigneeId}
        currentAssigneeName={currentAssigneeName}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AssignPicker', () => {
  it('renders trigger with current assignee name', () => {
    renderPicker('agent-1', 'Alice');
    expect(screen.getByRole('button', { name: 'Alice' })).toBeInTheDocument();
  });

  it('renders trigger with "Unassigned" when no assignee', () => {
    renderPicker();
    expect(screen.getByRole('button', { name: 'Unassigned' })).toBeInTheDocument();
  });

  it('opens popover and lists agents from the agents query', async () => {
    vi.mocked(fetchWorkspaceAgents).mockResolvedValue({
      agents: [
        { id: 'agent-1', display_name: 'Alice' },
        { id: 'agent-2', display_name: 'Bob' },
      ],
    });

    renderPicker(null, 'Unassigned');

    await userEvent.click(screen.getByRole('button', { name: 'Unassigned' }));
    await screen.findByText('Alice');
    await screen.findByText('Bob');
  });

  it('selects an agent and calls the reassign mutation', async () => {
    vi.mocked(fetchWorkspaceAgents).mockResolvedValue({
      agents: [
        { id: 'agent-1', display_name: 'Alice' },
        { id: 'agent-2', display_name: 'Bob' },
      ],
    });
    vi.mocked(reassignConversation).mockResolvedValue({ reassigned: true });

    renderPicker('agent-1', 'Alice');

    await userEvent.click(screen.getByRole('button', { name: 'Alice' }));
    await screen.findByText('Bob');

    await userEvent.click(screen.getByText('Bob'));

    await waitFor(() => expect(reassignConversation).toHaveBeenCalledWith('t', 'c1', 'agent-2'));
  });

  it('filters agents by search query', async () => {
    vi.mocked(fetchWorkspaceAgents).mockResolvedValue({
      agents: [
        { id: 'agent-1', display_name: 'Alice' },
        { id: 'agent-2', display_name: 'Bob' },
        { id: 'agent-3', display_name: 'Charlie' },
      ],
    });

    renderPicker();

    await userEvent.click(screen.getByRole('button', { name: 'Unassigned' }));
    const input = await screen.findByPlaceholderText('Search agents...');
    await userEvent.type(input, 'Charlie');

    // Wait for debounce (250ms) and Alice to disappear
    await waitFor(
      () => {
        expect(screen.queryByText('Alice')).not.toBeInTheDocument();
      },
      { timeout: 1000 },
    );
    await screen.findByText('Charlie');
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });
});
