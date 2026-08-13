import { useCallback, useEffect, useRef, useState } from 'react'
import type { VirtuosoHandle } from 'react-virtuoso'

/**
 * The other half of `followOutput="auto"`. Following deliberately stops once the
 * reader scrolls up — yanking the viewport out from under someone reading
 * history is worse than a missed message — but that left no signal that anything
 * arrived and no way back down. This tracks both, for whichever thread renderer
 * a surface uses.
 *
 * `atBottomRef` shadows the state on purpose: the effect below runs in the same
 * commit as a message arriving, and reading the state variable there would use
 * whatever value that render closed over rather than Virtuoso's latest report.
 */
export function useJumpToLatest(messageCount: number) {
  const ref = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [missed, setMissed] = useState(0)
  const atBottomRef = useRef(true)
  const lastCount = useRef(messageCount)

  useEffect(() => {
    const grew = messageCount - lastCount.current
    lastCount.current = messageCount
    // Only growth counts. A shrinking list is a conversation switch or a
    // reconciled optimistic send, neither of which is a message the reader missed.
    if (grew > 0 && !atBottomRef.current) setMissed((current) => current + grew)
  }, [messageCount])

  const onAtBottomChange = useCallback((next: boolean) => {
    atBottomRef.current = next
    setAtBottom(next)
    // Reaching the bottom by scrolling counts as having seen them, exactly like
    // pressing the button does.
    if (next) setMissed(0)
  }, [])

  const jump = useCallback(() => {
    ref.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth', align: 'end' })
    setMissed(0)
  }, [])

  return {
    ref,
    /** An empty thread has no bottom worth jumping to. */
    showJump: !atBottom && messageCount > 0,
    missed,
    onAtBottomChange,
    jump,
  }
}
