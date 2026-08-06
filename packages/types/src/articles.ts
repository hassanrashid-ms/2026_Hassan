import { z } from 'zod'

/**
 * NOT part of the frozen SDK contract — ships with the server, same as chat.ts
 * and surface.ts. Shared by the agent console, the public surface, and OpenAPI.
 */
export const CreateIntentBody = z.object({ name: z.string().min(1).max(120) })
export const CreateSubintentBody = z.object({ name: z.string().min(1).max(120) })

export const CreateArticleBody = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  summary: z.string().max(500).optional(),
  intent_id: z.uuid().optional(),
})

export const UpdateArticleBody = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).optional(),
  summary: z.string().max(500).nullable().optional(),
  intent_id: z.uuid().nullable().optional(),
})

export const PublicArticleListQuery = z.object({
  intentId: z.uuid().optional(),
  q: z.string().min(1).max(200).optional(),
})

export type ArticleStateValue = 'draft' | 'published' | 'archived'

export type IntentSubintentView = { id: string; name: string }
export type IntentView = { id: string; name: string; subintents: IntentSubintentView[] }
export type IntentsResponse = { intents: IntentView[] }
export type CreateIntentResponse = { id: string; name: string }
export type CreateSubintentResponse = { id: string; name: string; intent_id: string }

export type AgentArticleSummary = {
  id: string
  title: string
  state: ArticleStateValue
  intent_id: string | null
  created_at: string
  published_at: string | null
}
export type AgentArticlesResponse = { articles: AgentArticleSummary[] }

export type AgentArticleDetail = {
  id: string
  title: string
  body: string
  summary: string | null
  state: ArticleStateValue
  intent_id: string | null
  created_by: string
  published_by: string | null
  published_at: string | null
  created_at: string
}

export type PublicArticleSummary = { id: string; title: string; summary: string | null; intent_id: string | null }
export type PublicArticlesResponse = { articles: PublicArticleSummary[] }
export type PublicArticleDetail = {
  id: string
  title: string
  body: string
  summary: string | null
  intent_id: string | null
  published_at: string | null
}
