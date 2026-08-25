import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MembersTable } from './MembersTable.tsx';
import * as adminApi from '../../../api/adminApi.ts';

function renderWithProviders() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MembersTable token="admin-token" workspaceId="ws-1" />
    </QueryClientProvider>,
  );
}

const MEMBER = {
  agent_id: 'a1',
  email: 'ada@example.test',
  display_name: 'Ada Agent',
  status: 'active',
  role: 'agent' as const,
};

beforeEach(() => {
  vi.spyOn(adminApi, 'fetchMembers').mockResolvedValue({ members: [MEMBER] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MembersTable role change confirmation', () => {
  it('does not change the role immediately — it opens a confirm dialog first', async () => {
    const updateSpy = vi.spyOn(adminApi, 'updateMember');
    renderWithProviders();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Team lead' }));

    expect(await screen.findByText('Promote Ada Agent to Team lead?')).toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('calls updateMember only after the admin confirms the promotion', async () => {
    const updateSpy = vi.spyOn(adminApi, 'updateMember').mockResolvedValue({ ...MEMBER, role: 'team_lead' });
    renderWithProviders();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Team lead' }));
    await user.click(await screen.findByRole('button', { name: 'Promote' }));

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith('admin-token', 'ws-1', 'a1', { role: 'team_lead' }),
    );
  });

  it('leaves the role untouched when the admin cancels', async () => {
    const updateSpy = vi.spyOn(adminApi, 'updateMember');
    renderWithProviders();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Team lead' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Promote Ada Agent to Team lead?')).not.toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('shows a demote confirmation with different copy when moving a team lead back to agent', async () => {
    vi.spyOn(adminApi, 'fetchMembers').mockResolvedValue({
      members: [{ ...MEMBER, role: 'team_lead' }],
    });
    renderWithProviders();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Agent' }));

    expect(await screen.findByText('Demote Ada Agent to Agent?')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Demote' })).toBeInTheDocument();
  });
});
