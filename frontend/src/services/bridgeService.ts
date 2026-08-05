export type BridgeMessage =
  | { type: 'conversation_created' }
  | { type: 'article_read'; id: string }
  | { type: 'close' }

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

export function onBridgeReady(callback: () => void): () => void {
  if (window.SupportBridge) {
    callback()
    return () => {}
  }
  window.addEventListener('supportbridgeready', callback, { once: true })
  return () => window.removeEventListener('supportbridgeready', callback)
}
