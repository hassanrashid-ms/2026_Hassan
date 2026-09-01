import { pgEnum } from 'drizzle-orm/pg-core';

// Closed sets, per the schema spec: "an invalid status becomes impossible, not merely untested".
export const agentStatus = pgEnum('agent_status', ['active', 'on_leave', 'deactivated', 'invited']);
export const workspaceRole = pgEnum('workspace_role', ['agent', 'team_lead']);
export const sessionEndReason = pgEnum('session_end_reason', ['client', 'timeout']);
export const conversationStatus = pgEnum('conversation_status', [
  'new',
  'bot_active',
  'open',
  'awaiting_player',
  'escalated',
  'resolved',
  'closed',
]);
export const conversationPriority = pgEnum('conversation_priority', ['p1', 'p2', 'p3', 'p4']);
export const classificationSource = pgEnum('classification_source', ['bot', 'agent']);
export const messageAuthorType = pgEnum('message_author_type', [
  'player',
  'agent',
  'bot',
  'system',
]);
export const messageVisibility = pgEnum('message_visibility', ['public', 'internal']);
export const messageDeliveryState = pgEnum('message_delivery_state', [
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
]);
export const eventActorType = pgEnum('event_actor_type', ['player', 'agent', 'bot', 'system']);
export const declaredFieldType = pgEnum('declared_field_type', [
  'string',
  'number',
  'boolean',
  'timestamp',
]);
export const declaredFieldStatus = pgEnum('declared_field_status', [
  'active',
  'inactive',
  'archived',
]);
export const articleState = pgEnum('article_state', ['draft', 'published', 'archived']);
export const articleVersionStatus = pgEnum('article_version_status', [
  'draft',
  'published',
  'discarded',
]);
// `bot_article` is set by the bot's answer_from_article, `agent_ask` by
// POST /agent/conversations/:id/ask-resolved, `inactivity_ask` by the inactivity
// clock's stage 1, `player_stated` by the bot's player_declared_resolved tool —
// all four mean a yes/no question is on the player's screen. The clock gets its
// own value rather than reusing `agent_ask` so the answer can be attributed to
// the right resolution kind: a Yes on `agent_ask` is 'agent', a Yes on
// `inactivity_ask` is 'player_confirmed', a Yes on `player_stated` is
// 'player_stated' — the player declared it themselves, unprompted by either the
// bot's own article-offer or a human/clock asking. `form` means the pinned form
// card is up instead: not a yes/no, and the reason the webview must branch on
// the value rather than test it against 'none'.
// See docs/specs/2026-08-17-player-side-forms-design.md §2.4 and
// docs/specs/2026-08-18-inactivity-clock-and-auto-close-design.md §2.
export const confirmPhase = pgEnum('confirm_phase', [
  'none',
  'bot_article',
  'agent_ask',
  'form',
  'inactivity_ask',
  'player_stated',
]);
/**
 * Also the type of `resolution_cycle.resolution_kind`, deliberately one
 * vocabulary rather than two enums that could drift. `player_confirmed` (the
 * player answered Yes to the clock's ask), `player_stated` (the player
 * declared it resolved unprompted, then confirmed the bot's double-check) and
 * `timed_out` (nobody answered) are separate values because metrics must
 * report them separately — conflating `player_stated` into `player_confirmed`
 * would count "player asked us to close it" the same as "player let a 24h
 * silence clock resolve it for them", which are opposite signals about how
 * engaged the player was. `admin_forced` (an admin used force-resolve to
 * bypass the ask/confirm cycle) is likewise its own value rather than
 * reusing 'agent' — see resolutionService.ts's `forceResolve` for why
 * conflating the two would corrupt resolution-rate metrics.
 */
export const resolutionSource = pgEnum('resolution_source', [
  'bot',
  'agent',
  'player_confirmed',
  'timed_out',
  'player_stated',
  'admin_forced',
]);

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
]);

/**
 * `in_progress` is the only status with a null `submitted_at`.
 * The other three are TERMINAL: `completed` = every field answered, `partial` = some,
 * `skipped` = zero answers. Derived from answer rows at terminate time (slice 2).
 */
export const formStatus = pgEnum('form_status', ['in_progress', 'completed', 'partial', 'skipped']);
