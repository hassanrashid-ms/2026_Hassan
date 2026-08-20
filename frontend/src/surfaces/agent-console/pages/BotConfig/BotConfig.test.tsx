import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { BotConfig } from './BotConfig.tsx'
import * as agentApi from '../../api/agentApi.ts'
import * as agentSession from '../../lib/agentSession.ts'

function renderWithQuery() {
  const queryClient = new QueryClient()
  return render(
    <QueryClientProvider client={queryClient}>
      <BotConfig />
    </QueryClientProvider>,
  )
}

describe('BotConfig page', () => {
  beforeEach(() => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't', agentId: 'a', displayName: 'Admin', workspaceSlug: 'ws', role: 'admin',
    })
  })

  it('renders three tabs: Prompt, Rules, Tools', async () => {
    vi.spyOn(agentApi, 'fetchBotConfig').mockResolvedValue({
      is_provisioned: true,
      prompt: 'P',
      rules: [],
      tools_config: [],
      enabled_tools: [],
      system_prompt: 'P',
      is_prompt_customized: false,
      is_rules_customized: false,
      is_tools_customized: false,
      limits_config: [],
      resolved_limits: { max_bot_messages: 8, max_tool_calls_per_turn: 6, max_articles_per_turn: 3, max_unhelped_replies: 3 },
      is_limits_customized: false,
      updated_at: null,
    })

    renderWithQuery()

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Prompt' })).toBeInTheDocument())
    expect(screen.getByRole('tab', { name: 'Rules' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Tools' })).toBeInTheDocument()
  })
})
