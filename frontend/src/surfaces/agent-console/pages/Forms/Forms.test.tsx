import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Forms } from './Forms.tsx'
import { loadAgentSession } from '../../lib/agentSession.ts'
import * as agentApi from '../../api/agentApi.ts'

vi.mock('../../lib/agentSession.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/agentSession.ts')>('../../lib/agentSession.ts')
  return { ...actual, loadAgentSession: vi.fn() }
})

beforeEach(() => {
  vi.mocked(loadAgentSession).mockReturnValue({ token: 't', agentId: 'a1', displayName: 'A', workspaceSlug: 'ws' })
  vi.spyOn(agentApi, 'fetchForms').mockResolvedValue({
    forms: [
      {
        id: 'form-1',
        name: 'Refund request',
        archivedAt: null,
        createdAt: '2026-01-01T00:00:00Z',
        mappedSubintentCount: 0,
        publishedVersion: null,
        hasDraft: true,
      },
    ],
  })
  vi.spyOn(agentApi, 'fetchForm').mockResolvedValue({
    id: 'form-1',
    name: 'Refund request',
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    draft: { version: 1, fields: [], publishedAt: null },
    published: null,
    subintents: [],
  })
  vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] })
})

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/forms" element={<Forms />} />
          <Route path="/forms/:id" element={<Forms />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Forms route-driven selection', () => {
  it('opens the sheet on the form named by the route', async () => {
    renderAt('/forms/form-1')

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  })

  it('leaves the sheet closed on the plain list route', async () => {
    renderAt('/forms')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
