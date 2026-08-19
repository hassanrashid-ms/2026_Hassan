import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Taxonomy } from './Taxonomy.tsx'
import * as agentApi from '../../api/agentApi.ts'
import * as agentSession from '../../lib/agentSession.ts'

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('Taxonomy', () => {
  it('renders the intent tree from GET /agent/intents', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a1',
      displayName: 'A',
      workspaceSlug: 'ws',
      role: 'admin',
    })
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({
      intents: [
        {
          id: 'i1',
          name: 'Billing',
          isSystem: false,
          archivedAt: null,
          subintents: [
            { id: 's1', name: 'Refunds', formId: null, archivedAt: null, defaultPriority: null, mergedIntoId: null },
          ],
        },
      ],
    })

    renderWithClient(<Taxonomy />)

    expect(await screen.findByText('Billing')).toBeInTheDocument()
    expect(await screen.findByText('Refunds')).toBeInTheDocument()
    expect(screen.getByText('+ Add intent')).toBeInTheDocument()
  })

  it('hides "+ Add intent" for a non-admin', async () => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't',
      agentId: 'a1',
      displayName: 'A',
      workspaceSlug: 'ws',
      role: 'agent',
    })
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] })

    renderWithClient(<Taxonomy />)

    await screen.findByText('Taxonomy')
    expect(screen.queryByText('+ Add intent')).not.toBeInTheDocument()
  })
})
