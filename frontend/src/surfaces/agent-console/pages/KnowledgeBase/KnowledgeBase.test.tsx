import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { KnowledgeBase } from './KnowledgeBase.tsx'
import { loadAgentSession } from '../../lib/agentSession.ts'

vi.mock('../../lib/agentSession.ts')

beforeEach(() => {
  vi.mocked(loadAgentSession).mockReturnValue({ token: 't' } as never)
})

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/articles" element={<KnowledgeBase />} />
          <Route path="/articles/:id" element={<KnowledgeBase />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('KnowledgeBase route-driven selection', () => {
  it('opens the sheet on the article named by the route', async () => {
    renderAt('/articles/art-1')

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  })

  it('leaves the sheet closed on the plain list route', async () => {
    renderAt('/articles')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
