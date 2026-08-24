import { desc, eq } from 'drizzle-orm'
import type { AgentArticleDetail, AgentArticlesResponse } from '@support/types'
import { article, intent } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'
import { deleteArticleObject, upsertArticleObject } from '../../shared/weaviate/articlesIndex.ts'

function toDetail(row: typeof article.$inferSelect): AgentArticleDetail {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    keywords: row.keywords,
    state: row.state,
    intent_id: row.intentId,
    created_by: row.createdBy,
    published_by: row.publishedBy,
    published_at: row.publishedAt ? row.publishedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  }
}

export async function listArticles(ctx: AgentContext): Promise<AgentArticlesResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const rows = await tx.select().from(article).orderBy(desc(article.createdAt))
    return {
      articles: rows.map((r) => ({
        id: r.id,
        title: r.title,
        state: r.state,
        intent_id: r.intentId,
        created_at: r.createdAt.toISOString(),
        published_at: r.publishedAt ? r.publishedAt.toISOString() : null,
      })),
    }
  })
}

export async function getArticle(ctx: AgentContext, id: string): Promise<AgentArticleDetail | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx.select().from(article).where(eq(article.id, id)).limit(1)
    return row ? toDetail(row) : null
  })
}

export type CreateArticleInput = { title: string; body: string; keywords?: string[]; intentId?: string }
export type CreateArticleResult = { ok: true; article: AgentArticleDetail } | { ok: false; reason: 'intent_not_found' }

export async function createArticle(ctx: AgentContext, input: CreateArticleInput): Promise<CreateArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    if (input.intentId) {
      const [found] = await tx.select({ id: intent.id }).from(intent).where(eq(intent.id, input.intentId)).limit(1)
      if (!found) return { ok: false, reason: 'intent_not_found' }
    }
    const [row] = await tx
      .insert(article)
      .values({
        workspaceId: ctx.workspaceId,
        intentId: input.intentId ?? null,
        title: input.title,
        body: input.body,
        keywords: input.keywords ?? [],
        createdBy: ctx.agentId,
      })
      .returning()
    return { ok: true, article: toDetail(row!) }
  })
}

export type UpdateArticleInput = { title?: string; body?: string; keywords?: string[]; intentId?: string | null }
export type UpdateArticleResult =
  | { ok: true; article: AgentArticleDetail }
  | { ok: false; reason: 'not_found' | 'not_draft' | 'intent_not_found' }

export async function updateArticle(ctx: AgentContext, id: string, patch: UpdateArticleInput): Promise<UpdateArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, id)).limit(1)
    if (!existing) return { ok: false, reason: 'not_found' }
    if (existing.state !== 'draft') return { ok: false, reason: 'not_draft' }
    if (patch.intentId) {
      const [found] = await tx.select({ id: intent.id }).from(intent).where(eq(intent.id, patch.intentId)).limit(1)
      if (!found) return { ok: false, reason: 'intent_not_found' }
    }
    const [row] = await tx
      .update(article)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.keywords !== undefined ? { keywords: patch.keywords } : {}),
        ...(patch.intentId !== undefined ? { intentId: patch.intentId } : {}),
      })
      .where(eq(article.id, id))
      .returning()
    return { ok: true, article: toDetail(row!) }
  })
}

export type PublishArticleResult =
  | { ok: true; article: AgentArticleDetail }
  | { ok: false; reason: 'not_found' | 'not_draft' | 'empty_fields' }

export async function publishArticle(ctx: AgentContext, id: string): Promise<PublishArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, id)).limit(1)
    if (!existing) return { ok: false, reason: 'not_found' }
    if (existing.state !== 'draft') return { ok: false, reason: 'not_draft' }
    if (existing.title.trim() === '' || existing.body.trim() === '') return { ok: false, reason: 'empty_fields' }
    const [row] = await tx
      .update(article)
      .set({ state: 'published', publishedBy: ctx.agentId, publishedAt: new Date() })
      .where(eq(article.id, id))
      .returning()
    await upsertArticleObject({
      id: row!.id,
      title: row!.title,
      body: row!.body,
      keywords: row!.keywords,
      intentId: row!.intentId,
      workspaceId: row!.workspaceId,
    })
    return { ok: true, article: toDetail(row!) }
  })
}

export type ArchiveArticleResult = { ok: true; article: AgentArticleDetail } | { ok: false; reason: 'not_found' }

export async function archiveArticle(ctx: AgentContext, id: string): Promise<ArchiveArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx.update(article).set({ state: 'archived' }).where(eq(article.id, id)).returning()
    if (!row) return { ok: false, reason: 'not_found' }
    await deleteArticleObject(row.id)
    return { ok: true, article: toDetail(row) }
  })
}

import { callModel } from '../../domain/bot/openaiClient.ts'

export async function generateKeywords(title: string, body: string): Promise<string[]> {
  const prompt = `You are a helpful assistant that generates keywords for an article.
Given the following title and body, extract or generate up to 5 relevant keywords.
Format the output as a comma-separated list of keywords.

Title: ${title}

Body: ${body}

Keywords:`

  const response = await callModel([{ role: 'user', content: prompt }])
  const text = response.text || ''
  return text.split(',').map((k) => k.trim()).filter((k) => k.length > 0)
}
