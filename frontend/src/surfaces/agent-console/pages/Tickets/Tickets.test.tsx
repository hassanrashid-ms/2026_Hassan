import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Tickets } from './Tickets.tsx'
import { loadAgentSession } from '../../lib/agentSession.ts'
import * as agentApi from '../../api/agentApi.ts'

vi.mock('../../lib/agentSession.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/agentSession.ts')>('../../lib/agentSession.ts')
  return { ...actual, loadAgentSession: vi.fn() }
})
vi.mock('../../../../features/chat/api/socket.ts', () => ({
  createSocket: () => ({ on: vi.fn(), close: vi.fn() }),
}))
vi.mock('../../api/agentApi.ts')

function renderTickets(path = '/tickets') {
  vi.mocked(loadAgentSession).mockReturnValue({ token: 'tok', agentId: 'agent-1', workspaceId: 'ws-1' } as never)
  vi.mocked(agentApi.fetchTags).mockResolvedValue([])
  vi.mocked(agentApi.fetchIntents).mockResolvedValue({ intents: [] })
  vi.mocked(agentApi.fetchWorkspaceAgents).mockResolvedValue({ agents: [] })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tickets" element={<Tickets />} />
          <Route path="/tickets/:conversationId" element={<Tickets />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('Tickets filtering', () => {
  it('passes the active filters through to fetchInbox for every column', async () => {
    const fetchInboxSpy = vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [] })
    renderTickets('/tickets?priority=p1')

    await waitFor(() =>
      expect(fetchInboxSpy).toHaveBeenCalledWith('tok', 'unassigned', expect.objectContaining({ priority: ['p1'] })),
    )
    expect(fetchInboxSpy).toHaveBeenCalledWith('tok', 'botHandling', expect.objectContaining({ priority: ['p1'] }))
    expect(fetchInboxSpy).toHaveBeenCalledWith('tok', 'agentAssigned', expect.objectContaining({ priority: ['p1'] }))
    expect(fetchInboxSpy).toHaveBeenCalledWith('tok', 'escalated', expect.objectContaining({ priority: ['p1'] }))
  })

  it('shows a filtered-empty message distinct from a genuinely empty column', async () => {
    vi.mocked(agentApi.fetchInbox).mockImplementation((_token, status) =>
      Promise.resolve({ conversations: status === 'unassigned' ? [] : [] }),
    )
    renderTickets('/tickets?priority=p1')

    await screen.findAllByText('No tickets match your filters.')
  })

  it('shows the default empty state with no filters active', async () => {
    vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [] })
    renderTickets('/tickets')

    await waitFor(() => expect(agentApi.fetchInbox).toHaveBeenCalled())
    expect(screen.queryByText('No tickets match your filters.')).not.toBeInTheDocument()
  })
})
