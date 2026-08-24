import { z } from 'zod'

/**
 * NOT part of the frozen SDK contract — ships with the server, same as chat.ts
 * and surface.ts. Shared by the agent console, the public surface, and OpenAPI.
 */
export const CreateIntentBody = z.object({ name: z.string().min(1).max(120) })
export const CreateSubintentBody = z.object({ name: z.string().min(1).max(120) })

export type ConversationPriority = 'p1' | 'p2' | 'p3' | 'p4'

export const RenameIntentBody = z.object({ name: z.string().min(1).max(120) })
export const RenameSubintentBody = z.object({
  name: z.string().min(1).max(120).optional(),
  defaultPriority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
})
// Deliberately a shape regex, not `z.uuid()`: zod 4's `z.uuid()` enforces the
// RFC variant nibble, which rejects the all-ones ids the tests and seeds use.
const uuidShape = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
export const MoveSubintentBody = z.object({ intentId: z.string().regex(uuidShape) })
export const MergeSubintentBody = z.object({ intoId: z.string().regex(uuidShape) })

export const CreateArticleBody = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  keywords: z.array(z.string()).optional(),
  intent_id: z.uuid().optional(),
})

export const UpdateArticleBody = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).optional(),
  keywords: z.array(z.string()).optional(),
  intent_id: z.uuid().nullable().optional(),
})

export const GenerateKeywordsBody = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
})

export const PublicArticleListQuery = z.object({
  intentId: z.uuid().optional(),
  q: z.string().min(1).max(200).optional(),
})

export type ArticleStateValue = 'draft' | 'published' | 'archived'

export type IntentSubintentView = {
  id: string
  name: string
  formId: string | null
  archivedAt: string | null
  defaultPriority: ConversationPriority | null
  mergedIntoId: string | null
}
export type IntentView = { id: string; name: string; isSystem: boolean; archivedAt: string | null; subintents: IntentSubintentView[] }
export type IntentsResponse = { intents: IntentView[] }
export type CreateIntentResponse = { id: string; name: string }
export type CreateSubintentResponse = { id: string; name: string; intent_id: string }

export type RenameIntentResponse = { id: string; name: string }
export type ArchiveIntentResponse = { id: string; name: string; archivedAt: string }
export type RenameSubintentResponse = { id: string; name: string; defaultPriority: ConversationPriority | null }
export type ArchiveSubintentResponse = { id: string; name: string; archivedAt: string }
export type MoveSubintentResponse = { id: string; name: string; intentId: string }
export type MergeSubintentResponse = { id: string; name: string; archivedAt: string; mergedIntoId: string }

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
  keywords: string[]
  state: ArticleStateValue
  intent_id: string | null
  created_by: string
  published_by: string | null
  published_at: string | null
  created_at: string
}

export type PublicArticleSummary = { id: string; title: string; keywords: string[]; intent_id: string | null }
export type PublicArticlesResponse = { articles: PublicArticleSummary[] }

export type PublicIntentSummary = { id: string; name: string }
export type PublicIntentsResponse = { intents: PublicIntentSummary[] }
export type PublicArticleDetail = {
  id: string
  title: string
  body: string
  keywords: string[]
  intent_id: string | null
  published_at: string | null
}
