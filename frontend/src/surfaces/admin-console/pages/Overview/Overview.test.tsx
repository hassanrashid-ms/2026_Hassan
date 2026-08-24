import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Overview } from './Overview.tsx'
import * as adminApi from '../../api/adminApi.ts'
import * as adminSession from '../../lib/adminSession.ts'

function renderWithProviders() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Overview />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Overview "Open console" action', () => {
  beforeEach(() => {
    vi.spyOn(adminSession, 'loadAdminSession').mockReturnValue({
      token: 'admin-token',
      agentId: 'admin-1',
      displayName: 'Ada Admin',
      isSuperAdmin: true,
    })
    vi.spyOn(adminApi, 'fetchWorkspaces').mockResolvedValue({
      workspaces: [
        { id: 'ws-1', name: 'Acme Games', slug: 'acme', member_count: 3, created_at: '2026-01-01T00:00:00Z' },
      ],
    })
    vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens /inbox in a new tab with the admin token in the fragment and workspace/agent context in the query string', async () => {
    renderWithProviders()

    const openButton = await screen.findByRole('button', { name: 'Open console' })
    await userEvent.click(openButton)

    expect(window.open).toHaveBeenCalledTimes(1)
    const [url, target, features] = vi.mocked(window.open).mock.calls[0]!
    expect(target).toBe('_blank')
    expect(features).toBe('noopener')

    const parsed = new URL(String(url), 'http://localhost')
    expect(parsed.pathname).toBe('/inbox')
    expect(parsed.searchParams.get('workspace')).toBe('ws-1')
    expect(parsed.searchParams.get('agentId')).toBe('admin-1')
    expect(parsed.searchParams.get('name')).toBe('Ada Admin')
    // The token must be in the fragment, never the query string.
    expect(parsed.search).not.toContain('admin-token')
    expect(parsed.hash).toBe('#t=admin-token')
  })

  it('does not navigate the current tab away from the admin console', async () => {
    renderWithProviders()

    const openButton = await screen.findByRole('button', { name: 'Open console' })
    await userEvent.click(openButton)

    // Clicking "Open console" must not trigger the card's own onClick
    // (navigate to the workspace detail page) in the same tab.
    expect(screen.getByText('Acme Games')).toBeInTheDocument()
  })
})
