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
export const botPhase = pgEnum('bot_phase', ['none', 'article_confirm'])
export const resolutionSource = pgEnum('resolution_source', ['bot', 'agent'])
