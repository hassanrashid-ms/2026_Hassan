import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { WebviewShell } from '@/surfaces/webview/components/WebviewShell'
import { SupportHome } from '@/surfaces/webview/pages/SupportHome'

/*
 * The player surface's entry point, mounted by webview.html.
 *
 * WebviewShell and SupportHome are imported STATICALLY, which is the whole reason
 * this entry exists. Reached through React.lazy from the shared router they were
 * invisible to the bundler until the entry chunk executed, costing a serial round
 * trip before anything could render — and they could not simply be made static
 * there, because webview.css would then merge into the shared stylesheet and leak
 * Tailwind's preflight into the agent console. A separate entry breaks that
 * deadlock: Vite emits modulepreload links for both chunks in webview.html, so
 * they download alongside the entry bundle, and the console never reaches them.
 *
 * Search and chat stay lazy. Chat in particular pulls socket.io and the chat
 * reconciliation code — well over 100KB that a player who never opens chat should
 * not wait on. Preload what the landing screen needs; fetch the rest on demand.
 */
const SupportSearch = lazy(async () => ({
  default: (await import('@/surfaces/webview/pages/SupportSearch')).SupportSearch,
}))
const SupportChat = lazy(async () => ({
  default: (await import('@/surfaces/webview/pages/SupportChat')).SupportChat,
}))

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from webview.html')

const queryClient = new QueryClient()

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/*
            Paths are absolute and unchanged from when these routes lived in the
            shared router: this document is served for /embed/support and below,
            so the router still sees exactly the pathnames it always did. The SDK's
            webviewBaseUrl needs no change.

            Real routes rather than screen state, so Android's hardware back button
            does the obvious thing at every step and each screen can be mounted in
            isolation by a test. WebviewShell is the layout route: it owns the
            session for all four screens.
          */}
          <Route path="/embed/support" element={<WebviewShell />}>
            <Route index element={<SupportHome />} />
            {/* Blank fallbacks: the shell frame stays painted around the Outlet,
                so only the inner screen is briefly absent — a spinner flashing
                there over a paused game is worse than nothing. */}
            <Route
              path="search"
              element={
                <Suspense fallback={null}>
                  <SupportSearch />
                </Suspense>
              }
            />
            {/* Deep link: home, with the article sheet already open over it. */}
            <Route path="articles/:id" element={<SupportHome />} />
            <Route
              path="chat"
              element={
                <Suspense fallback={null}>
                  <SupportChat />
                </Suspense>
              }
            >
              {/*
                Nested under chat, and rendering the SAME SupportChat element, so
                the sheet opens over a thread that never unmounted. Reusing
                /embed/support/articles/:id would render SupportHome instead —
                killing the socket and leaving the hardware back button stepping
                through local state that no longer exists.
              */}
              <Route path="articles/:id" element={null} />
            </Route>
            {/* No dead ends, including mistyped ones. */}
            <Route path="*" element={<Navigate to="/embed/support" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
