import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormTable } from './FormTable.tsx';
import * as agentApi from '../../../api/agentApi.ts';
import type { StoredAgentSession } from '../../../lib/agentSession.ts';

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

describe('FormTable status labels', () => {
  it('renders each derived status correctly', async () => {
    vi.spyOn(agentApi, 'fetchForms').mockResolvedValue({
      forms: [
        {
          id: '1',
          name: 'Draft form',
          archivedAt: null,
          createdAt: 't',
          mappedSubintentCount: 0,
          publishedVersion: null,
          hasDraft: true,
        },
        {
          id: '2',
          name: 'Published form',
          archivedAt: null,
          createdAt: 't',
          mappedSubintentCount: 2,
          publishedVersion: 2,
          hasDraft: false,
        },
        {
          id: '3',
          name: 'Pending draft form',
          archivedAt: null,
          createdAt: 't',
          mappedSubintentCount: 0,
          publishedVersion: 1,
          hasDraft: true,
        },
        {
          id: '4',
          name: 'Archived form',
          archivedAt: '2026-01-01',
          createdAt: 't',
          mappedSubintentCount: 0,
          publishedVersion: 1,
          hasDraft: false,
        },
      ],
    });

    renderWithClient(
      <FormTable
        token="t"
        session={ADMIN_SESSION}
        selectedId={null}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    await screen.findByText('Draft form');
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Published v2')).toBeInTheDocument();
    expect(screen.getByText('Published v1 · draft pending')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.getByText('2 subintents')).toBeInTheDocument();
  });

  it('hides the actions menu for a non-admin role', async () => {
    vi.spyOn(agentApi, 'fetchForms').mockResolvedValue({
      forms: [
        {
          id: '1',
          name: 'Draft form',
          archivedAt: null,
          createdAt: 't',
          mappedSubintentCount: 0,
          publishedVersion: null,
          hasDraft: true,
        },
      ],
    });

    renderWithClient(
      <FormTable
        token="t"
        session={AGENT_SESSION}
        selectedId={null}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    await screen.findByText('Draft form');
    expect(screen.queryByRole('button', { name: /actions for/i })).not.toBeInTheDocument();
  });

  it('shows the actions menu for an admin on a non-archived form', async () => {
    vi.spyOn(agentApi, 'fetchForms').mockResolvedValue({
      forms: [
        {
          id: '1',
          name: 'Draft form',
          archivedAt: null,
          createdAt: 't',
          mappedSubintentCount: 0,
          publishedVersion: null,
          hasDraft: true,
        },
      ],
    });

    renderWithClient(
      <FormTable
        token="t"
        session={ADMIN_SESSION}
        selectedId={null}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /actions for/i })).toBeInTheDocument(),
    );
  });
});
