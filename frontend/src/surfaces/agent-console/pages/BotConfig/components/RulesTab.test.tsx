import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotConfigView } from '@support/types'
import { RulesTab } from './RulesTab.tsx'
import * as agentApi from '../../../api/agentApi.ts'

/*
 * vi.spyOn returns the SAME mock (with its accumulated `mock.calls` history)
 * when the target is already spied, rather than creating a fresh one — so
 * without this, `saveBotConfig`'s call history from an earlier `it()` in this
 * file leaks into `.mock.calls[0]` of a later one. restoreAllMocks puts the
 * real `saveBotConfig` back after each test so the next `vi.spyOn` call
 * creates a brand-new mock with empty history, scoped to this file only.
 */
afterEach(() => {
  vi.restoreAllMocks()
})

const CONFIG: BotConfigView = {
  is_provisioned: true,
  prompt: 'p',
  rules: [
    { key: 'no_credentials', text: 'Never ask for a password.', enabled: true, locked: true, source: 'builtin', enforcement: 'prompt' },
    { key: 'no_regreet', text: 'Do not greet twice.', enabled: true, locked: false, source: 'builtin', enforcement: 'prompt' },
  ],
  tools_config: [],
  enabled_tools: [],
  limits_config: [],
  resolved_limits: { max_bot_messages: 8, max_tool_calls_per_turn: 6, max_articles_per_turn: 3, max_unhelped_replies: 3 },
  is_limits_customized: false,
  system_prompt: 'p',
  is_prompt_customized: false,
  is_rules_customized: false,
  is_tools_customized: false,
  updated_at: null,
}

function renderTab() {
  const queryClient = new QueryClient()
  return render(
    <QueryClientProvider client={queryClient}>
      <RulesTab token="t" config={CONFIG} />
    </QueryClientProvider>,
  )
}

describe('RulesTab', () => {
  it('renders a disabled switch for a locked rule', () => {
    renderTab()
    const switches = screen.getAllByRole('switch')
    const lockedSwitch = switches[0]
    expect(lockedSwitch).toBeDisabled()
  })

  it('toggling an unlocked rule saves the full updated rules array', async () => {
    const saveSpy = vi.spyOn(agentApi, 'saveBotConfig').mockResolvedValue(CONFIG)
    renderTab()

    fireEvent.click(screen.getAllByRole('switch')[1]!)

    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith('t', {
        rules: [
          CONFIG.rules[0]!,
          { ...CONFIG.rules[1]!, enabled: false },
        ].map(({ enforcement, ...rest }) => rest),
      }),
    )
  })

  it('adds a custom rule via the free-text input', async () => {
    const saveSpy = vi.spyOn(agentApi, 'saveBotConfig').mockResolvedValue(CONFIG)
    renderTab()

    fireEvent.change(screen.getByPlaceholderText('Add a custom rule…'), { target: { value: 'No emoji.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(saveSpy).toHaveBeenCalled())
    const call = saveSpy.mock.calls[0]![1] as { rules: { text: string; source: string }[] }
    expect(call.rules.at(-1)).toMatchObject({ text: 'No emoji.', source: 'custom', enabled: true })
  })
})
