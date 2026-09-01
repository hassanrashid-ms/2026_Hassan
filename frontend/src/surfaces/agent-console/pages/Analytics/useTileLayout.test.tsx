import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useTileLayout } from './useTileLayout.ts'
import { loadAgentSession } from '../../lib/agentSession.ts'
import * as analyticsApi from '../../api/analyticsApi.ts'

vi.mock('../../lib/agentSession.ts')
vi.mock('../../api/analyticsApi.ts')

beforeEach(() => {
  vi.mocked(loadAgentSession).mockReturnValue({ token: 't' } as never)
  vi.mocked(analyticsApi.fetchLayout).mockResolvedValue({
    layout: { items: [{ i: 'a', x: 0, y: 0, w: 1, h: 1 }], visibleTileIds: ['a'] },
  })
  vi.mocked(analyticsApi.saveLayout).mockResolvedValue({ ok: true })
})

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useTileLayout', () => {
  it('loads the saved layout', async () => {
    const { result } = renderHook(() => useTileLayout(), { wrapper })

    await waitFor(() => expect(result.current.layout?.items).toHaveLength(1))
  })

  it('calls saveLayout when updateLayout is invoked', async () => {
    const { result } = renderHook(() => useTileLayout(), { wrapper })
    await waitFor(() => expect(result.current.layout).not.toBeNull())

    const newLayout = { items: [{ i: 'a', x: 1, y: 0, w: 1, h: 1 }], visibleTileIds: ['a'] }
    act(() => result.current.updateLayout(newLayout))

    await waitFor(() => expect(analyticsApi.saveLayout).toHaveBeenCalledWith('t', newLayout), { timeout: 1000 })
  })
})
