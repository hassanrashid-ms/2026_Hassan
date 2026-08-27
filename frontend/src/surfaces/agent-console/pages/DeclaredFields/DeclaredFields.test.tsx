import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DeclaredFields } from './DeclaredFields.tsx';
import * as agentApi from '../../api/agentApi.ts';
import * as agentSession from '../../lib/agentSession.ts';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('DeclaredFields', () => {
  it('renders active and inactive fields from GET /agent/declared-fields', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a1',
      displayName: 'A',
      workspaceSlug: 'ws',
      role: 'admin',
    });
    vi.spyOn(agentApi, 'fetchDeclaredFields').mockResolvedValue({
      fields: [
        {
          id: 'f1',
          key: 'vip_status',
          label: 'VIP status',
          type: 'string',
          status: 'active',
          declaredAt: '2026-01-01T00:00:00Z',
          declaredBy: 'a1',
          declaredByName: 'Ada Admin',
        },
        {
          id: 'f2',
          key: 'ab_bucket',
          label: 'AB bucket',
          type: 'string',
          status: 'inactive',
          declaredAt: '2026-01-01T00:00:00Z',
          declaredBy: 'a1',
          declaredByName: 'Ada Admin',
        },
      ],
    });

    renderWithClient(<DeclaredFields />);

    expect(await screen.findByText('vip_status')).toBeInTheDocument();
    expect(screen.getByText('ab_bucket')).toBeInTheDocument();
    expect(screen.getByText('+ Promote field')).toBeInTheDocument();
  });

  it('shows empty state when there are no declared fields', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a1',
      displayName: 'A',
      workspaceSlug: 'ws',
      role: 'admin',
    });
    vi.spyOn(agentApi, 'fetchDeclaredFields').mockResolvedValue({ fields: [] });

    renderWithClient(<DeclaredFields />);

    expect(await screen.findByText('No declared fields yet')).toBeInTheDocument();
  });

  it('promotes a field only after the confirm dialog is accepted', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a1',
      displayName: 'A',
      workspaceSlug: 'ws',
      role: 'admin',
    });
    vi.spyOn(agentApi, 'fetchDeclaredFields').mockResolvedValue({ fields: [] });
    const spy = vi.spyOn(agentApi, 'createDeclaredField').mockResolvedValue({
      id: 'f1',
      key: 'vip_status',
      label: 'VIP status',
      type: 'string',
      status: 'active',
      declaredAt: '2026-01-01T00:00:00Z',
      declaredBy: 'a1',
      declaredByName: null,
    });

    renderWithClient(<DeclaredFields />);
    await screen.findByText('No declared fields yet');

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/key/i), 'vip_status');
    await user.type(screen.getByPlaceholderText('Label'), 'VIP status');
    await user.click(screen.getByText('+ Promote field'));

    expect(spy).not.toHaveBeenCalled();

    await user.click((await screen.findAllByText('Promote')).at(-1)!);

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('t', {
        key: 'vip_status',
        label: 'VIP status',
        type: 'string',
      }),
    );
  });
});
