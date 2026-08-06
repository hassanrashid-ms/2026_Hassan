import { Route, Routes } from 'react-router-dom'
import { SupportSurface } from './pages/SupportSurface.tsx'
import { AgentLogin } from './pages/AgentLogin.tsx'
import { AgentInbox } from './pages/AgentInbox.tsx'
import { AgentConversation } from './pages/AgentConversation.tsx'
import { AdminArticles } from './pages/AdminArticles.tsx'
import { ArticleList } from './pages/ArticleList.tsx'
import { ArticleView } from './pages/ArticleView.tsx'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<SupportSurface />} />
      <Route path="/login" element={<AgentLogin />} />
      <Route path="/inbox" element={<AgentInbox />} />
      <Route path="/conversations/:id" element={<AgentConversation />} />
      <Route path="/admin/articles" element={<AdminArticles />} />
      <Route path="/articles" element={<ArticleList />} />
      <Route path="/articles/:id" element={<ArticleView />} />
    </Routes>
  )
}
