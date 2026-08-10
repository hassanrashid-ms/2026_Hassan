import { Navigate, Route, Routes } from 'react-router-dom'
import { SupportSurface } from '../surfaces/webview/pages/SupportSurface.tsx'
import { ArticleList } from '../surfaces/webview/pages/ArticleList.tsx'
import { ArticleView } from '../surfaces/webview/pages/ArticleView.tsx'
import { AgentLogin } from '../surfaces/agent-console/pages/AgentLogin.tsx'
import { AgentInbox } from '../surfaces/agent-console/pages/AgentInbox.tsx'
import { AgentConversation } from '../surfaces/agent-console/pages/AgentConversation.tsx'
import { AdminArticles } from '../surfaces/agent-console/pages/AdminArticles.tsx'

export function AppRoutes() {
  return (
    <Routes>
      {/*
        webview routes — deliberately not at "/" so an agent poking at the
        console can't land on the player surface by accident. The SDK's
        webviewBaseUrl points at this prefix.
      */}
      <Route path="/embed/support" element={<SupportSurface />} />
      <Route path="/embed/support/articles" element={<ArticleList />} />
      <Route path="/embed/support/articles/:id" element={<ArticleView />} />

      {/* agent-console routes */}
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<AgentLogin />} />
      <Route path="/inbox" element={<AgentInbox />} />
      <Route path="/conversations/:id" element={<AgentConversation />} />
      <Route path="/admin/articles" element={<AdminArticles />} />
    </Routes>
  )
}
