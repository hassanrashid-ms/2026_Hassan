import { Route, Routes } from 'react-router-dom'
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
      {/* webview routes */}
      <Route path="/" element={<SupportSurface />} />
      <Route path="/articles" element={<ArticleList />} />
      <Route path="/articles/:id" element={<ArticleView />} />

      {/* agent-console routes */}
      <Route path="/login" element={<AgentLogin />} />
      <Route path="/inbox" element={<AgentInbox />} />
      <Route path="/conversations/:id" element={<AgentConversation />} />
      <Route path="/admin/articles" element={<AdminArticles />} />
    </Routes>
  )
}
