import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlayerMessagesResponse } from '@support/types'
import { SupportChat } from './SupportChat.tsx'
import { SupportContextProvider, type SupportContextValue } from '@/surfaces/webview/components/SupportContext.tsx'
import { makeBootstrapResponse } from '@/surfaces/webview/test-support/fixtures.ts'
import { fetchPlayerMessages, markPlayerMessagesRead } from '@/features/chat/api/playerChatApi'
import { createSocket } from '@/features/chat/api/socket'

vi.mock('@/features/chat/api/playerChatApi')
vi.mock('@/features/chat/api/socket')

const contextValue: SupportContextValue = {
  boot: { token: 't', sessionId: 's', entryPoint: 'test' },
  data: makeBootstrapResponse(),
  error: null,
  retry: vi.fn(),
}

function renderChat() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/embed/support/chat']}>
        <SupportContextProvider value={contextValue}>
          <SupportChat />
        </SupportContextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function messages(overrides: Partial<PlayerMessagesResponse>): PlayerMessagesResponse {
  return {
    conversation_id: 'c1',
    messages: [
      {
        id: 'm1',
        seq: 1,
        author_type: 'player',
        body: 'my game crashed',
        created_at: '2026-08-13T10:00:00.000Z',
        delivery_state: 'read',
        read_at: '2026-08-13T10:00:01.000Z',
      },
    ],
    status: 'open',
    confirm_phase: 'none',
    ...overrides,
  } as PlayerMessagesResponse
}

beforeEach(() => {
  vi.mocked(markPlayerMessagesRead).mockResolvedValue({ ok: true })
  // Nothing in these tests drives realtime; the component only needs a socket
  // whose handlers can be registered and whose close() exists for cleanup.
  vi.mocked(createSocket).mockReturnValue({ on: vi.fn(), emit: vi.fn(), close: vi.fn() } as never)
})

describe('SupportChat composer gating', () => {
  it('leaves the composer usable while no banner is showing', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(messages({}))
    renderChat()
    // Both banners are absent once the query has settled, which is the state
    // this asserts the composer stays live in.
    await waitFor(() => expect(screen.queryByText('Is your issue resolved?')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Message')).not.toBeDisabled()
  })

  it('disables the composer while the confirm banner is asking', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(messages({ confirm_phase: 'agent_ask' }))
    renderChat()
    expect(await screen.findByText('Is your issue resolved?')).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeDisabled()
    expect(screen.getByLabelText('Send message')).toBeDisabled()
  })

  it('disables the composer while the resolved banner is showing', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(messages({ status: 'resolved' }))
    renderChat()
    expect(await screen.findByText('Your ticket is resolved.')).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeDisabled()
  })
})

describe('SupportChat banner focus', () => {
  it('dims the screen behind the banner and lifts the banner above the scrim', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(messages({ confirm_phase: 'agent_ask' }))
    const { container } = renderChat()

    const banner = await screen.findByRole('dialog')
    const scrim = container.querySelector('[aria-hidden="true"].fixed')
    expect(scrim).not.toBeNull()
    // The scrim covers everything at z-10; the banner has to outrank it or the
    // decision the player is being asked to make is behind the dimming.
    expect(scrim!.className).toContain('z-10')
    expect(banner.className).toContain('z-20')
  })

  it('shows no scrim while the thread is an ordinary open conversation', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(messages({}))
    const { container } = renderChat()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(container.querySelector('[aria-hidden="true"].fixed')).toBeNull()
  })
})

describe('SupportChat resolved banner', () => {
  it('offers both a reopen and a fresh ticket, not one Yes', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(messages({ status: 'resolved' }))
    renderChat()
    expect(await screen.findByText('Still facing issues')).toBeInTheDocument()
    expect(screen.getByText('Open a new ticket')).toBeInTheDocument()
    expect(screen.queryByText('Yes')).not.toBeInTheDocument()
  })
})
