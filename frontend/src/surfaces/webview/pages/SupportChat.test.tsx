import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlayerMessagesResponse } from '@support/types'
import { SupportChat } from './SupportChat.tsx'
import { SupportContextProvider, type SupportContextValue } from '@/surfaces/webview/components/SupportContext.tsx'
import { makeBootstrapResponse } from '@/surfaces/webview/test-support/fixtures.ts'
import {
  fetchPlayerMessages,
  markPlayerMessagesRead,
  postFormAnswer,
  skipForm,
  submitForm,
} from '@/features/chat/api/playerChatApi'
import { createSocket } from '@/features/chat/api/socket'

vi.mock('@/features/chat/api/playerChatApi')
vi.mock('@/features/chat/api/socket')

const contextValue: SupportContextValue = {
  boot: { token: 't', sessionId: 's', entryPoint: 'test' },
  data: makeBootstrapResponse(),
  error: null,
  retry: vi.fn(),
}

function renderChat(overrides: Partial<SupportContextValue> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/embed/support/chat']}>
          <SupportContextProvider value={{ ...contextValue, ...overrides }}>
            <SupportChat />
          </SupportContextProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  }
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
    form: null,
    ...overrides,
  } as PlayerMessagesResponse
}

beforeEach(() => {
  vi.mocked(markPlayerMessagesRead).mockResolvedValue({ ok: true })
  // Nothing in these tests drives realtime; the component only needs a socket
  // whose handlers can be registered and whose close() exists for cleanup.
  vi.mocked(createSocket).mockReturnValue({ on: vi.fn(), emit: vi.fn(), close: vi.fn() } as never)
  vi.mocked(postFormAnswer).mockResolvedValue({ ok: true, is_correction: false })
  vi.mocked(submitForm).mockResolvedValue({ confirm_phase: 'none', status: 'open', form_status: 'completed' })
  vi.mocked(skipForm).mockResolvedValue({ confirm_phase: 'none', status: 'open', form_status: 'skipped' })
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

/**
 * Chat used to be the fallback when the backend was unreachable — Home offered
 * "Talk to us anyway" on the reasoning that chat needs only the token. That
 * holds while bootstrap alone has failed, not when the API itself is down: the
 * thread cannot load and a send cannot be delivered, so the player was left
 * typing into a composer above an empty screen.
 */
describe('SupportChat when the backend is unreachable', () => {
  it('shows the same failure screen Home shows, with its message, instead of the thread', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(messages({}))
    renderChat({ error: 'Could not load support.' })

    expect(await screen.findByText('Could not load support')).toBeInTheDocument()
    expect(screen.getByText('Could not load support.')).toBeInTheDocument()
    expect(screen.getByText('Try again')).toBeInTheDocument()
  })

  it('disables the chat module — no composer, no thread, no empty-state invitation to talk', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(messages({}))
    renderChat({ error: 'Could not load support.' })

    await screen.findByText('Could not load support')
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
    expect(screen.queryByText('my game crashed')).not.toBeInTheDocument()
    expect(screen.queryByText('Say hello')).not.toBeInTheDocument()
  })

  it("falls into the same state when this screen's own fetch fails and nothing has loaded", async () => {
    vi.mocked(fetchPlayerMessages).mockRejectedValue(new Error('Failed to fetch'))
    renderChat()

    expect(await screen.findByText('Could not load support')).toBeInTheDocument()
    expect(screen.getByText('Failed to fetch')).toBeInTheDocument()
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
  })

  it('retrying asks the shell to re-arm as well as refetching, since either half may be the failed one', async () => {
    const retry = vi.fn()
    vi.mocked(fetchPlayerMessages).mockResolvedValue(messages({}))
    renderChat({ error: 'Could not load support.', retry })

    fireEvent.click(await screen.findByText('Try again'))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  /**
   * The guard is `data === undefined`, not bare `isError`: losing a thread the
   * player is mid-way through reading, to report an outage that a failed send
   * already reports as "Not sent. Retry", trades real content for a duplicate
   * message.
   */
  it('keeps a thread that already loaded when a later refetch fails', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(messages({}))
    const { queryClient } = renderChat()
    // The composer standing in for "the thread is up": ChatBubbles renders
    // through Virtuoso, which measures zero under jsdom and mounts no items, so
    // message text is not assertable here.
    await waitFor(() => expect(screen.getByLabelText('Message')).not.toBeDisabled())

    vi.mocked(fetchPlayerMessages).mockRejectedValue(new Error('Failed to fetch'))
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['playerMessages', 's'] })
    })

    expect(screen.queryByText('Could not load support')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeInTheDocument()
  })
})

const FORM = {
  submission_id: 's1',
  form_id: 'f1',
  form_name: 'Purchase receipt',
  version: 1,
  fields: [
    {
      key: 'store',
      label: 'Store',
      type: 'choice',
      isRequired: true,
      position: 0,
      options: ['Apple App Store', 'Google Play'],
    },
    { key: 'order_id', label: 'Order or receipt ID', type: 'short_text', isRequired: true, position: 1 },
  ],
  answers: [],
} as unknown as NonNullable<PlayerMessagesResponse['form']>

describe('the form card', () => {
  it('does not render the resolution banner while confirm_phase is form', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(
      messages({ status: 'bot_active', confirm_phase: 'form', form: FORM }),
    )
    renderChat()
    expect(await screen.findByText('Store')).toBeInTheDocument()
    // The old `!== 'none'` check made a third enum value silently render the
    // yes/no banner underneath the card.
    expect(screen.queryByText('Is your issue resolved?')).not.toBeInTheDocument()
  })

  it('disables the composer while the card is showing', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(
      messages({ status: 'bot_active', confirm_phase: 'form', form: FORM }),
    )
    renderChat()
    await screen.findByText('Store')
    expect(screen.getByLabelText('Message')).toBeDisabled()
  })

  it('resumes mid-form at the right question with earlier answers present', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(
      messages({
        status: 'bot_active',
        confirm_phase: 'form',
        form: { ...FORM, answers: [{ field_key: 'store', value: 'Google Play' }] },
      }),
    )
    renderChat()
    expect(await screen.findByText('2 of 2')).toBeInTheDocument()
    expect(screen.getByText('Order or receipt ID')).toBeInTheDocument()
  })

  it('still renders the resolution banner on bot_article', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(
      messages({ status: 'bot_active', confirm_phase: 'bot_article', form: null }),
    )
    renderChat()
    expect(await screen.findByText('Is your issue resolved?')).toBeInTheDocument()
  })

  it('renders no card when confirm_phase is form but the form block is null', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(
      messages({ status: 'bot_active', confirm_phase: 'form', form: null }),
    )
    renderChat()
    await waitFor(() => expect(screen.getByLabelText('Message')).not.toBeDisabled())
  })
})
