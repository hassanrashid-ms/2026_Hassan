import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BotTestPanel } from './BotTestPanel.tsx';
import { BotConfigDraftProvider } from '../BotConfigDraftContext.tsx';
import type { BotConfigView } from '@support/types';

// jsdom never lays out real pixels and the global ResizeObserver stub never
// calls back, so Virtuoso's viewport measurement always reads 0 and it mounts
// no items. Give elements a non-zero size and fire the observer once so
// Virtuoso's measurement effect actually runs. Copied verbatim from
// frontend/src/features/chat/components/ChatThread.test.tsx — BotTestPanel
// renders ChatThread and needs the identical shim to mount any message.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get: () => document.body,
  });
  Element.prototype.getBoundingClientRect = () =>
    ({
      width: 600,
      height: 600,
      top: 0,
      left: 0,
      right: 600,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
  globalThis.ResizeObserver = class {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

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
    <QueryClientProvider client={queryClient}>
      <BotConfigDraftProvider config={baseConfig()}>
        <BotTestPanel token="test-token" />
      </BotConfigDraftProvider>
    </QueryClientProvider>,
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
});
