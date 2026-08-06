import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { fetchPublicArticle } from '../api/articlesApi.ts'
import { readBoot } from '../boot.ts'

export function ArticleView() {
  const { id } = useParams<{ id: string }>()
  const boot = readBoot(window.location)

  const article = useQuery({
    queryKey: ['public-article', id],
    queryFn: () => fetchPublicArticle(boot!.token, id!),
    enabled: boot !== null && id !== undefined,
  })

  if (!boot) return <p>Missing support session.</p>
  if (article.isLoading) return <p>Loading…</p>
  if (article.isError || !article.data) return <p>Article not found.</p>

  return (
    <main className="article-view">
      <h1>{article.data.title}</h1>
      <article>{article.data.body}</article>
    </main>
  )
}
