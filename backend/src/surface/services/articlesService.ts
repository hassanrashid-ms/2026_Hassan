import { and, desc, eq, inArray } from 'drizzle-orm'
import type { PublicArticleDetail, PublicArticlesResponse } from '@support/types'
import { article } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'
import { searchArticleIds } from '../../shared/weaviate/articlesIndex.ts'

function toSummary(row: typeof article.$inferSelect) {
  return { id: row.id, title: row.title, keywords: row.keywords, intent_id: row.intentId }
}

function toDetail(row: typeof article.$inferSelect): PublicArticleDetail {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    keywords: row.keywords,
    intent_id: row.intentId,
    published_at: row.publishedAt ? row.publishedAt.toISOString() : null,
  }
}

export async function listPublicArticles(
  ctx: PlayerContext,
  filter: { intentId?: string; q?: string },
): Promise<PublicArticlesResponse> {
  if (filter.q) {
    const rankedIds = await searchArticleIds(filter.q, { intentId: filter.intentId, limit: 50 })
    if (rankedIds.length === 0) return { articles: [] }
    return withWorkspace(ctx.workspaceId, async (tx) => {
      const rows = await tx
        .select()
        .from(article)
        .where(and(eq(article.state, 'published'), inArray(article.id, rankedIds)))
      const byId = new Map(rows.map((r) => [r.id, r]))
      const ordered = rankedIds.map((id) => byId.get(id)).filter((r): r is typeof article.$inferSelect => r !== undefined)
      return { articles: ordered.map(toSummary) }
    })
  }
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const conditions = [eq(article.state, 'published')]
    if (filter.intentId) conditions.push(eq(article.intentId, filter.intentId))
    const rows = await tx
      .select()
      .from(article)
      .where(and(...conditions))
      .orderBy(desc(article.publishedAt))
    return { articles: rows.map(toSummary) }
  })
}

export async function getPublicArticle(ctx: PlayerContext, id: string): Promise<PublicArticleDetail | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .select()
      .from(article)
      .where(and(eq(article.id, id), eq(article.state, 'published')))
      .limit(1)
    return row ? toDetail(row) : null
  })
}
