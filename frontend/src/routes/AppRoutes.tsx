import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AgentLogin } from '../surfaces/agent-console/pages/AgentLogin.tsx'

/*
 * agent-console.css is scoped the same way webview.css is: lazily imported by
 * AgentConsoleShell.tsx alone, never statically, so its Tailwind preflight
 * reset never reaches the webview bundle (see the comment on WebviewShell below).
 */
const AgentConsoleShell = lazy(async () => ({
  default: (await import('../surfaces/agent-console/components/AgentConsoleShell.tsx')).AgentConsoleShell,
}))
const Inbox = lazy(async () => ({ default: (await import('../surfaces/agent-console/pages/Inbox/Inbox.tsx')).Inbox }))
const KnowledgeBase = lazy(async () => ({
  default: (await import('../surfaces/agent-console/pages/KnowledgeBase/KnowledgeBase.tsx')).KnowledgeBase,
}))

/*
 * The webview is lazily imported, and that is a correctness requirement rather
 * than a performance tweak.
 *
 * WebviewShell is the only importer of webview.css — but "only importer" is not
 * by itself isolation: Vite concatenates every statically reachable stylesheet
 * into one bundle, so a static import would ship Tailwind's preflight reset to
 * the agent console in production even though no console module mentions it.
 * A dynamic import puts the webview's CSS in its own chunk, fetched only when a
 * /embed/support route actually renders. Verified by there being two .css files
 * in dist/assets, not one.
 */
const WebviewShell = lazy(async () => ({ default: (await import('../surfaces/webview/components/WebviewShell.tsx')).WebviewShell }))
const SupportHome = lazy(async () => ({ default: (await import('../surfaces/webview/pages/SupportHome.tsx')).SupportHome }))
const SupportSearch = lazy(async () => ({ default: (await import('../surfaces/webview/pages/SupportSearch.tsx')).SupportSearch }))
const SupportChat = lazy(async () => ({ default: (await import('../surfaces/webview/pages/SupportChat.tsx')).SupportChat }))

export function AppRoutes() {
  return (
    <Routes>
      {/*
        webview routes — deliberately not at "/" so an agent poking at the
        console can't land on the player surface by accident. The SDK's
        webviewBaseUrl points at this prefix.

        Real routes rather than screen state, so Android's hardware back button
        does the obvious thing at every step and each screen can be mounted in
        isolation by a test. WebviewShell is the layout route: it owns the
        session for all four screens.
      */}
      <Route
        path="/embed/support"
        element={
          // The fallback is blank on purpose: the chunk is local and resolves in
          // a frame or two, and a spinner that flashes for 30ms over a paused
          // game is worse than nothing.
          <Suspense fallback={null}>
            <WebviewShell />
          </Suspense>
        }
      >
        <Route index element={<SupportHome />} />
        <Route path="search" element={<SupportSearch />} />
        {/* Deep link: home, with the article sheet already open over it. */}
        <Route path="articles/:id" element={<SupportHome />} />
        <Route path="chat" element={<SupportChat />} />
        {/* No dead ends, including mistyped ones. */}
        <Route path="*" element={<Navigate to="/embed/support" replace />} />
      </Route>

      {/* agent-console routes */}
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<AgentLogin />} />
      <Route
        path="/"
        element={
          <Suspense fallback={null}>
            <AgentConsoleShell />
          </Suspense>
        }
      >
        <Route path="inbox" element={<Inbox />} />
        <Route path="inbox/:conversationId" element={<Inbox />} />
        <Route path="articles" element={<KnowledgeBase />} />
      </Route>
    </Routes>
  )
}
