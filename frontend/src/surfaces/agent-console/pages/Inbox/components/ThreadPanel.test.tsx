import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentMessageView } from '@support/types'
import { ThreadPanel } from './ThreadPanel.tsx'
import { fetchConversationMessages, markAgentMessagesRead, sendAgentMessage } from '../../../api/agentApi.ts'
import { createSocket } from '../../../../../features/chat/api/socket.ts'

vi.mock('../../../api/agentApi.ts')
vi.mock('../../../../../features/chat/api/socket.ts')

// Same stubs ChatThread.test.tsx needs: jsdom lays out nothing, so without them
// Virtuoso measures a zero-height viewport and mounts no items at all.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 600 })
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => document.body })
  Element.prototype.getBoundingClientRect = () =>
    ({ width: 600, height: 600, top: 0, left: 0, right: 600, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect
  globalThis.ResizeObserver = class {
    callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }
    observe(target: Element) {
      this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

function agentMessage(overrides: Partial<AgentMessageView> = {}): AgentMessageView {
  return {
    id: 'm1',
    seq: 1,
    author_type: 'agent',
    author_agent_id: 'a1',
    body: 'HEY!',
    visibility: 'public',
    delivery_state: 'sent',
    read_at: null,
    created_at: '2026-08-13T11:58:48.140Z',
    ...overrides,
  } as AgentMessageView
}

/** Captures the handlers ThreadPanel registers so a test can fire a server event. */
function fakeSocket() {
  const handlers: Record<string, (payload?: unknown) => void> = {}
  const socket = {
    on: (event: string, handler: (payload?: unknown) => void) => {
      handlers[event] = handler
    },
    emit: vi.fn(),
    close: vi.fn(),
  }
  vi.mocked(createSocket).mockReturnValue(socket as never)
  return handlers
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ThreadPanel token="t" conversationId="c1" playerExternalId="p-1" status="open" confirmPhase="none" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.mocked(markAgentMessagesRead).mockResolvedValue({ ok: true } as never)
})

describe('ThreadPanel room membership', () => {
  it('joins the conversation room on every connect, not once at setup', async () => {
    const handlers = fakeSocket()
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never)

    renderPanel()
    await screen.findByText('Sent')
    const socket = vi.mocked(createSocket).mock.results[0]!.value as { emit: ReturnType<typeof vi.fn> }

    handlers['connect']?.()
    expect(socket.emit).toHaveBeenCalledWith('join_conversation', { conversation_id: 'c1' })

    // A reconnect gets its own socket instance server-side, which has joined
    // nothing — so the client has to ask again or the panel goes silent.
    socket.emit.mockClear()
    handlers['connect']?.()
    expect(socket.emit).toHaveBeenCalledWith('join_conversation', { conversation_id: 'c1' })
  })
})

describe('ThreadPanel optimistic sends', () => {
  it('shows the message as Sending… immediately, before the server answers', async () => {
    fakeSocket()
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [] } as never)
    // Never settles: this is the whole window the agent used to stare at nothing.
    vi.mocked(sendAgentMessage).mockReturnValue(new Promise(() => {}) as never)

    renderPanel()
    await screen.findByLabelText('Message')

    await userEvent.type(screen.getByLabelText('Message'), 'on my way')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText('on my way')).toBeInTheDocument()
    expect(screen.getByText('Sending…')).toBeInTheDocument()
  })

  // The repeated-text case (sending "hi" into a thread that already contains
  // "hi") can't be asserted at this level: the jsdom stubs give every bubble the
  // full 600px viewport height, so Virtuoso mounts exactly one item and a second
  // bubble is never in the DOM to find. That rule is covered directly in
  // chatReconcile.test.ts instead.

  it('offers a retry when the send fails instead of losing what was typed', async () => {
    fakeSocket()
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [] } as never)
    vi.mocked(sendAgentMessage).mockRejectedValue(new Error('network'))

    renderPanel()
    await screen.findByLabelText('Message')

    await userEvent.type(screen.getByLabelText('Message'), 'still here?')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText('Failed to send.')).toBeInTheDocument()
    expect(screen.getByText('still here?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('drops the optimistic bubble once the refetched thread contains it', async () => {
    fakeSocket()
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [] } as never)
    vi.mocked(sendAgentMessage).mockImplementation(async () => {
      // What the server now returns for this send, from the next refetch on.
      vi.mocked(fetchConversationMessages).mockResolvedValue({
        messages: [agentMessage({ body: 'landed', delivery_state: 'sent' })],
      } as never)
      return { message: agentMessage({ body: 'landed' }) } as never
    })

    renderPanel()
    await screen.findByLabelText('Message')

    await userEvent.type(screen.getByLabelText('Message'), 'landed')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    // Exactly one bubble survives — the optimistic one must not linger beside
    // the real message.
    await waitFor(() => expect(screen.queryByText('Sending…')).not.toBeInTheDocument())
    expect(screen.getAllByText('landed')).toHaveLength(1)
  })
})

describe('ThreadPanel read receipts', () => {
  it("shows one tick until the player has read the agent's message", async () => {
    fakeSocket()
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never)

    renderPanel()
    expect(await screen.findByText('Sent')).toBeInTheDocument()
    expect(screen.queryByText('Seen')).not.toBeInTheDocument()
  })

  it('flips to two ticks when the player read receipt arrives over the socket', async () => {
    const handlers = fakeSocket()
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never)

    renderPanel()
    await screen.findByText('Sent')

    // What the server actually emits — verified end to end against a live
    // agent socket — and the refetch it is supposed to drive.
    vi.mocked(fetchConversationMessages).mockResolvedValue({
      messages: [agentMessage({ delivery_state: 'read', read_at: '2026-08-13T12:01:56.658Z' })],
    } as never)
    handlers['message:read']?.({ conversation_id: 'c1', up_to_seq: 1, reader_type: 'player' })

    expect(await screen.findByText('Seen')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Sent')).not.toBeInTheDocument())
  })
})
