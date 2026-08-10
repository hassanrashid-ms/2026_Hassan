import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConversationList } from './ConversationList.tsx'
import * as agentApi from '../../../api/agentApi.ts'

vi.mock('../../../../../features/chat/api/socket.ts', () => ({
  createSocket: () => ({ on: vi.fn(), close: vi.fn() }),
}))

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

const UNASSIGNED_CONVERSATION = {
  id: 'conv-1',
  player: { external_player_id: 'player-42' },
  status: 'new' as const,
  last_message_preview: 'Help, my purchase failed',
  last_message_at: '2026-08-10T12:00:00Z',
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('ConversationList claim flow', () => {
  it('claims an unassigned conversation and refreshes the list', async () => {
    vi.spyOn(agentApi, 'fetchInbox').mockImplementation((_token, status) =>
      Promise.resolve({ conversations: status === 'unassigned' ? [UNASSIGNED_CONVERSATION] : [] }),
    )
    const claimSpy = vi.spyOn(agentApi, 'claimConversation').mockResolvedValue({ claimed: true })

    renderWithClient(<ConversationList token="tok" selectedId={null} onSelect={() => {}} />)

    const claimButton = await screen.findByRole('button', { name: /claim/i })
    await userEvent.click(claimButton)

    await waitFor(() => expect(claimSpy).toHaveBeenCalledWith('tok', 'conv-1'))
  })

  it('shows a notice when the conversation was already claimed by someone else', async () => {
    vi.spyOn(agentApi, 'fetchInbox').mockImplementation((_token, status) =>
      Promise.resolve({ conversations: status === 'unassigned' ? [UNASSIGNED_CONVERSATION] : [] }),
    )
    vi.spyOn(agentApi, 'claimConversation').mockResolvedValue({ claimed: false })

    renderWithClient(<ConversationList token="tok" selectedId={null} onSelect={() => {}} />)

    const claimButton = await screen.findByRole('button', { name: /claim/i })
    await userEvent.click(claimButton)

    expect(await screen.findByText(/already claimed/i)).toBeInTheDocument()
  })
})
