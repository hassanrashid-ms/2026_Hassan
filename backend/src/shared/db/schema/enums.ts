import { pgEnum } from 'drizzle-orm/pg-core'

// Closed sets, per the schema spec: "an invalid status becomes impossible, not merely untested".
export const agentStatus = pgEnum('agent_status', ['active', 'on_leave', 'deactivated'])
export const workspaceRole = pgEnum('workspace_role', ['agent', 'team_lead', 'admin'])
export const sessionEndReason = pgEnum('session_end_reason', ['client', 'timeout'])
export const conversationStatus = pgEnum('conversation_status', [
  'new',
  'bot_active',
  'open',
  'awaiting_player',
  'escalated',
  'resolved',
  'closed',
])
export const conversationPriority = pgEnum('conversation_priority', ['p1', 'p2', 'p3', 'p4'])
export const classificationSource = pgEnum('classification_source', ['bot', 'agent'])
export const messageAuthorType = pgEnum('message_author_type', ['player', 'agent', 'bot', 'system'])
export const messageVisibility = pgEnum('message_visibility', ['public', 'internal'])
export const messageDeliveryState = pgEnum('message_delivery_state', [
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
])
export const eventActorType = pgEnum('event_actor_type', ['player', 'agent', 'bot', 'system'])
export const declaredFieldType = pgEnum('declared_field_type', ['string', 'number', 'boolean', 'timestamp'])
export const articleState = pgEnum('article_state', ['draft', 'published', 'archived'])
// `bot_article` is set by the bot's answer_from_article, `agent_ask` by
// POST /agent/conversations/:id/ask-resolved — both mean a yes/no question is on
// the player's screen. `form` means the pinned form card is up instead: not a
// yes/no, and the reason the webview must branch on the value rather than test
// it against 'none'. See docs/specs/2026-08-17-player-side-forms-design.md §2.4.
export const confirmPhase = pgEnum('confirm_phase', ['none', 'bot_article', 'agent_ask', 'form'])
export const resolutionSource = pgEnum('resolution_source', ['bot', 'agent'])

/**
 * Seven declared, six usable. `time` is declared and unused, must not be offered by the form-builder.
 * `attachment` is declared-but-inert until the `attachment` table exists.
 * The order mirrors FORM_FIELD_TYPES in @support/types exactly.
 */
export const formFieldType = pgEnum('form_field_type', [
  'short_text',
  'long_text',
  'number',
  'date',
  'time',
  'choice',
  'attachment',
])

/**
 * `in_progress` is the only status with a null `submitted_at`.
 * The other three are TERMINAL: `completed` = every field answered, `partial` = some,
 * `skipped` = zero answers. Derived from answer rows at terminate time (slice 2).
 */
export const formStatus = pgEnum('form_status', ['in_progress', 'completed', 'partial', 'skipped'])
