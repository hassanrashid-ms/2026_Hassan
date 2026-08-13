// backend/src/domain/bot/tools.ts
import { eq } from 'drizzle-orm'
import type { Tx } from '../../shared/db/withWorkspace.ts'
import { article } from '../../shared/db/schema/index.ts'
import { searchArticleIds } from '../../shared/weaviate/articlesIndex.ts'
import type { SubintentOption } from './contextAssembly.ts'

export type ToolPhase = 'none' | 'article_confirm'

export const CONFIRM_RESOLUTION_TOOL_NAME = 'confirm_resolution'
const MAX_ARTICLES_PER_TURN = 3

const ALWAYS_AVAILABLE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_articles',
      description: 'Search published help articles by natural-language query. No side effects. Call at most 3 times per turn.',
      strict: true,
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'classify',
      description: "Record which category the player's problem falls into. Write-once: a second call in this conversation is ignored.",
      strict: true,
      parameters: { type: 'object', properties: { subintent_index: { type: 'integer' } }, required: ['subintent_index'], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'offer_article',
      description: 'Post one of the articles returned by search_articles this turn to the player, and ask if it solved their problem.',
      strict: true,
      parameters: { type: 'object', properties: { article_id: { type: 'string' } }, required: ['article_id'], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'handoff',
      description: 'End the turn and connect the player to a human support agent.',
      strict: true,
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', enum: ['asked_for_person', 'no_article', 'sensitive'] } },
        required: ['reason'],
        additionalProperties: false,
      },
    },
  },
] as const

const CONFIRM_RESOLUTION_TOOL = {
  type: 'function',
  function: {
    name: CONFIRM_RESOLUTION_TOOL_NAME,
    description: 'Record whether the offered article solved the player\'s problem. Only call this in direct response to the player answering "did this solve it?".',
    strict: true,
    parameters: { type: 'object', properties: { helped: { type: 'boolean' } }, required: ['helped'], additionalProperties: false },
  },
} as const

export const TOOL_DEFS = [...ALWAYS_AVAILABLE_TOOLS, CONFIRM_RESOLUTION_TOOL]

/**
 * confirm_resolution is offered to the model only while bot_phase =
 * 'article_confirm' — a property of the request, not of the prompt (spec §3).
 */
export function toolsForPhase(phase: ToolPhase): unknown[] {
  return phase === 'article_confirm' ? [...ALWAYS_AVAILABLE_TOOLS, CONFIRM_RESOLUTION_TOOL] : [...ALWAYS_AVAILABLE_TOOLS]
}

export { MAX_ARTICLES_PER_TURN }

export type SearchArticlesResult = { id: string; title: string; body: string }[]

/** Hybrid retrieval fired against the model's own phrased query, not the player's raw words (spec §3). */
export async function searchArticles(tx: Tx, workspaceId: string, query: string): Promise<SearchArticlesResult> {
  const ids = await searchArticleIds(query, { workspaceId, limit: 5 })
  if (ids.length === 0) return []

  const rows = await tx.select({ id: article.id, title: article.title, body: article.body }).from(article).where(eq(article.workspaceId, workspaceId))
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.map((id) => byId.get(id)).filter((r): r is { id: string; title: string; body: string } => r !== undefined)
}

/** Null on an out-of-range index — toolLoop maps that to the Other fallback, same as an explicit Other choice. */
export function resolveClassifyIndex(options: SubintentOption[], index: number): SubintentOption | null {
  return options.find((o) => o.index === index) ?? null
}
