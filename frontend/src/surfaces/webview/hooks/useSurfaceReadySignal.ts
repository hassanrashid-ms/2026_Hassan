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

    // Signalled directly, with NO requestAnimationFrame.
    //
    // This used to wait two nested frames so the paint had reached the compositor
    // before revealing. That reasoning was self-defeating: the SDK holds the
    // native view hidden until this very message arrives, and a hidden webview
    // does not composite, so the rAF callbacks were throttled or never delivered.
    // The signal waited for a frame that could not arrive until the signal was
    // sent, and every open fell through to the SDK's ready-signal watchdog
    // instead — the exact 3s spinner-over-a-ready-page this hook exists to avoid.
    //
    // An effect already runs after React has committed to the DOM, so the content
    // is there to be shown the moment the view becomes visible.
    // The guard sits inside the callback, not at the top of the effect. React's
    // StrictMode double-invoke mounts, cleans up, then mounts again — so a guard
    // that short-circuited the second invocation would skip re-subscribing after
    // the first one's cleanup unsubscribed, and the surface would stay hidden
    // forever in development. Subscribing is idempotent; sending is what must
    // happen at most once.
    const unsubscribe = onBridgeReady(() => {
      if (sentRef.current) return
      sentRef.current = true
      post({ type: 'surface_ready' })
    })

    return unsubscribe
  }, [resolved])
}
