export type BridgeMessage =
  | { type: 'conversation_created' }
  | { type: 'article_read'; id: string }
  | { type: 'close' }
  /**
   * "I have painted; you can show me now."
   *
   * The SDK keeps the native webview hidden until this arrives. Its own page-load
   * callback fires on document load — before this bundle has evaluated, before
   * React has mounted, and before bootstrap has returned — so revealing there
   * would show the player an empty page for the whole boot. This message is the
   * only thing that reveals the surface on the happy path, which makes it
   * load-bearing: dropping it does not degrade the experience, it hides the
   * surface until the SDK's grace timer gives up.
   */
  | { type: 'surface_ready' }

declare global {
  interface Window {
    SupportBridge?: { post(message: unknown): void }
  }
}

/**
 * The SDK injects window.SupportBridge on load and fires `supportbridgeready`.
 * Unknown message types are ignored by the SDK, never errored, so the page can add
 * new ones without every shipped Unity build needing an update.
 *
 * In a plain desktop browser there is no bridge. That is a supported development
 * mode, not an error — log and carry on.
 */
export function post(message: BridgeMessage): void {
  const bridge = window.SupportBridge
  if (!bridge) {
    console.warn('[surface] no SupportBridge on this platform; would have posted', message)
    return
  }
  try {
    bridge.post(message)
  } catch (error) {
    console.error('[surface] bridge post failed', error)
  }
}

/**
 * The bridge is injected by the SDK on page load, which may land before or after
 * this module runs — hence both the synchronous check and the event.
 *
 * The event is listened for on `window` and `document`: the SDK dispatches on
 * both, and neither dispatch bubbles, so exactly one of these fires. Listening on
 * only one target is how this silently never fired before.
 */
export function onBridgeReady(callback: () => void): () => void {
  if (window.SupportBridge) {
    callback()
    return () => {}
  }

  let done = false
  const once = () => {
    if (done) return
    done = true
    unsubscribe()
    callback()
  }
  const unsubscribe = () => {
    window.removeEventListener('supportbridgeready', once)
    document.removeEventListener('supportbridgeready', once)
  }

  window.addEventListener('supportbridgeready', once)
  document.addEventListener('supportbridgeready', once)
  return unsubscribe
}
