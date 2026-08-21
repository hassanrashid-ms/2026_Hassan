import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConversationList } from './ConversationList.tsx'
import * as agentApi from '../../../api/agentApi.ts'

// Captures the handlers the component registers so a test can fire a socket
// event, rather than stubbing `on` into a black hole.
const socket = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  closed: 0,
}))

vi.mock('../../../../../features/chat/api/socket.ts', () => ({
  createSocket: () => ({
    on: (event: string, handler: (payload: unknown) => void) => {
      socket.handlers.set(event, handler)
    },
    emit: vi.fn(),
    close: () => {
      socket.closed += 1
    },
  }),
}))

function fireConversationChanged(payload: unknown) {
  const handler = socket.handlers.get('conversation:changed')
  if (!handler) throw new Error('component never subscribed to conversation:changed')
  act(() => handler(payload))
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

const UNASSIGNED_CONVERSATION = {
  id: 'conv-1',
  player: { external_player_id: 'player-42' },
  status: 'new' as const,
  confirm_phase: 'none' as const,
  last_message_preview: 'Help, my purchase failed',
  last_message_at: '2026-08-10T12:00:00Z',
  assigned_agent_id: null,
  assigned_agent_name: null,
  priority: 'p3' as const,
  tags: [],
}

beforeEach(() => {
  vi.restoreAllMocks()
  socket.handlers.clear()
  socket.closed = 0
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

describe('ConversationList reacts to conversation:changed without a blocking refetch', () => {
  const mine = { ...UNASSIGNED_CONVERSATION, id: 'conv-9', status: 'awaiting_player' as const }

  // Radix unmounts the inactive tab, so the row only exists in the DOM once Mine
  // is selected. Switching tabs does not refetch — both useQuery hooks live in
  // ConversationList itself, not inside TabsContent.
  async function renderMineTab() {
    const fetchSpy = vi.spyOn(agentApi, 'fetchInbox').mockImplementation((_token, status) =>
      Promise.resolve({ conversations: status === 'mine' ? [mine] : [] }),
    )
    renderWithClient(<ConversationList token="tok" selectedId={null} onSelect={() => {}} />)
    await userEvent.click(await screen.findByRole('tab', { name: /mine/i }))
    return fetchSpy
  }

  it('updates the status badge from the payload alone, with no immediate refetch', async () => {
    const fetchSpy = await renderMineTab()

    // Both tabs load once on mount.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    await screen.findByText('awaiting_player')

    fireConversationChanged({ conversation_id: 'conv-9', status: 'open' })

    // The badge is already correct — the payload carried the status, so nothing
    // waited on the network. This is the whole point of the change.
    await screen.findByText('open')
    expect(screen.queryByText('awaiting_player')).not.toBeInTheDocument()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('coalesces a burst of changes into a single trailing refetch', async () => {
    const fetchSpy = await renderMineTab()
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))

    fireConversationChanged({ conversation_id: 'conv-9', status: 'open' })
    fireConversationChanged({ conversation_id: 'conv-9', status: 'awaiting_player' })
    fireConversationChanged({ conversation_id: 'conv-9', status: 'open' })

    // Three messages, one catch-up round trip per tab — not three.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(4), { timeout: 3000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })

  it('refetches immediately for an id it has never seen, so a new conversation is not late', async () => {
    const fetchSpy = await renderMineTab()
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))

    fireConversationChanged({ conversation_id: 'brand-new-conv', status: 'open' })

    // No trailing timer for this case: {id, status} cannot render an absent row.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(4))
  })

  it('falls back to a refetch on a malformed payload instead of throwing', async () => {
    const fetchSpy = await renderMineTab()
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))

    expect(() => fireConversationChanged({ conversation_id: 42 })).not.toThrow()
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(4), { timeout: 3000 })
  })
})

describe('ConversationList form label', () => {
  it('labels a row whose player is still answering the form', async () => {
    vi.spyOn(agentApi, 'fetchInbox').mockImplementation((_token, status) =>
      Promise.resolve({
        conversations:
          status === 'unassigned'
            ? [{ ...UNASSIGNED_CONVERSATION, status: 'bot_active' as const, confirm_phase: 'form' as const }]
            : [],
      }),
    )

    renderWithClient(<ConversationList token="tok" selectedId={null} onSelect={() => {}} />)

    // Without this, an unassigned bot_active ticket with no agent and a
    // half-filled form reads as a stuck ticket.
    expect(await screen.findByText('Answering questions')).toBeInTheDocument()
  })

  it('does not label a row in any other phase', async () => {
    vi.spyOn(agentApi, 'fetchInbox').mockImplementation((_token, status) =>
      Promise.resolve({ conversations: status === 'unassigned' ? [UNASSIGNED_CONVERSATION] : [] }),
    )

    renderWithClient(<ConversationList token="tok" selectedId={null} onSelect={() => {}} />)

    await screen.findByText('player-42')
    expect(screen.queryByText('Answering questions')).not.toBeInTheDocument()
  })
})
