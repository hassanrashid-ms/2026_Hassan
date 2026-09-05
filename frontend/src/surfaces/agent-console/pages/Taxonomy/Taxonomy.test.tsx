import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Taxonomy } from './Taxonomy.tsx';
import * as agentApi from '../../api/agentApi.ts';
import * as agentSession from '../../lib/agentSession.ts';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('Taxonomy', () => {
  it('renders the intent tree from GET /agent/intents', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a1',
      displayName: 'A',
      workspaceSlug: 'ws',
      role: 'admin',
    });
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({
      intents: [
        {
          id: 'i1',
          name: 'Billing',
          isSystem: false,
          archivedAt: null,
          subintents: [
            {
              id: 's1',
              name: 'Refunds',
              formId: null,
              archivedAt: null,
              defaultPriority: null,
              mergedIntoId: null,
            },
          ],
        },
      ],
    });

    renderWithClient(<Taxonomy />);

    expect(await screen.findByText('Billing')).toBeInTheDocument();
    expect(await screen.findByText('Refunds')).toBeInTheDocument();
    expect(screen.getByText('+ Add intent')).toBeInTheDocument();
  });

  it('renders archived intents in a separate section after the active ones', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a1',
      displayName: 'A',
      workspaceSlug: 'ws',
      role: 'admin',
    });
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({
      intents: [
        {
          id: 'i1',
          name: 'Billing',
          isSystem: false,
          archivedAt: null,
          subintents: [],
        },
        {
          id: 'i2',
          name: 'Old Category',
          isSystem: false,
          archivedAt: '2026-01-01T00:00:00Z',
          subintents: [],
        },
      ],
    });

    renderWithClient(<Taxonomy />);

    expect(await screen.findByText('Billing')).toBeInTheDocument();
    expect(await screen.findByText('Old Category')).toBeInTheDocument();
    const archivedHeading = screen.getByText('Archived', { selector: 'p' });
    const billing = screen.getByText('Billing');
    const oldCategory = screen.getByText('Old Category');
    // Archived section heading must sit after the active row and before the archived row.
    expect(
      billing.compareDocumentPosition(archivedHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      archivedHeading.compareDocumentPosition(oldCategory) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows "+ Add intent" disabled for a non-admin, with an explanatory title', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a1',
      displayName: 'A',
      workspaceSlug: 'ws',
      role: 'agent',
    });
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] });

    renderWithClient(<Taxonomy />);

    await screen.findByText('Taxonomy');
    const addButton = screen.getByText('+ Add intent');
    expect(addButton).toBeDisabled();
    expect(addButton.closest('[title]')).toHaveAttribute('title', 'Only an admin can add intents.');
  });
});
