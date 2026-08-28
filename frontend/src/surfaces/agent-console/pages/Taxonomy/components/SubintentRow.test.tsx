import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SubintentRow } from './SubintentRow.tsx';
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

const billing: IntentView = {
  id: 'i1',
  name: 'Billing',
  isSystem: false,
  archivedAt: null,
  subintents: [],
};
const otherIntent: IntentView = {
  id: 'i2',
  name: 'Other',
  isSystem: true,
  archivedAt: null,
  subintents: [],
};

const refunds: IntentSubintentView = {
  id: 's1',
  name: 'Refunds',
  formId: null,
  archivedAt: null,
  defaultPriority: null,
  mergedIntoId: null,
};
const otherSub: IntentSubintentView = {
  id: 's2',
  name: 'Other',
  formId: null,
  archivedAt: null,
  defaultPriority: null,
  mergedIntoId: null,
};

const allSubintents = [{ ...refunds, intentId: 'i1', intentName: 'Billing' }];

describe('SubintentRow', () => {
  it('renders the name and admin controls', async () => {
    renderWithClient(
      <SubintentRow
        token="t"
        session={ADMIN_SESSION}
        subintent={refunds}
        parentIntent={billing}
        allIntents={[billing]}
        allSubintents={allSubintents}
      />,
    );
    expect(await screen.findByText('Refunds')).toBeInTheDocument();
    expect(screen.getByText('Rename')).toBeInTheDocument();
    expect(screen.getByText('Archive')).toBeInTheDocument();
  });

  it('disables Rename/Archive for the Other subintent with an explanatory title', () => {
    renderWithClient(
      <SubintentRow
        token="t"
        session={ADMIN_SESSION}
        subintent={otherSub}
        parentIntent={otherIntent}
        allIntents={[otherIntent]}
        allSubintents={[]}
      />,
    );
    const renameButton = screen.getByText('Rename');
    const archiveButton = screen.getByText('Archive');
    expect(renameButton).toBeDisabled();
    expect(archiveButton).toBeDisabled();
    expect(archiveButton.closest('span')).toHaveAttribute(
      'title',
      'The "Other" subintent can never be archived, merged, or moved.',
    );
  });

  it('calls archiveSubintent and invalidates admin-intents on click', async () => {
    const spy = vi
      .spyOn(agentApi, 'archiveSubintent')
      .mockResolvedValue({ id: 's1', name: 'Refunds', archivedAt: '2026-01-01T00:00:00Z' });
    renderWithClient(
      <SubintentRow
        token="t"
        session={ADMIN_SESSION}
        subintent={refunds}
        parentIntent={billing}
        allIntents={[billing]}
        allSubintents={allSubintents}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByText('Archive'));
    await user.click((await screen.findAllByText('Archive')).at(-1)!);

    await waitFor(() => expect(spy).toHaveBeenCalledWith('t', 's1'));
  });

  it('shows Unarchive for an archived subintent and calls it when the parent intent is active', async () => {
    const archived: IntentSubintentView = { ...refunds, archivedAt: '2026-01-01T00:00:00Z' };
    const spy = vi.spyOn(agentApi, 'unarchiveSubintent').mockResolvedValue({
      id: 's1',
      name: 'Refunds',
      archivedAt: null,
      mergedIntoId: null,
    });
    renderWithClient(
      <SubintentRow
        token="t"
        session={ADMIN_SESSION}
        subintent={archived}
        parentIntent={billing}
        allIntents={[billing]}
        allSubintents={allSubintents}
      />,
    );

    const unarchiveButton = screen.getByText('Unarchive');
    expect(unarchiveButton).not.toBeDisabled();

    const user = userEvent.setup();
    await user.click(unarchiveButton);

    await waitFor(() => expect(spy).toHaveBeenCalledWith('t', 's1'));
  });

  it('disables Unarchive with an explanatory title while the parent intent is archived', () => {
    const archived: IntentSubintentView = { ...refunds, archivedAt: '2026-01-01T00:00:00Z' };
    const archivedIntent: IntentView = { ...billing, archivedAt: '2026-01-01T00:00:00Z' };
    renderWithClient(
      <SubintentRow
        token="t"
        session={ADMIN_SESSION}
        subintent={archived}
        parentIntent={archivedIntent}
        allIntents={[archivedIntent]}
        allSubintents={allSubintents}
      />,
    );

    const unarchiveButton = screen.getByText('Unarchive');
    expect(unarchiveButton).toBeDisabled();
    expect(unarchiveButton.closest('span')).toHaveAttribute(
      'title',
      'Unarchive the parent intent first.',
    );
  });
});
