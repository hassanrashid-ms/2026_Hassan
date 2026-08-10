import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { fetchPublicArticles } from '../../../features/articles/api/articlesApi.ts'
import { readBoot } from '../../../lib/boot.ts'

export function ArticleList() {
  const navigate = useNavigate()
  const boot = readBoot(window.location)
  const [q, setQ] = useState('')

  const articles = useQuery({
    queryKey: ['public-articles', q],
    queryFn: () => fetchPublicArticles(boot!.token, { q: q || undefined }),
    enabled: boot !== null,
  })

  if (!boot) return <p>Missing support session.</p>

  return (
    <main className="article-list">
      <h1>Help articles</h1>
      <input placeholder="Search articles" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul>
        {articles.data?.articles.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => navigate(`/embed/support/articles/${a.id}`)}>
              {a.title}
            </button>
          </li>
        ))}
      </ul>
      {articles.data?.articles.length === 0 && <p>No articles found.</p>}
    </main>
  )
}
