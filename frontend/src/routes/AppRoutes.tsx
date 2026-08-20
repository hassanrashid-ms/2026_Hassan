import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AgentLogin } from '../surfaces/agent-console/pages/AgentLogin.tsx'

/*
 * The agent console's router. The player surface is NOT here: it has its own
 * entry document and router at surfaces/webview/main.tsx, so that its shell and
 * home screen can be statically imported and preloaded, and so that no console
 * module is reachable from it. Nothing in this file should ever import from
 * surfaces/webview again.
 *
 * agent-console.css is imported by AgentConsoleShell.tsx alone, never statically
 * from here, so its Tailwind preflight reset stays in its own chunk.
 */
const AgentConsoleShell = lazy(async () => ({
  default: (await import('../surfaces/agent-console/components/AgentConsoleShell.tsx')).AgentConsoleShell,
}))
const Inbox = lazy(async () => ({ default: (await import('../surfaces/agent-console/pages/Inbox/Inbox.tsx')).Inbox }))
const KnowledgeBase = lazy(async () => ({
  default: (await import('../surfaces/agent-console/pages/KnowledgeBase/KnowledgeBase.tsx')).KnowledgeBase,
}))
const Forms = lazy(async () => ({
  default: (await import('../surfaces/agent-console/pages/Forms/Forms.tsx')).Forms,
}))
const Taxonomy = lazy(async () => ({
  default: (await import('../surfaces/agent-console/pages/Taxonomy/Taxonomy.tsx')).Taxonomy,
}))
const BotConfigPage = lazy(async () => ({
  default: (await import('../surfaces/agent-console/pages/BotConfig/BotConfig.tsx')).BotConfig,
}))

export function AppRoutes() {
  return (
    <Routes>
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
        <Route path="articles/:id" element={<KnowledgeBase />} />
        <Route path="forms" element={<Forms />} />
        <Route path="forms/:id" element={<Forms />} />
        <Route path="taxonomy" element={<Taxonomy />} />
        <Route path="bot-config" element={<BotConfigPage />} />
      </Route>
    </Routes>
  )
}
