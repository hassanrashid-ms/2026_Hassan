import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptTab } from './PromptTab.tsx';
import * as agentApi from '../../../api/agentApi.ts';
import { BotConfigDraftProvider } from '../BotConfigDraftContext.tsx';

afterEach(() => {
  vi.restoreAllMocks();
});

const BASE_CONFIG = {
  is_provisioned: true,
  prompt: 'Original prompt',
  rules: [],
  tools_config: [],
  enabled_tools: [],
  limits_config: [],
  resolved_limits: {
    max_bot_messages: 8,
    max_tool_calls_per_turn: 6,
    max_articles_per_turn: 3,
    max_unhelped_replies: 3,
  },
  is_limits_customized: false,
  system_prompt: 'Original prompt',
  is_prompt_customized: false,
  is_rules_customized: false,
  is_tools_customized: false,
  updated_at: null,
};

function renderTab(config = BASE_CONFIG) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <BotConfigDraftProvider config={config}>
        <PromptTab token="t" config={config} />
      </BotConfigDraftProvider>
    </QueryClientProvider>,
  );
}

describe('PromptTab', () => {
  it('saves an edited prompt only after confirming', async () => {
    const saveSpy = vi
      .spyOn(agentApi, 'saveBotConfig')
      .mockResolvedValue({ ...BASE_CONFIG, prompt: 'Edited', is_prompt_customized: true });
    renderTab();

    const textarea = screen.getByLabelText('Prompt');
    fireEvent.change(textarea, { target: { value: 'Edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveSpy).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith('t', { prompt: 'Edited' }));
  });

  it('shows "Reset to default" only when customised', () => {
    renderTab({ ...BASE_CONFIG, is_prompt_customized: false });
    expect(screen.queryByRole('button', { name: 'Reset to default' })).not.toBeInTheDocument();

    renderTab({ ...BASE_CONFIG, is_prompt_customized: true });
    expect(screen.getByRole('button', { name: 'Reset to default' })).toBeInTheDocument();
  });

  it('resets by saving prompt: null only after confirming', async () => {
    const saveSpy = vi.spyOn(agentApi, 'saveBotConfig').mockResolvedValue(BASE_CONFIG);
    renderTab({ ...BASE_CONFIG, is_prompt_customized: true });

    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(saveSpy).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith('t', { prompt: null }));
  });
});
