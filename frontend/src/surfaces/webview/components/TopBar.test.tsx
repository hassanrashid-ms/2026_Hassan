import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TopBar } from './TopBar.tsx'
import { SupportContextProvider, type SupportContextValue } from './SupportContext.tsx'
import { makeBootstrapResponse } from '@/surfaces/webview/test-support/fixtures.ts'

function renderTopBar(value: SupportContextValue) {
  return render(
    <MemoryRouter>
      <SupportContextProvider value={value}>
      </SupportContextProvider>
    </MemoryRouter>,
  )
}

describe('TopBar', () => {
  it('shows the fallback name before bootstrap lands', () => {
    renderTopBar({ boot: null, data: null, error: null, retry: vi.fn() })

    expect(screen.getByText('Game Support')).toBeInTheDocument()
  })

  it('shows the real workspace name once bootstrap data arrives', () => {
    const data = makeBootstrapResponse({ workspace: { name: 'Neon Drift' } })
    renderTopBar({ boot: null, data, error: null, retry: vi.fn() })

    expect(screen.getByText('Neon Drift')).toBeInTheDocument()
    expect(screen.queryByText('Game Support')).not.toBeInTheDocument()
  })
})
