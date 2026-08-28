import type { AgentMessageView, PlayerMessageView } from '@support/types';
import type { PostedMessageRow } from './postMessage.ts';

function authorName(row: PostedMessageRow): string {
  if (row.authorType === 'bot') return 'Support Bot';
  if (row.authorType === 'system') return 'System';
  if (row.authorType === 'agent') return row.authorAgentName ?? 'Agent';
  return row.authorPlayerName ?? 'Player';
}

/**
 * Non-URL attachment fields only — signing is async and these serializers are
 * synchronous, so `url` is always emitted as `null` here and the caller (the
 * service) fills it in afterward, or leaves it `null` if signing fails.
 */
function toAttachmentFields(row: PostedMessageRow) {
  if (!row.attachmentId) return null;
  return {
    id: row.attachmentId,
    filename: row.attachmentFilename ?? '',
    mime_type: row.attachmentMimeType ?? '',
    byte_size: row.attachmentByteSize ?? 0,
    url: null as string | null,
  };
}

/**
 * Explicit whitelist: returns null for any row whose visibility is not
 * 'public'. The caller (a player-facing service) must filter the nulls out —
 * see docs/decisions/2026-08-04-three-audience-api-structure.md. Never add a
 * visibility filter to the query that fetches these rows; the row is always
 * fetched whole and this function is the only place that decides.
 */
export function toPlayerView(row: PostedMessageRow): PlayerMessageView | null {
  if (row.visibility !== 'public') return null;
  return {
    id: row.id,
    seq: row.seq,
    author_type: row.authorType,
    author_name: authorName(row),
    body: row.body,
    delivery_state: row.deliveryState,
    read_at: row.readAt ? row.readAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    article_id: row.articleId,
    attachment: toAttachmentFields(row),
  };
}

/** Permissive: every field, every visibility. Only backend/src/agent/** may import this. */
export function toAgentView(row: PostedMessageRow): AgentMessageView {
  return {
    id: row.id,
    seq: row.seq,
    author_type: row.authorType,
    author_name: authorName(row),
    author_agent_id: row.authorAgentId,
    body: row.body,
    visibility: row.visibility,
    delivery_state: row.deliveryState,
    read_at: row.readAt ? row.readAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    article_id: row.articleId,
    // sendAgentMessage overrides this with the real row when the send
    // included an attachment (postMessage's insert result never carries
    // attachment fields); every other call site relies on this join-derived
    // value, present only when the row came from a message-list join.
    attachment: toAttachmentFields(row),
  };
}
