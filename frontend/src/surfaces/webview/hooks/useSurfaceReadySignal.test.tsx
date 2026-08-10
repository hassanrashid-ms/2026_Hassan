import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useSurfaceReadySignal } from './useSurfaceReadySignal.ts'

function Probe({ resolved }: { resolved: boolean }) {
  useSurfaceReadySignal(resolved)
  return null
}

/** Stands in for the bridge the SDK injects, recording what the page posts. */
function installBridge(): unknown[] {
  const posted: unknown[] = []
  ;(window as { SupportBridge?: unknown }).SupportBridge = {
    post: (message: unknown) => posted.push(message),
  }
  return posted
}

describe('useSurfaceReadySignal', () => {
  beforeEach(() => {
    delete (window as { SupportBridge?: unknown }).SupportBridge
  })

  it('posts surface_ready once the surface has something to show', async () => {
    const posted = installBridge()

    render(<Probe resolved />)

    await waitFor(() => expect(posted).toEqual([{ type: 'surface_ready' }]))
  })

  it('stays silent while the surface is still an empty frame', async () => {
    const posted = installBridge()

    render(<Probe resolved={false} />)

    // Long enough for both animation frames to have run had they been scheduled.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(posted).toEqual([])
  })

  it('posts exactly once when the surface resolves, then re-renders', async () => {
    const posted = installBridge()

    const { rerender } = render(<Probe resolved />)
    await waitFor(() => expect(posted).toHaveLength(1))

    rerender(<Probe resolved />)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(posted).toEqual([{ type: 'surface_ready' }])
  })

  it('waits for a bridge that has not been injected yet', async () => {
    // The SDK injects the bridge in its page-load callback, which can land after
    // React has already mounted and painted. Posting into the void here would
    // hide the surface until the SDK's grace timer gave up.
    render(<Probe resolved />)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const posted = installBridge()
    window.dispatchEvent(new Event('supportbridgeready'))

    await waitFor(() => expect(posted).toEqual([{ type: 'surface_ready' }]))
  })

  it('also wakes on a supportbridgeready dispatched at document', async () => {
    render(<Probe resolved />)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const posted = installBridge()
    document.dispatchEvent(new Event('supportbridgeready'))

    await waitFor(() => expect(posted).toEqual([{ type: 'surface_ready' }]))
  })

  it('does not post twice when the SDK dispatches at both targets', async () => {
    render(<Probe resolved />)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const posted = installBridge()
    window.dispatchEvent(new Event('supportbridgeready'))
    document.dispatchEvent(new Event('supportbridgeready'))

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted).toEqual([{ type: 'surface_ready' }])
  })

  it('does not post after the surface unmounts', async () => {
    const posted = installBridge()
    const spy = vi.spyOn(window, 'requestAnimationFrame')

    const { unmount } = render(<Probe resolved />)
    unmount()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(posted).toEqual([])
    spy.mockRestore()
  })
})
