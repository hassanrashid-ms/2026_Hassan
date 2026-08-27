import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WorkspaceSettings } from './WorkspaceSettings.tsx';
import * as agentApi from '../../api/agentApi.ts';
import * as agentSession from '../../lib/agentSession.ts';

function renderWithQuery() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceSettings />
    </QueryClientProvider>,
  );
}

const SETTINGS = {
  max_assigned_tickets: 5,
  auto_close_days: 7,
  inactivity_window_hours: 24,
  form_timeout_minutes: 30,
};

describe('WorkspaceSettings page', () => {
  beforeEach(() => {
    vi.spyOn(agentApi, 'fetchWorkspaceSettings').mockResolvedValue(SETTINGS);
  });

  it('renders current values for an admin session', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a',
      displayName: 'Admin',
      workspaceSlug: 'ws',
      role: 'admin',
    });

    renderWithQuery();

    await waitFor(() => expect(screen.getByLabelText('Max assigned tickets')).toHaveValue(5));
    expect(screen.getByLabelText('Auto-close days')).toHaveValue(7);
    expect(screen.getByLabelText('Inactivity window (hours)')).toHaveValue(24);
    expect(screen.getByLabelText('Form timeout (minutes)')).toHaveValue(30);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('only enables Save once a value actually changes', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a',
      displayName: 'Admin',
      workspaceSlug: 'ws',
      role: 'admin',
    });

    renderWithQuery();

    await waitFor(() => expect(screen.getByLabelText('Max assigned tickets')).toHaveValue(5));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await userEvent.clear(screen.getByLabelText('Max assigned tickets'));
    await userEvent.type(screen.getByLabelText('Max assigned tickets'), '10');
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();

    await userEvent.clear(screen.getByLabelText('Max assigned tickets'));
    await userEvent.type(screen.getByLabelText('Max assigned tickets'), '5');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('submits an update', async () => {
    const saveSpy = vi
      .spyOn(agentApi, 'saveWorkspaceSettings')
      .mockResolvedValue({ ...SETTINGS, max_assigned_tickets: 10 });
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a',
      displayName: 'Admin',
      workspaceSlug: 'ws',
      role: 'admin',
    });

    renderWithQuery();

    await waitFor(() => expect(screen.getByLabelText('Max assigned tickets')).toHaveValue(5));

    const input = screen.getByLabelText('Max assigned tickets');
    await userEvent.clear(input);
    await userEvent.type(input, '10');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Save workspace settings?')).toBeInTheDocument();
    expect(saveSpy).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith('t', { ...SETTINGS, max_assigned_tickets: 10 }),
    );
  });

  it('disables inputs and save button for a non-admin session', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a',
      displayName: 'Lead',
      workspaceSlug: 'ws',
      role: 'team_lead',
    });

    renderWithQuery();

    await waitFor(() => expect(screen.getByLabelText('Max assigned tickets')).toHaveValue(5));
    expect(screen.getByLabelText('Max assigned tickets')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText('Only an admin can change workspace settings.')).toBeInTheDocument();
  });
});
