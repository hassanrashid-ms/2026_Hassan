import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { HistoryPanel } from './HistoryPanel.tsx';
import * as agentApi from '../../../api/agentApi.ts';

function renderPanel(onRestored = vi.fn()) {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <HistoryPanel token="t" field="prompt" onRestored={onRestored} />
    </QueryClientProvider>,
  );
  return { onRestored };
}

describe('HistoryPanel', () => {
  it('lists entries for the given field with a Restore control per entry', async () => {
    vi.spyOn(agentApi, 'fetchBotConfigHistory').mockResolvedValue({
      entries: [
        {
          id: '2',
          field: 'prompt',
          before_value: 'A',
          after_value: 'B',
          actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
          changed_at: '2026-08-19T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });

    renderPanel();

    await waitFor(() => expect(screen.getByText('Admin')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('calls rollbackBotConfig with the entry id and invokes onRestored on success', async () => {
    vi.spyOn(agentApi, 'fetchBotConfigHistory').mockResolvedValue({
      entries: [
        {
          id: '2',
          field: 'prompt',
          before_value: 'A',
          after_value: 'B',
          actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
          changed_at: '2026-08-19T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });
    const rollbackSpy = vi.spyOn(agentApi, 'rollbackBotConfig').mockResolvedValue({} as never);
    const { onRestored } = renderPanel();

    await waitFor(() => screen.getByRole('button', { name: 'Restore' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() =>
      expect(rollbackSpy).toHaveBeenCalledWith('t', {
        field: 'prompt',
        change_log_id: '2',
        side: 'before',
      }),
    );
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
  });
});
