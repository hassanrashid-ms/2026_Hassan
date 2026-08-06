import type { AgentMessageView, PlayerMessageView } from '@support/types'
import type { PostedMessageRow } from './postMessage.ts'

/**
 * Explicit whitelist: returns null for any row whose visibility is not
 * 'public'. The caller (a player-facing service) must filter the nulls out —
 * see docs/decisions/2026-08-04-three-audience-api-structure.md. Never add a
 * visibility filter to the query that fetches these rows; the row is always
 * fetched whole and this function is the only place that decides.
 */
export function toPlayerView(row: PostedMessageRow): PlayerMessageView | null {
  if (row.visibility !== 'public') return null
  return {
    id: row.id,
    seq: row.seq,
    author_type: row.authorType,
    body: row.body,
    delivery_state: row.deliveryState,
    created_at: row.createdAt.toISOString(),
  }
}

/** Permissive: every field, every visibility. Only backend/src/agent/** may import this. */
export function toAgentView(row: PostedMessageRow): AgentMessageView {
  return {
    id: row.id,
    seq: row.seq,
    author_type: row.authorType,
    author_agent_id: row.authorAgentId,
    body: row.body,
    visibility: row.visibility,
    delivery_state: row.deliveryState,
    created_at: row.createdAt.toISOString(),
  }
}
