import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx';
import * as agentApi from '../api/agentApi.ts';
import * as agentSession from '../lib/agentSession.ts';
import type { StoredAgentSession } from '../lib/agentSession.ts';

function renderWithClient(session: StoredAgentSession) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceSwitcher session={session} />
    </QueryClientProvider>,
  );
}

const SESSION: StoredAgentSession = {
  token: 'tok',
  agentId: 'agent-1',
  displayName: 'Ada',
  workspaceSlug: 'ws-a',
  workspaceId: 'workspace-a',
  role: 'agent',
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('WorkspaceSwitcher', () => {
  it('renders nothing when the agent has zero or one membership', async () => {
    vi.spyOn(agentApi, 'fetchMemberships').mockResolvedValue({
      memberships: [
        {
          workspace_id: 'workspace-a',
          workspace_slug: 'ws-a',
          workspace_name: 'Workspace A',
          role: 'agent',
        },
      ],
    });

    const { container } = renderWithClient(SESSION);

    await waitFor(() => expect(agentApi.fetchMemberships).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('lists every membership and switches on selection', async () => {
    vi.spyOn(agentApi, 'fetchMemberships').mockResolvedValue({
      memberships: [
        {
          workspace_id: 'workspace-a',
          workspace_slug: 'ws-a',
          workspace_name: 'Workspace A',
          role: 'agent',
        },
        {
          workspace_id: 'workspace-b',
          workspace_slug: 'ws-b',
          workspace_name: 'Workspace B',
          role: 'team_lead',
        },
      ],
    });
    const saveSpy = vi.spyOn(agentSession, 'saveAgentSession').mockImplementation(() => {});
    const saveLastActiveSpy = vi
      .spyOn(agentSession, 'saveLastActiveWorkspaceId')
      .mockImplementation(() => {});
    // Selecting triggers a full navigation to reload every workspace-scoped
    // query cleanly — jsdom can't actually navigate, so just observe the call.
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign: assignSpy }, writable: true });

    renderWithClient(SESSION);

    const trigger = await screen.findByRole('button', { name: /workspace a/i });
    await userEvent.click(trigger);
    const otherOption = await screen.findByText('Workspace B');
    await userEvent.click(otherOption);

    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-b',
        workspaceSlug: 'ws-b',
        role: 'team_lead',
      }),
    );
    expect(saveLastActiveSpy).toHaveBeenCalledWith('workspace-b');
    expect(assignSpy).toHaveBeenCalledWith('/inbox');
  });
});
