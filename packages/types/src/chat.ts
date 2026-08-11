import { z } from 'zod'

/**
 * NOT part of the frozen SDK contract — this ships with the server, same as
 * surface.ts. Shared between the surface (player) and agent verticals so both
 * sides of the chat loop agree on one shape.
 */
export const SendMessageBody = z.object({ body: z.string().min(1).max(4000) })

export const SendAgentMessageBody = z.object({
  conversation_id: z.uuid(),
  body: z.string().min(1).max(4000),
  visibility: z.enum(['public', 'internal']).default('public'),
})

export const MarkPlayerReadBody = z.object({ up_to_seq: z.number().int().nonnegative() })

export const MarkAgentReadBody = z.object({
  conversation_id: z.uuid(),
  up_to_seq: z.number().int().nonnegative(),
})

export type ChatAuthorType = 'player' | 'agent' | 'bot' | 'system'
export type ChatDeliveryState = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
export type ConversationStatusValue =
  | 'new'
  | 'bot_active'
  | 'open'
  | 'awaiting_player'
  | 'escalated'
  | 'resolved'
  | 'closed'

export type PlayerMessageView = {
  id: string
  seq: number
  author_type: ChatAuthorType
  body: string
  delivery_state: ChatDeliveryState
  /** ISO 8601, or null until the other side reads it. Additive — the frozen contract permits new response fields. */
  read_at: string | null
  created_at: string
}

/** Same fields as PlayerMessageView plus the two an agent may see and a player may not. */
export type AgentMessageView = PlayerMessageView & {
  author_agent_id: string | null
  visibility: 'public' | 'internal'
}

export type PlayerMessagesResponse = {
  conversation_id: string | null
  messages: PlayerMessageView[]
  status?: ConversationStatusValue
}
export type AgentMessagesResponse = { messages: AgentMessageView[] }
export type ClaimResponse = { claimed: boolean }

export type AgentConversationSummary = {
  id: string
  player: { external_player_id: string }
  status: ConversationStatusValue
  last_message_preview: string | null
  last_message_at: string | null
}
export type AgentConversationsResponse = { conversations: AgentConversationSummary[] }

/** The inbox-room payload: id and new status only, never the full row. */
export type ConversationChangedEvent = { conversation_id: string; status: ConversationStatusValue }

/**
 * The read-receipt payload. A high-water sequence number and a timestamp — no
 * bodies, no ids of individual messages. `reader_type` is who *did* the reading,
 * so a client can ignore an echo of its own action.
 */
export type MessageReadEvent = {
  conversation_id: string
  up_to_seq: number
  reader_type: 'player' | 'agent'
  read_at: string
}
