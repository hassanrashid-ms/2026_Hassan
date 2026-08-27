import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { VersionHistoryTab } from './VersionHistoryTab.tsx';
import * as agentApi from '../../../api/agentApi.ts';

function renderTab() {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <VersionHistoryTab token="t" />
    </QueryClientProvider>,
  );
}

const rule = (key: string, enabled: boolean) => ({
  key,
  text: `${key} text`,
  enabled,
  locked: false,
  source: 'builtin' as const,
  enforcement: 'prompt' as const,
});

describe('VersionHistoryTab', () => {
  it('lists versions newest-first with changed-field chips', async () => {
    vi.spyOn(agentApi, 'fetchBotConfigVersions').mockResolvedValue({
      versions: [
        {
          version: 2,
          actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
          changed_fields: ['prompt'],
          created_at: '2026-08-27T00:00:00.000Z',
        },
        {
          version: 1,
          actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
          changed_fields: ['prompt', 'rules', 'tools_config', 'limits_config'],
          created_at: '2026-08-26T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });

    renderTab();

    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());
    expect(screen.getByText('v1')).toBeInTheDocument();
  });

  it('expands a version to show a diff against the prior version', async () => {
    vi.spyOn(agentApi, 'fetchBotConfigVersions').mockResolvedValue({
      versions: [
        {
          version: 2,
          actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
          changed_fields: ['prompt'],
          created_at: '2026-08-27T00:00:00.000Z',
        },
        {
          version: 1,
          actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
          changed_fields: ['prompt'],
          created_at: '2026-08-26T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });
    vi.spyOn(agentApi, 'fetchBotConfigVersion').mockImplementation(async (_token, version) =>
      version === 2
        ? {
            version: 2,
            actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
            changed_fields: ['prompt'],
            created_at: '2026-08-27T00:00:00.000Z',
            prompt: 'New prompt',
            rules: [rule('r1', true)],
            tools_config: [],
            limits_config: [],
          }
        : {
            version: 1,
            actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
            changed_fields: ['prompt'],
            created_at: '2026-08-26T00:00:00.000Z',
            prompt: 'Old prompt',
            rules: [rule('r1', true)],
            tools_config: [],
            limits_config: [],
          },
    );

    renderTab();
    await waitFor(() => screen.getByText('v2'));
    fireEvent.click(screen.getByText('v2'));

    await waitFor(() => expect(screen.getByText('New')).toBeInTheDocument());
    expect(screen.getByText('Old')).toBeInTheDocument();
  });

  it('restores a version behind a confirm dialog, and disables restore on the current version', async () => {
    vi.spyOn(agentApi, 'fetchBotConfigVersions').mockResolvedValue({
      versions: [
        {
          version: 2,
          actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
          changed_fields: ['prompt'],
          created_at: '2026-08-27T00:00:00.000Z',
        },
        {
          version: 1,
          actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
          changed_fields: ['prompt', 'rules', 'tools_config', 'limits_config'],
          created_at: '2026-08-26T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });
    const rollbackSpy = vi
      .spyOn(agentApi, 'rollbackBotConfigVersion')
      .mockResolvedValue({} as never);

    renderTab();
    await waitFor(() => screen.getByText('v2'));

    expect(screen.getByRole('button', { name: 'Current version' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    await waitFor(() => screen.getByRole('button', { name: 'Roll back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));

    await waitFor(() => expect(rollbackSpy).toHaveBeenCalledWith('t', 1));
  });

  it('shows an empty state with no prior version to compare', async () => {
    vi.spyOn(agentApi, 'fetchBotConfigVersions').mockResolvedValue({
      versions: [
        {
          version: 1,
          actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
          changed_fields: ['prompt'],
          created_at: '2026-08-26T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });

    renderTab();
    await waitFor(() => screen.getByText('v1'));
    fireEvent.click(screen.getByText('v1'));

    await waitFor(() => expect(screen.getByText('No prior changes.')).toBeInTheDocument());
  });
});
