import { and, desc, eq, ilike, or } from 'drizzle-orm'
import type { PublicArticleDetail, PublicArticlesResponse } from '@support/types'
import { article } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'

function toSummary(row: typeof article.$inferSelect) {
  return { id: row.id, title: row.title, summary: row.summary, intent_id: row.intentId }
}

function toDetail(row: typeof article.$inferSelect): PublicArticleDetail {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    summary: row.summary,
    intent_id: row.intentId,
    published_at: row.publishedAt ? row.publishedAt.toISOString() : null,
  }
}

export async function listPublicArticles(
  ctx: PlayerContext,
  filter: { intentId?: string; q?: string },
): Promise<PublicArticlesResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const conditions = [eq(article.state, 'published')]
    if (filter.intentId) conditions.push(eq(article.intentId, filter.intentId))
    if (filter.q) {
      const keyword = or(ilike(article.title, `%${filter.q}%`), ilike(article.body, `%${filter.q}%`))
      if (keyword) conditions.push(keyword)
    }
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
