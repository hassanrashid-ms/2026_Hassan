import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntentRow } from './IntentRow.tsx';
import * as agentApi from '../../../api/agentApi.ts';
import type { StoredAgentSession } from '../../../lib/agentSession.ts';
import type { IntentSubintentView, IntentView } from '@support/types';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const ADMIN_SESSION: StoredAgentSession = {
  token: 't',
  agentId: 'a1',
  displayName: 'A',
  workspaceSlug: 'ws',
  role: 'admin',
};
const AGENT_SESSION: StoredAgentSession = {
  token: 't',
  agentId: 'a1',
  displayName: 'A',
  workspaceSlug: 'ws',
  role: 'agent',
};

const billing: IntentView = {
  id: 'i1',
  name: 'Billing',
  isSystem: false,
  archivedAt: null,
  subintents: [],
};
const other: IntentView = {
  id: 'i2',
  name: 'Other',
  isSystem: true,
  archivedAt: null,
  subintents: [],
};
const allSubintents: (IntentSubintentView & { intentId: string; intentName: string })[] = [];

describe('IntentRow', () => {
  it('shows admin-only controls enabled for an admin, disabled for an agent', async () => {
    const { rerender } = renderWithClient(
      <IntentRow
        token="t"
        session={ADMIN_SESSION}
        intent={billing}
        allIntents={[billing]}
        allSubintents={allSubintents}
      />,
    );
    expect(await screen.findByText('Billing')).toBeInTheDocument();
    expect(screen.getByText('Rename')).not.toBeDisabled();
    expect(screen.getByText('Archive')).not.toBeDisabled();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <IntentRow
          token="t"
          session={AGENT_SESSION}
          intent={billing}
          allIntents={[billing]}
          allSubintents={allSubintents}
        />
      </QueryClientProvider>,
    );
    const renameButton = screen.getByText('Rename');
    const archiveButton = screen.getByText('Archive');
    expect(renameButton).toBeDisabled();
    expect(archiveButton).toBeDisabled();
    expect(renameButton.closest('span')).toHaveAttribute(
      'title',
      'Only an admin can manage intents.',
    );
    expect(archiveButton.closest('span')).toHaveAttribute(
      'title',
      'Only an admin can manage intents.',
    );
  });

  it('disables Archive for the system intent with an explanatory title', () => {
    renderWithClient(
      <IntentRow
        token="t"
        session={ADMIN_SESSION}
        intent={other}
        allIntents={[other]}
        allSubintents={allSubintents}
      />,
    );
    const archiveButton = screen.getByText('Archive');
    expect(archiveButton).toBeDisabled();
    expect(archiveButton.closest('span')).toHaveAttribute(
      'title',
      'The "Other" intent can never be archived.',
    );
  });

  it('calls archiveIntent and invalidates admin-intents on click', async () => {
    const spy = vi
      .spyOn(agentApi, 'archiveIntent')
      .mockResolvedValue({ id: 'i1', name: 'Billing', archivedAt: '2026-01-01T00:00:00Z' });
    renderWithClient(
      <IntentRow
        token="t"
        session={ADMIN_SESSION}
        intent={billing}
        allIntents={[billing]}
        allSubintents={allSubintents}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByText('Archive'));
    await user.click((await screen.findAllByText('Archive')).at(-1)!);

    await waitFor(() => expect(spy).toHaveBeenCalledWith('t', 'i1'));
  });

  it('shows Unarchive instead of the active-state controls for an archived intent, and calls it', async () => {
    const archived: IntentView = { ...billing, archivedAt: '2026-01-01T00:00:00Z' };
    const spy = vi
      .spyOn(agentApi, 'unarchiveIntent')
      .mockResolvedValue({ id: 'i1', name: 'Billing', archivedAt: null });
    renderWithClient(
      <IntentRow
        token="t"
        session={ADMIN_SESSION}
        intent={archived}
        allIntents={[archived]}
        allSubintents={allSubintents}
      />,
    );

    expect(screen.queryByText('Archive')).not.toBeInTheDocument();
    expect(screen.queryByText('Rename')).not.toBeInTheDocument();
    const unarchiveButton = screen.getByText('Unarchive');

    const user = userEvent.setup();
    await user.click(unarchiveButton);

    await waitFor(() => expect(spy).toHaveBeenCalledWith('t', 'i1'));
  });
});
