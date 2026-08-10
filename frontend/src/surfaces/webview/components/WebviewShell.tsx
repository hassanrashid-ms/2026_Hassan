import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet } from 'react-router-dom'
import type { BootstrapResponse } from '@support/types'
import { readBoot, scrubToken, type SurfaceBoot } from '@/lib/boot'
import { fetchBootstrap } from '@/surfaces/webview/api/surfaceApi'
import { onBridgeReady, post } from '@/services/bridgeService'
import { SupportContextProvider, type SupportContextValue } from '@/surfaces/webview/components/SupportContext'
import { NoSessionScreen } from '@/surfaces/webview/components/StateScreens'

// webview.css is imported HERE and nowhere else. main.tsx still imports only
// styles.css, so an agent-console route never evaluates this module and Tailwind's
// preflight reset cannot reach it. This import is the whole isolation mechanism —
// moving it up to main.tsx would silently restyle the console.
import '@/webview.css'

const NO_TOKEN_MESSAGE = 'This page must be opened by the game. No session token was supplied.'
const MAX_POLL_ATTEMPTS = 15
const POLL_INTERVAL_MS = 800
// The SDK injects window.SupportBridge in the same page-load callback that loads
// this page, so on a real device it shows up within milliseconds. Waiting this
// long before giving up on it is generous, not a real timeout budget.
const BRIDGE_WAIT_TIMEOUT_MS = 3000

/**
 * Owns the session lifecycle for all four webview routes: boot parse, token scrub,
 * bootstrap fetch, the retry-until-the-session-lands poll, and the layout frame.
 * Screens read the result from context and never re-fetch bootstrap themselves.
 */
export function WebviewShell() {
  const [boot, setBoot] = useState<SurfaceBoot | null>(null)
  const [data, setData] = useState<BootstrapResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)

  // StrictMode double-invokes mount effects in development. scrubToken removes the
  // fragment as a side effect of the first invocation, so a naive second run would
  // read an already-scrubbed URL, see no token, and set a false "no session token"
  // error alongside whatever the first run already loaded. The ref makes the body
  // idempotent instead of relying on removing StrictMode, which stays on deliberately.
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const parsed = readBoot(window.location)
    if (!parsed) {
      // Missing boot data is never something a player can act on — showing raw
      // "no session token was supplied" text to them is just noise. Whatever the
      // cause (a stale native webview reload after scrubToken already stripped
      // the fragment, or genuinely nothing passed at all), the right move inside
      // the game is to close the page, not display it. Only if no bridge shows
      // up within BRIDGE_WAIT_TIMEOUT_MS do we know this truly isn't running
      // inside the game (e.g. a dev hitting the URL directly in a browser) —
      // that's the one case the technical message is still useful for.
      let closed = false
      const timeout = window.setTimeout(() => {
        if (!closed) setError(NO_TOKEN_MESSAGE)
      }, BRIDGE_WAIT_TIMEOUT_MS)
      const unsubscribe = onBridgeReady(() => {
        closed = true
        window.clearTimeout(timeout)
        post({ type: 'close' })
      })
      return () => {
        window.clearTimeout(timeout)
        unsubscribe()
      }
    }
    setBoot(parsed)
    scrubToken(window.history, window.location)

    fetchBootstrap(parsed.token, parsed.sessionId)
      .then(setData)
      .catch(() => {
        // Session might still be initializing via SDK POST /sdk/sessions/start.
        // The polling effect below will retry fetchBootstrap until the session lands.
      })
  }, [])

  // Poll until the session exists and player state snapshot availability is no longer 'absent'.
  useEffect(() => {
    if (!boot) return
    if (data !== null && data.player_state.availability !== 'absent') return

    let attempts = 0

    const interval = setInterval(() => {
      attempts += 1
      fetchBootstrap(boot.token, boot.sessionId)
        .then((next) => {
          setData(next)
          if (next.player_state.availability !== 'absent') {
            clearInterval(interval)
          }
        })
        .catch((cause: unknown) => {
          if (attempts >= MAX_POLL_ATTEMPTS && data === null) {
            clearInterval(interval)
            setError(cause instanceof Error ? cause.message : 'Could not load support.')
          }
        })
    }, POLL_INTERVAL_MS)

    return () => clearInterval(interval)
    // retryNonce is a deliberate dependency: bumping it re-arms an interval that
    // gave up. Today the poll simply stops and the player has no way back.
  }, [boot, data, retryNonce])

  const retry = useCallback(() => {
    setError(null)
    setRetryNonce((n) => n + 1)
  }, [])

  const value = useMemo<SupportContextValue>(() => ({ boot, data, error, retry }), [boot, data, error, retry])

  return (
    <SupportContextProvider value={value}>
      {/*
        100dvh, not 100vh: dvh tracks the visual viewport as mobile browser chrome
        and the software keyboard come and go, which is exactly the case this
        surface lives in. overflow-hidden pins the frame so only the inner regions
        a screen designates ever scroll — the page itself must not.
      */}
      <div
        className="flex h-[100dvh] w-full flex-col overflow-hidden bg-bg text-text"
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          paddingLeft: 'env(safe-area-inset-left)',
          paddingRight: 'env(safe-area-inset-right)',
        }}
      >
        {/*
          No token is the one failure that blocks every route: there is no session
          to close, nothing to retry, and no chat to fall back to. Every other
          failure is handled per-screen so that chat stays reachable.
        */}
        {boot === null && error !== null ? <NoSessionScreen message={error} /> : <Outlet />}
      </div>
    </SupportContextProvider>
  )
}
