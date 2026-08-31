import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VirtuosoMockContext } from 'react-virtuoso';
import { BotTestPanel } from './BotTestPanel.tsx';
import { BotConfigDraftProvider } from '../BotConfigDraftContext.tsx';
import type { BotConfigView } from '@support/types';

vi.mock('../../../api/agentApi.ts', () => ({
  testBotTurn: vi.fn(),
  fetchIntents: vi.fn().mockResolvedValue({ intents: [] }),
}));

import { testBotTurn } from '../../../api/agentApi.ts';

function baseConfig(): BotConfigView {
  return {
    is_provisioned: true,
    prompt: 'base prompt',
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
    system_prompt: 'base prompt',
    is_prompt_customized: false,
    is_rules_customized: false,
    is_tools_customized: false,
    is_limits_customized: false,
    updated_at: null,
  };
}

function renderPanel() {
  const queryClient = new QueryClient();
  return render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 60 }}>
      <QueryClientProvider client={queryClient}>
        <BotConfigDraftProvider config={baseConfig()}>
          <BotTestPanel token="test-token" />
        </BotConfigDraftProvider>
      </QueryClientProvider>
    </VirtuosoMockContext.Provider>,
  );
}

describe('BotTestPanel', () => {
  beforeEach(() => {
    vi.mocked(testBotTurn).mockReset();
  });

  it('sends the typed message plus the draft config, and renders the bot reply', async () => {
    vi.mocked(testBotTurn).mockResolvedValueOnce({
      decision: { kind: 'answer', reply: 'Here you go', subintent_id: null },
    });

    renderPanel();
    const input = await screen.findByLabelText('Message');
    await userEvent.type(input, 'How do I reset my password?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(testBotTurn).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(testBotTurn).mock.calls[0]!;
    expect(body.config.prompt).toBe('base prompt');
    expect(body.player_message).toBe('How do I reset my password?');

    expect(await screen.findByText('Here you go')).toBeInTheDocument();
  });

  it('shows an error card when the request fails', async () => {
    vi.mocked(testBotTurn).mockRejectedValueOnce(new Error('network error'));

    renderPanel();
    const input = await screen.findByLabelText('Message');
    await userEvent.type(input, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/Test turn failed/)).toBeInTheDocument();
  });

  it('carries the subintent and confirm phase the bot set into the next turn, not always null/none', async () => {
    vi.mocked(testBotTurn)
      .mockResolvedValueOnce({
        decision: {
          kind: 'answer',
          reply: 'Here is the article',
          subintent_id: 'sub-1',
          article_id: 'art-1',
        },
      })
      .mockResolvedValueOnce({
        decision: { kind: 'resolve', subintent_id: 'sub-1' },
      });

    renderPanel();
    const input = await screen.findByLabelText('Message');

    await userEvent.type(input, 'first message');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(testBotTurn).toHaveBeenCalledTimes(1));
    await screen.findByText('Here is the article');

    // Second turn's request must carry forward what the first turn set —
    // classified subintent and the bot_article confirm phase — instead of
    // resending null/'none' as if the bot had never replied.
    await userEvent.type(input, 'second message');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(testBotTurn).toHaveBeenCalledTimes(2));

    const [, secondBody] = vi.mocked(testBotTurn).mock.calls[1]!;
    expect(secondBody.subintent_id).toBe('sub-1');
    expect(secondBody.confirm_phase).toBe('bot_article');
  });
});
