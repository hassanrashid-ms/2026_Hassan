import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type {
  AgentConversationContextResponse,
  AgentFormView,
  AgentPlayerStateView,
  AgentTicketSummary,
} from '@support/types'
import { ContextRail } from './ContextRail.tsx'
import { fetchConversationContext } from '../../../api/agentApi.ts'

vi.mock('../../../api/agentApi.ts')

// Captures the handlers the rail registers so a test can fire a socket event,
// rather than stubbing `on` into a black hole.
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

function contextResponse(playerState: AgentPlayerStateView): AgentConversationContextResponse {
  return {
    player_state: playerState,
    tickets: [],
    summary: { total_tickets: 0, total_reopened: 0, first_contact_at: '2026-04-12T00:00:00Z' },
    form: null,
    tags: [],
  }
}

const CAPTURED: AgentPlayerStateView = {
  status: 'captured',
  declared: [{ key: 'platform', label: 'Platform', type: 'string', value: 'iOS' }],
  raw: { extra: 1 },
  degraded_reason: null,
  captured_at: '2026-08-17T00:00:00Z',
}

function renderRail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ContextRail token="t" conversationId="c1" open onOpenChange={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  socket.handlers.clear()
  socket.closed = 0
})

describe('ContextRail player state', () => {
  it('explains a ticket with no session attached', async () => {
    vi.mocked(fetchConversationContext).mockResolvedValue(contextResponse({ status: 'no_session' }))
    renderRail()
    expect(await screen.findByText('No session was attached to this ticket')).toBeInTheDocument()
  })

  it('explains a session that captured nothing', async () => {
    vi.mocked(fetchConversationContext).mockResolvedValue(contextResponse({ status: 'not_captured' }))
    renderRail()
    expect(await screen.findByText('No player state was captured')).toBeInTheDocument()
  })

  it('explains a game that returned no data', async () => {
    vi.mocked(fetchConversationContext).mockResolvedValue(contextResponse({ status: 'missing' }))
    renderRail()
    expect(await screen.findByText('The game returned no player data')).toBeInTheDocument()
  })

  it('renders declared fields when captured', async () => {
    vi.mocked(fetchConversationContext).mockResolvedValue(contextResponse(CAPTURED))
    renderRail()
    expect(await screen.findByText('Platform')).toBeInTheDocument()
    expect(screen.getByText('iOS')).toBeInTheDocument()
    expect(screen.getByText('Everything else the game sent')).toBeInTheDocument()
  })
})

describe('ContextRail raw section', () => {
  it('omits it entirely when raw is empty', async () => {
    vi.mocked(fetchConversationContext).mockResolvedValue(contextResponse({ ...CAPTURED, raw: {} }))
    renderRail()
    await screen.findByText('Platform')
    expect(screen.queryByText('Everything else the game sent')).not.toBeInTheDocument()
  })
})

function ticket(id: string, number: number, createdAt: string): AgentTicketSummary {
  return {
    id,
    number,
    created_at: createdAt,
    status: 'closed',
    subintent: null,
    resolution_source: 'agent',
    resolved_by_agent_name: 'Agent One',
    reopen_count: 0,
  }
}

describe('ContextRail ticket list', () => {
  it('keeps the current ticket in the list and marks it as current', async () => {
    vi.mocked(fetchConversationContext).mockResolvedValue({
      ...contextResponse({ status: 'no_session' }),
      tickets: [ticket('c1', 7, '2026-06-01T00:00:00Z'), ticket('c0', 6, '2026-05-01T00:00:00Z')],
      summary: { total_tickets: 1, total_reopened: 0, first_contact_at: '2026-04-12T00:00:00Z' },
    })
    renderRail()

    const current = await screen.findByRole('button', { name: /#7/ })
    expect(current).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: /#6/ })).not.toHaveAttribute('aria-current')
    expect(screen.getByText('1 earlier ticket · first contact 12 Apr 2026')).toBeInTheDocument()
  })

  it('reads as a first contact when there are no earlier tickets', async () => {
    vi.mocked(fetchConversationContext).mockResolvedValue({
      ...contextResponse({ status: 'no_session' }),
      tickets: [ticket('c1', 1, '2026-04-12T00:00:00Z')],
    })
    renderRail()

    expect(await screen.findByText('First contact 12 Apr 2026')).toBeInTheDocument()
    expect(screen.queryByText(/earlier ticket/)).not.toBeInTheDocument()
  })
})

function formView(overrides: Partial<AgentFormView> = {}): AgentFormView {
  return {
    form_name: 'Purchase receipt',
    form_version: 1,
    status: 'completed',
    field_count: 2,
    answered_count: 2,
    fields: [
      { key: 'store', label: 'Store', position: 0, field_type: 'choice', value: 'Google Play', answered: true },
      {
        key: 'purchase_date',
        label: 'Date of purchase',
        position: 1,
        field_type: 'date',
        value: '2026-08-16',
        answered: true,
      },
    ],
    ...overrides,
  }
}

function railWithForm(form: AgentFormView | null) {
  vi.mocked(fetchConversationContext).mockResolvedValue({
    ...contextResponse({ status: 'no_session' }),
    form,
  })
  return renderRail()
}

describe('ContextRail form section', () => {
  // State 1 of five, and the one that renders nothing. Same precedent as `raw`
  // being `{}`: an empty panel explaining an absence is worse than no panel.
  it('omits the section entirely when there is no form', async () => {
    railWithForm(null)
    await screen.findByText('No session was attached to this ticket')
    expect(screen.queryByText('Form')).not.toBeInTheDocument()
    expect(screen.queryByText(/Purchase receipt/)).not.toBeInTheDocument()
  })

  it('names the form and the version the player was actually asked', async () => {
    railWithForm(formView())
    expect(await screen.findByText('Purchase receipt · v1')).toBeInTheDocument()
  })

  it('renders every field of a completed form, labelled, in position order', async () => {
    railWithForm(formView())
    expect(await screen.findByText('All 2 questions answered')).toBeInTheDocument()
    const labels = screen.getAllByRole('term').map((el) => el.textContent)
    expect(labels).toEqual(['Store', 'Date of purchase'])
    expect(screen.getByText('Google Play')).toBeInTheDocument()
    expect(screen.getByText('16 Aug 2026')).toBeInTheDocument()
  })

  it('counts progress while the form is still being answered', async () => {
    railWithForm(
      formView({
        status: 'in_progress',
        field_count: 2,
        answered_count: 1,
        fields: [
          formView().fields[0]!,
          {
            key: 'purchase_date',
            label: 'Date of purchase',
            position: 1,
            field_type: 'date',
            value: null,
            answered: false,
          },
        ],
      }),
    )
    expect(await screen.findByText('Player is answering · 1 of 2')).toBeInTheDocument()
  })

  // The assertion that carries the product requirement. A gap is a visible row.
  it('renders a partial form gaps and all, rather than dropping the blanks', async () => {
    railWithForm(
      formView({
        status: 'partial',
        answered_count: 1,
        fields: [
          formView().fields[0]!,
          {
            key: 'purchase_date',
            label: 'Date of purchase',
            position: 1,
            field_type: 'date',
            value: null,
            answered: false,
          },
        ],
      }),
    )
    expect(await screen.findByText('1 answered · 1 not answered')).toBeInTheDocument()
    expect(screen.getByText('Date of purchase')).toBeInTheDocument()
    expect(screen.getByText('Not answered')).toBeInTheDocument()
  })

  // A skipped form must be a visible row, never a missing section: the agent has
  // to be able to tell "declined" from "never offered".
  it('says the player skipped, and does not list four empty rows', async () => {
    railWithForm(
      formView({
        status: 'skipped',
        answered_count: 0,
        fields: formView().fields.map((f) => ({ ...f, value: null, answered: false })),
      }),
    )
    expect(await screen.findByText('Player skipped the questions')).toBeInTheDocument()
    expect(screen.getByText('Purchase receipt · v1')).toBeInTheDocument()
    expect(screen.queryByText('Not answered')).not.toBeInTheDocument()
  })

  // Values render off the answer's own snapshotted field_type. A field retyped
  // in a later version does not change how an older answer reads.
  it('renders a value by its snapshotted field_type', async () => {
    railWithForm(
      formView({
        field_count: 1,
        answered_count: 1,
        fields: [
          {
            key: 'purchase_date',
            label: 'Date of purchase',
            position: 0,
            field_type: 'short_text',
            value: '2026-08-16',
            answered: true,
          },
        ],
      }),
    )
    expect(await screen.findByText('2026-08-16')).toBeInTheDocument()
    expect(screen.queryByText('16 Aug 2026')).not.toBeInTheDocument()
  })

  // Read-only in every state. Nothing here edits, re-offers, or submits.
  it('offers no controls', async () => {
    railWithForm(formView())
    await screen.findByText('Purchase receipt · v1')
    const section = screen.getByRole('region', { name: 'Form' })
    expect(within(section).queryAllByRole('button')).toHaveLength(0)
    expect(within(section).queryAllByRole('textbox')).toHaveLength(0)
  })

  // The rail is one query, so a malformed form block must not take the other two
  // sections down with it.
  it('renders the other sections when the form block is absent from the payload', async () => {
    const { form: _omitted, ...withoutForm } = { ...contextResponse({ status: 'not_captured' }), form: null }
    vi.mocked(fetchConversationContext).mockResolvedValue(
      withoutForm as unknown as AgentConversationContextResponse,
    )
    renderRail()
    expect(await screen.findByText('No player state was captured')).toBeInTheDocument()
    expect(screen.getByText('Tickets')).toBeInTheDocument()
  })
})

describe('ContextRail invalidation', () => {
  it('refetches the context when the conversation phase changes', async () => {
    vi.mocked(fetchConversationContext).mockResolvedValue({
      ...contextResponse({ status: 'no_session' }),
      form: formView({ status: 'in_progress', answered_count: 1 }),
    })
    renderRail()
    await screen.findByText('Purchase receipt · v1')
    expect(fetchConversationContext).toHaveBeenCalledTimes(1)

    const handler = socket.handlers.get('conversation:phase_changed')
    if (!handler) throw new Error('the rail never subscribed to conversation:phase_changed')
    act(() => handler({ conversation_id: 'c1', confirm_phase: 'none' }))

    // A form in progress is the one mutable thing in the panel, and this is the
    // only event that moves it.
    await waitFor(() => expect(fetchConversationContext).toHaveBeenCalledTimes(2))
  })

  it('ignores unrelated socket traffic', async () => {
    vi.mocked(fetchConversationContext).mockResolvedValue(contextResponse({ status: 'no_session' }))
    renderRail()
    await screen.findByText('No session was attached to this ticket')
    expect(fetchConversationContext).toHaveBeenCalledTimes(1)

    // The rail subscribes to exactly one event. Player state is immutable by
    // construction and ticket history moves on the order of days; refetching
    // the whole rail on every inbound message would undo the long staleTime.
    expect(socket.handlers.has('message:new')).toBe(false)
    expect(socket.handlers.has('message:read')).toBe(false)
    expect(socket.handlers.has('conversation:changed')).toBe(false)
  })

  it('closes the socket on unmount', async () => {
    vi.mocked(fetchConversationContext).mockResolvedValue(contextResponse({ status: 'no_session' }))
    const { unmount } = renderRail()
    await screen.findByText('No session was attached to this ticket')
    unmount()
    expect(socket.closed).toBe(1)
  })
})
