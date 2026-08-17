import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentConversationContextResponse, AgentPlayerStateView, AgentTicketSummary } from '@support/types'
import { ContextRail } from './ContextRail.tsx'
import { fetchConversationContext } from '../../../api/agentApi.ts'

vi.mock('../../../api/agentApi.ts')

function contextResponse(playerState: AgentPlayerStateView): AgentConversationContextResponse {
  return {
    player_state: playerState,
    tickets: [],
    summary: { total_tickets: 0, total_reopened: 0, first_contact_at: '2026-04-12T00:00:00Z' },
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
