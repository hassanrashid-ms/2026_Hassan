import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BotConfigDraftProvider, useBotConfigDraft } from './BotConfigDraftContext.tsx';
import type { BotConfigView } from '@support/types';

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

function DraftReader() {
  const { draft } = useBotConfigDraft();
  return <span>{draft?.prompt ?? 'none'}</span>;
}

function DraftRulesReader() {
  const { draft } = useBotConfigDraft();
  return <span>{draft ? JSON.stringify(draft.rules) : 'none'}</span>;
}

describe('BotConfigDraftContext', () => {
  it('seeds the draft from the loaded config once it arrives', async () => {
    render(
      <BotConfigDraftProvider config={baseConfig()}>
        <DraftReader />
      </BotConfigDraftProvider>,
    );
    expect(await screen.findByText('base prompt')).toBeInTheDocument();
  });

  it('strips the derived enforcement field from rules when seeding, even if RulesTab never mounts', async () => {
    const config = {
      ...baseConfig(),
      rules: [
        {
          key: 'no_credentials',
          text: 'Never ask for a password.',
          enabled: true,
          locked: true,
          source: 'builtin' as const,
          enforcement: 'prompt' as const,
        },
      ],
    };
    render(
      <BotConfigDraftProvider config={config}>
        <DraftRulesReader />
      </BotConfigDraftProvider>,
    );
    const text = await screen.findByText(/no_credentials/);
    expect(text.textContent).not.toContain('enforcement');
  });

  it('has no draft yet while config is undefined', () => {
    render(
      <BotConfigDraftProvider config={undefined}>
        <DraftReader />
      </BotConfigDraftProvider>,
    );
    expect(screen.getByText('none')).toBeInTheDocument();
  });
});
