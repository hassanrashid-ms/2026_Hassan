import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { SurfaceBootFrame } from './SurfaceBootFrame.tsx'

/*
 * Lazy, because this is agent-console code and a static import puts it in the
 * entry chunk — the one chunk every player waits on before anything can paint.
 * A player never reaches /login.
 */
const AgentLogin = lazy(async () => ({
  default: (await import('../surfaces/agent-console/pages/AgentLogin.tsx')).AgentLogin,
}))

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
const importSupportHome = () => import('../surfaces/webview/pages/SupportHome.tsx')

const WebviewShell = lazy(async () => {
  /*
   * Start the index route's chunk NOW, in parallel, rather than waiting for the
   * shell to render and request it.
   *
   * React.lazy only begins fetching when a component first renders, so shell and
   * home used to download one after the other: entry chunk → shell → home, three
   * serial round trips before a single pixel. On a phone or a tunnelled dev server
   * that is seconds of white screen. Home is what every /embed/support visit
   * renders next, so there is nothing speculative about fetching it alongside.
   */
  void importSupportHome()
  return { default: (await import('../surfaces/webview/components/WebviewShell.tsx')).WebviewShell }
})
const SupportHome = lazy(async () => ({ default: (await importSupportHome()).SupportHome }))
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
          <Suspense fallback={<SurfaceBootFrame />}>
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
      <Route
        path="/login"
        element={
          // Blank is right here and wrong for the webview: this is a desktop
          // console on a warm connection, not a phone waiting on a paused game.
          <Suspense fallback={null}>
            <AgentLogin />
          </Suspense>
        }
      />
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
