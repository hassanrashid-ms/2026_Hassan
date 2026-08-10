import { useEffect, useRef } from 'react'
import { onBridgeReady, post } from '@/services/bridgeService'

/**
 * Tells the SDK the surface has painted, so it can reveal the native webview and
 * take its loader down.
 *
 * Until this fires the player is looking at the game with the SDK's loader over
 * it — never at this page. That is the point: the SDK's own page-load callback
 * fires on document load, long before React has mounted or bootstrap has
 * returned, so revealing there is what produced the blank white screen. The cost
 * of that guarantee is that this signal is load-bearing — if `resolved` never
 * goes true, the player waits out the SDK's grace timer instead of arriving.
 *
 * Pass `resolved` as "there is a real screen to look at", including a terminal
 * error screen: an error the player can act on is content, and holding the loader
 * over it would strand them behind a spinner.
 */
export function useSurfaceReadySignal(resolved: boolean): void {
  const sentRef = useRef(false)

  useEffect(() => {
    if (!resolved) return

    let outer = 0
    let inner = 0
    let unsubscribe = () => {}

    // Two frames, not one. When this effect runs React has *scheduled* a paint,
    // not made one, and a requestAnimationFrame callback still runs before the
    // paint it belongs to. The nested call is the first moment the frame has
    // actually been handed to the compositor — signalling from the outer one
    // reveals the surface exactly one frame too early, which is the flash this
    // whole mechanism exists to remove.
    outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        // The guard lives here rather than at the top of the effect so React's
        // StrictMode double-invoke — which mounts, cleans up, then mounts again —
        // cannot consume the one signal we are allowed to send and leave the
        // surface permanently hidden in development.
        if (sentRef.current) return
        sentRef.current = true
        unsubscribe = onBridgeReady(() => post({ type: 'surface_ready' }))
      })
    })

    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
      unsubscribe()
    }
  }, [resolved])
}
