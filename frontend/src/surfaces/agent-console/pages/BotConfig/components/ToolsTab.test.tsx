import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotConfigView } from '@support/types';
import { ToolsTab } from './ToolsTab.tsx';
import * as agentApi from '../../../api/agentApi.ts';
import { BotConfigDraftProvider } from '../BotConfigDraftContext.tsx';

afterEach(() => {
  vi.restoreAllMocks();
});

const CONFIG: BotConfigView = {
  is_provisioned: true,
  prompt: 'p',
  rules: [],
  tools_config: [
    { tool: 'search_articles', enabled: true },
    { tool: 'classify', enabled: true },
  ],
  enabled_tools: ['search_articles', 'classify'],
  limits_config: [
    { key: 'max_bot_messages', value: 8 },
    { key: 'max_tool_calls_per_turn', value: 6 },
    { key: 'max_articles_per_turn', value: 3 },
    { key: 'max_unhelped_replies', value: 3 },
  ],
  resolved_limits: {
    max_bot_messages: 8,
    max_tool_calls_per_turn: 6,
    max_articles_per_turn: 3,
    max_unhelped_replies: 3,
  },
  system_prompt: 'p',
  is_prompt_customized: false,
  is_rules_customized: false,
  is_tools_customized: false,
  is_limits_customized: false,
  updated_at: null,
};

function renderTab() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <BotConfigDraftProvider config={CONFIG}>
        <ToolsTab token="t" config={CONFIG} />
      </BotConfigDraftProvider>
    </QueryClientProvider>,
  );
}

describe('ToolsTab', () => {
  it('shows a static "always on" row for handoff, with no switch', () => {
    renderTab();
    expect(screen.getByText('handoff')).toBeInTheDocument();
    expect(screen.getByText('Always on')).toBeInTheDocument();
  });

  it('shows the consequence copy inline when a toggle is off', () => {
    const off: BotConfigView = {
      ...CONFIG,
      tools_config: [
        { tool: 'search_articles', enabled: false },
        { tool: 'classify', enabled: true },
      ],
    };
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <BotConfigDraftProvider config={off}>
          <ToolsTab token="t" config={off} />
        </BotConfigDraftProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Bot can never look anything up/)).toBeInTheDocument();
  });

  it('toggling a tool stages the change, saving only after confirmation', async () => {
    const saveSpy = vi.spyOn(agentApi, 'saveBotConfig').mockResolvedValue(CONFIG);
    renderTab();

    fireEvent.click(screen.getAllByRole('switch')[0]!);
    expect(saveSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' })[0]!);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith('t', {
        tools_config: [
          { tool: 'search_articles', enabled: false },
          { tool: 'classify', enabled: true },
        ],
      }),
    );
  });

  it('renders a number input per limit, seeded from resolved_limits', () => {
    renderTab();
    expect(screen.getByLabelText('Max bot messages per conversation')).toHaveValue(8);
    expect(screen.getByLabelText('Max article searches per turn')).toHaveValue(3);
  });

  it('stages a changed limit and saves the full limits_config array only after confirmation', async () => {
    const saveSpy = vi.spyOn(agentApi, 'saveBotConfig').mockResolvedValue(CONFIG);
    renderTab();

    const input = screen.getByLabelText('Max unhelped replies before handoff');
    fireEvent.change(input, { target: { value: '5' } });
    expect(saveSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' })[1]!);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith('t', {
        limits_config: [
          { key: 'max_bot_messages', value: 8 },
          { key: 'max_tool_calls_per_turn', value: 6 },
          { key: 'max_articles_per_turn', value: 3 },
          { key: 'max_unhelped_replies', value: 5 },
        ],
      }),
    );
  });

  it('shows the server error message when a save is rejected as out of bounds', async () => {
    vi.spyOn(agentApi, 'saveBotConfig').mockRejectedValue(
      new Error('"max_bot_messages" must be between 3 and 20.'),
    );
    renderTab();

    const input = screen.getByLabelText('Max bot messages per conversation');
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' })[1]!);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText(/must be between 3 and 20/)).toBeInTheDocument());
  });
});
