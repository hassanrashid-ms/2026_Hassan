import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useJumpToLatest } from './useJumpToLatest.ts'

/**
 * The button's visible state lives here rather than in either thread renderer:
 * jsdom computes no layout, so Virtuoso never reports a real scroll position and
 * the components themselves can't be driven into the scrolled-up state. This
 * models exactly what Virtuoso feeds in — atBottomStateChange and a message
 * count — so the rules stay tested.
 */
describe('useJumpToLatest', () => {
  it('stays hidden while the reader is at the bottom, however many messages arrive', () => {
    const { result, rerender } = renderHook(({ count }) => useJumpToLatest(count), { initialProps: { count: 3 } })

    expect(result.current.showJump).toBe(false)
    rerender({ count: 5 })
    expect(result.current.showJump).toBe(false)
    expect(result.current.missed).toBe(0)
  })

  it('appears once scrolled up and counts only what arrived after that', () => {
    const { result, rerender } = renderHook(({ count }) => useJumpToLatest(count), { initialProps: { count: 3 } })

    act(() => result.current.onAtBottomChange(false))
    expect(result.current.showJump).toBe(true)
    expect(result.current.missed).toBe(0)

    rerender({ count: 5 })
    expect(result.current.missed).toBe(2)
  })

  it('clears the count when the reader scrolls back down themselves', () => {
    const { result, rerender } = renderHook(({ count }) => useJumpToLatest(count), { initialProps: { count: 1 } })

    act(() => result.current.onAtBottomChange(false))
    rerender({ count: 4 })
    expect(result.current.missed).toBe(3)

    act(() => result.current.onAtBottomChange(true))
    expect(result.current.missed).toBe(0)
    expect(result.current.showJump).toBe(false)
  })

  it('does not count a shrinking list — a conversation switch is not a missed message', () => {
    const { result, rerender } = renderHook(({ count }) => useJumpToLatest(count), { initialProps: { count: 8 } })

    act(() => result.current.onAtBottomChange(false))
    rerender({ count: 2 })
    expect(result.current.missed).toBe(0)

    // And the next real arrival counts from the new baseline, not the old one.
    rerender({ count: 3 })
    expect(result.current.missed).toBe(1)
  })

  it('offers nothing to jump to in an empty thread', () => {
    const { result } = renderHook(() => useJumpToLatest(0))
    act(() => result.current.onAtBottomChange(false))
    expect(result.current.showJump).toBe(false)
  })
})
