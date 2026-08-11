import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { WebviewShell } from './WebviewShell.tsx'

vi.mock('@/surfaces/webview/api/surfaceApi', () => ({
  fetchBootstrap: vi.fn(),
}))

function setLocation(url: string) {
  window.history.pushState(null, '', url)
}

function renderShell() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route path="*" element={<WebviewShell />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('WebviewShell boot', () => {
  beforeEach(() => {
    delete (window as { SupportBridge?: unknown }).SupportBridge
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never shows the technical no-token message while a bridge might still show up', () => {
    setLocation('/embed/support')

    renderShell()

    expect(screen.queryByText(/no session token was supplied/i)).not.toBeInTheDocument()
  })

  it('only falls back to the technical message once no bridge shows up in time', () => {
    vi.useFakeTimers()
    setLocation('/embed/support')

    renderShell()
    act(() => vi.runAllTimers())

    expect(screen.getByText('Open support from the game')).toBeInTheDocument()
  })

  it('asks the SDK to close instead of erroring on a stale reload with a session but no token', async () => {
    setLocation('/embed/support?session=abc-123')
    const post = vi.fn()
    window.SupportBridge = { post }

    renderShell()

    await waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'close' }))
    expect(screen.queryByText('Open support from the game')).not.toBeInTheDocument()
  })

  it('asks the SDK to close on a cold open too, once the bridge shows up', async () => {
    setLocation('/embed/support')
    const post = vi.fn()
    window.SupportBridge = { post }

    renderShell()

    await waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'close' }))
    expect(screen.queryByText('Open support from the game')).not.toBeInTheDocument()
  })
})
