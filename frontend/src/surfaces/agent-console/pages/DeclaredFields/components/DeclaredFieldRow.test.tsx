import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DeclaredFieldView } from '@support/types';
import { DeclaredFieldRow } from './DeclaredFieldRow.tsx';
import * as agentApi from '../../../api/agentApi.ts';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <table>
        <tbody>{ui}</tbody>
      </table>
    </QueryClientProvider>,
  );
}

const activeField: DeclaredFieldView = {
  id: 'f1',
  key: 'vip_status',
  label: 'VIP status',
  type: 'string',
  status: 'active',
  declaredAt: '2026-01-01T00:00:00Z',
  declaredBy: 'a1',
  declaredByName: 'Ada Admin',
};

const inactiveField: DeclaredFieldView = { ...activeField, status: 'inactive' };

describe('DeclaredFieldRow', () => {
  it('shows the key, label, type, status and declared-by', () => {
    renderWithClient(<DeclaredFieldRow token="t" field={activeField} />);

    expect(screen.getByText('vip_status')).toBeInTheDocument();
    expect(screen.getByText('VIP status')).toBeInTheDocument();
    expect(screen.getByText('string')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText(/Ada Admin/)).toBeInTheDocument();
  });

  it('shows Deactivate for an active field and Reactivate for an inactive one', () => {
    const { rerender } = renderWithClient(<DeclaredFieldRow token="t" field={activeField} />);
    expect(screen.getByText('Deactivate')).toBeInTheDocument();
    expect(screen.queryByText('Reactivate')).not.toBeInTheDocument();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <table>
          <tbody>
            <DeclaredFieldRow token="t" field={inactiveField} />
          </tbody>
        </table>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Reactivate')).toBeInTheDocument();
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
  });

  it('deactivates after confirming, and calls the API with the field id', async () => {
    const spy = vi
      .spyOn(agentApi, 'deactivateDeclaredField')
      .mockResolvedValue({ id: 'f1', key: 'vip_status', status: 'inactive' });
    renderWithClient(<DeclaredFieldRow token="t" field={activeField} />);

    const user = userEvent.setup();
    await user.click(screen.getByText('Deactivate'));
    await user.click((await screen.findAllByText('Deactivate')).at(-1)!);

    await waitFor(() => expect(spy).toHaveBeenCalledWith('t', 'f1'));
  });

  it('reactivates after confirming, and calls the API with the field id', async () => {
    const spy = vi
      .spyOn(agentApi, 'reactivateDeclaredField')
      .mockResolvedValue({ id: 'f1', key: 'vip_status', status: 'active' });
    renderWithClient(<DeclaredFieldRow token="t" field={inactiveField} />);

    const user = userEvent.setup();
    await user.click(screen.getByText('Reactivate'));
    await user.click((await screen.findAllByText('Reactivate')).at(-1)!);

    await waitFor(() => expect(spy).toHaveBeenCalledWith('t', 'f1'));
  });

  it('does not call archive until the confirm dialog is accepted', async () => {
    const spy = vi
      .spyOn(agentApi, 'archiveDeclaredField')
      .mockResolvedValue({ id: 'f1', key: 'vip_status', status: 'archived' });
    renderWithClient(<DeclaredFieldRow token="t" field={activeField} />);

    const user = userEvent.setup();
    await user.click(screen.getByText('×'));

    expect(spy).not.toHaveBeenCalled();
  });

  it('archives after confirming, and calls the API with the field id', async () => {
    const spy = vi
      .spyOn(agentApi, 'archiveDeclaredField')
      .mockResolvedValue({ id: 'f1', key: 'vip_status', status: 'archived' });
    renderWithClient(<DeclaredFieldRow token="t" field={activeField} />);

    const user = userEvent.setup();
    await user.click(screen.getByText('×'));
    await user.click((await screen.findAllByText('Archive')).at(-1)!);

    await waitFor(() => expect(spy).toHaveBeenCalledWith('t', 'f1'));
  });

  it('edits label and saves after confirming', async () => {
    const spy = vi.spyOn(agentApi, 'updateDeclaredField').mockResolvedValue({
      ...activeField,
      label: 'VIP tier',
    });
    renderWithClient(<DeclaredFieldRow token="t" field={activeField} />);

    const user = userEvent.setup();
    await user.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('VIP status');
    await user.clear(input);
    await user.type(input, 'VIP tier');
    await user.click(screen.getByText('Save'));
    await user.click((await screen.findAllByText('Save')).at(-1)!);

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('t', 'f1', { label: 'VIP tier', type: 'string' }),
    );
  });
});
