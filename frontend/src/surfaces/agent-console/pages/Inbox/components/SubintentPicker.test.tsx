import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SubintentPicker } from './SubintentPicker.tsx';
import { fetchIntents, reclassifyConversation } from '../../../api/agentApi.ts';

vi.mock('../../../api/agentApi.ts');

function renderPicker(
  currentSubintentId?: string | null,
  currentSubintentName?: { intent_name: string; subintent_name: string } | null,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SubintentPicker
        token="t"
        conversationId="c1"
        currentSubintentId={currentSubintentId}
        currentSubintentName={currentSubintentName}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SubintentPicker', () => {
  it('renders current subintent as trigger badge', () => {
    vi.mocked(fetchIntents).mockResolvedValue({
      intents: [
        {
          id: 'intent-1',
          name: 'Billing',
          isSystem: false,
          archivedAt: null,
          subintents: [
            {
              id: 'sub-1',
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

    const { container } = renderPicker('sub-1', {
      intent_name: 'Billing',
      subintent_name: 'Refunds',
    });

    // Badge should be rendered with the current classification
    const badge = container.querySelector('[data-state="closed"]');
    expect(badge?.textContent).toContain('Billing');
    expect(badge?.textContent).toContain('Refunds');
  });

  it('renders a set classification button when no current subintent', () => {
    renderPicker();

    const button = screen.getByRole('button', { name: 'Set classification' });
    expect(button).toBeInTheDocument();
  });

  it('opens popover and lists intents/subintents grouped', async () => {
    vi.mocked(fetchIntents).mockResolvedValue({
      intents: [
        {
          id: 'intent-1',
          name: 'Billing',
          isSystem: false,
          archivedAt: null,
          subintents: [
            {
              id: 'sub-1',
              name: 'Refunds',
              formId: null,
              archivedAt: null,
              defaultPriority: null,
              mergedIntoId: null,
            },
            {
              id: 'sub-2',
              name: 'Invoices',
              formId: null,
              archivedAt: null,
              defaultPriority: null,
              mergedIntoId: null,
            },
          ],
        },
        {
          id: 'intent-2',
          name: 'Technical',
          isSystem: false,
          archivedAt: null,
          subintents: [
            {
              id: 'sub-3',
              name: 'Crashes',
              formId: null,
              archivedAt: null,
              defaultPriority: null,
              mergedIntoId: null,
            },
          ],
        },
      ],
    });

    renderPicker();

    const button = screen.getByRole('button', { name: 'Set classification' });
    await userEvent.click(button);

    await screen.findByText('Billing');
    await screen.findByText('Refunds');
    await screen.findByText('Technical');
    await screen.findByText('Crashes');

    expect(screen.getByText('Refunds')).toBeInTheDocument();
    expect(screen.getByText('Invoices')).toBeInTheDocument();
    expect(screen.getByText('Crashes')).toBeInTheDocument();
  });

  it('skips archived intents and subintents', async () => {
    vi.mocked(fetchIntents).mockResolvedValue({
      intents: [
        {
          id: 'intent-1',
          name: 'Billing',
          isSystem: false,
          archivedAt: null,
          subintents: [
            {
              id: 'sub-1',
              name: 'Refunds',
              formId: null,
              archivedAt: null,
              defaultPriority: null,
              mergedIntoId: null,
            },
            {
              id: 'sub-2',
              name: 'Archived Sub',
              formId: null,
              archivedAt: '2026-01-01T00:00:00Z',
              defaultPriority: null,
              mergedIntoId: null,
            },
          ],
        },
        {
          id: 'intent-2',
          name: 'ArchivedIntent',
          isSystem: false,
          archivedAt: '2026-01-01T00:00:00Z',
          subintents: [
            {
              id: 'sub-3',
              name: 'Hidden',
              formId: null,
              archivedAt: null,
              defaultPriority: null,
              mergedIntoId: null,
            },
          ],
        },
      ],
    });

    renderPicker();

    const button = screen.getByRole('button', { name: 'Set classification' });
    await userEvent.click(button);

    await screen.findByText('Refunds');

    expect(screen.getByText('Refunds')).toBeInTheDocument();
    expect(screen.queryByText('Archived Sub')).not.toBeInTheDocument();
    expect(screen.queryByText('ArchivedIntent')).not.toBeInTheDocument();
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
  });

  it('calls reclassify mutation and invalidates context when selecting a subintent', async () => {
    vi.mocked(fetchIntents).mockResolvedValue({
      intents: [
        {
          id: 'intent-1',
          name: 'Billing',
          isSystem: false,
          archivedAt: null,
          subintents: [
            {
              id: 'sub-1',
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
    vi.mocked(reclassifyConversation).mockResolvedValue({ reclassified: true });

    renderPicker();

    const button = screen.getByRole('button', { name: 'Set classification' });
    await userEvent.click(button);

    const refund = await screen.findByText('Refunds');
    await userEvent.click(refund);

    await waitFor(() => expect(reclassifyConversation).toHaveBeenCalledWith('t', 'c1', 'sub-1'));
  });
});
