export type BridgeMessage =
  | { type: 'conversation_created' }
  | { type: 'article_read'; id: string }
  | { type: 'close' }
  /**
   * "Open this somewhere that is not me."
   *
   * A link tapped inside the webview would otherwise navigate in place, replacing
   * the entire support surface with the target page — no back button, no way home.
   * The SDK opens it in the system browser instead, leaving both the game and this
   * surface intact.
   *
   * An SDK build predating the handler ignores this (unknown types are always
   * ignored, never errored) and the tap does nothing. A dead tap is strictly
   * better than a stranded player, and `post` is fire-and-forget so the page
   * cannot feature-detect the difference.
   */
  | { type: 'open_url'; url: string }
  /**
   * "I'm about to hand off to a native OS dialog — don't treat what happens
   * next as the player backgrounding the app."
   *
   * Opening a file picker (or the OS permission prompt that can precede it)
   * pauses and resumes the Unity app the same way switching away from the
   * game does, from the SDK's point of view — `OnApplicationPause` fires
   * either way. Without this signal, the SDK's resume watchdog cannot tell
   * "the player picked a photo" from "the player alt-tabbed away" and closes
   * the surface on both. Sent right before the native picker is triggered,
   * never after: the pause can start as soon as the click happens, and this
   * has to already be in flight for the SDK to catch it in time.
   */
  | { type: 'expect_native_dialog' }
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
  | { type: 'surface_ready' };

declare global {
  interface Window {
    SupportBridge?: { post(message: unknown): void };
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
  const bridge = window.SupportBridge;
  if (!bridge) {
    console.warn('[surface] no SupportBridge on this platform; would have posted', message);
    return;
  }
  try {
    bridge.post(message);
  } catch (error) {
    console.error('[surface] bridge post failed', error);
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
    callback();
    return () => {};
  }

  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    unsubscribe();
    callback();
  };
  const unsubscribe = () => {
    window.removeEventListener('supportbridgeready', once);
    document.removeEventListener('supportbridgeready', once);
  };

  window.addEventListener('supportbridgeready', once);
  document.addEventListener('supportbridgeready', once);
  return unsubscribe;
}
