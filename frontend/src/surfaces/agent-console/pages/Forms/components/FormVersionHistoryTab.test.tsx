import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { FormVersionHistoryTab } from './FormVersionHistoryTab.tsx';
import * as agentApi from '../../../api/agentApi.ts';

function renderTab(onRestored = vi.fn()) {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <FormVersionHistoryTab token="t" formId="form-1" onRestored={onRestored} />
    </QueryClientProvider>,
  );
  return { onRestored };
}

const actor = { id: 'a', display_name: 'Admin', email: 'a@x.test' };

describe('FormVersionHistoryTab', () => {
  it('lists published versions newest-first', async () => {
    vi.spyOn(agentApi, 'fetchFormVersions').mockResolvedValue({
      versions: [
        { version: 2, published_at: '2026-08-27T00:00:00.000Z', actor },
        { version: 1, published_at: '2026-08-26T00:00:00.000Z', actor },
      ],
    });

    renderTab();

    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());
    expect(screen.getByText('v1')).toBeInTheDocument();
  });

  it('shows an empty state with no versions', async () => {
    vi.spyOn(agentApi, 'fetchFormVersions').mockResolvedValue({ versions: [] });

    renderTab();

    await waitFor(() => expect(screen.getByText('No published versions yet.')).toBeInTheDocument());
  });

  it('expands a version to show a field diff against the prior version', async () => {
    vi.spyOn(agentApi, 'fetchFormVersions').mockResolvedValue({
      versions: [
        { version: 2, published_at: '2026-08-27T00:00:00.000Z', actor },
        { version: 1, published_at: '2026-08-26T00:00:00.000Z', actor },
      ],
    });
    vi.spyOn(agentApi, 'fetchFormVersion').mockImplementation(async (_token, _formId, version) => ({
      version,
      published_at: version === 2 ? '2026-08-27T00:00:00.000Z' : '2026-08-26T00:00:00.000Z',
      actor,
      fields:
        version === 2
          ? [
              {
                key: 'order_id',
                label: 'Order Number',
                type: 'short_text',
                isRequired: true,
                position: 0,
              },
            ]
          : [
              {
                key: 'order_id',
                label: 'Order ID',
                type: 'short_text',
                isRequired: true,
                position: 0,
              },
            ],
    }));

    renderTab();
    await waitFor(() => screen.getByText('v2'));
    fireEvent.click(screen.getByText('v2'));

    await waitFor(() =>
      expect(
        screen.getByText('Field "Order Number": label changed from "Order ID"'),
      ).toBeInTheDocument(),
    );
  });

  it('restores a version only after confirming, and calls onRestored', async () => {
    vi.spyOn(agentApi, 'fetchFormVersions').mockResolvedValue({
      versions: [{ version: 1, published_at: '2026-08-26T00:00:00.000Z', actor }],
    });
    const restoreSpy = vi.spyOn(agentApi, 'restoreFormVersion').mockResolvedValue({} as never);

    const { onRestored } = renderTab();
    await waitFor(() => screen.getByText('v1'));

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(restoreSpy).not.toHaveBeenCalled();

    await waitFor(() => screen.getByRole('button', { name: 'Restore version' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore version' }));

    await waitFor(() => expect(restoreSpy).toHaveBeenCalledWith('t', 'form-1', 1));
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
  });
});
