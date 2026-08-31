import { z } from 'zod';
import type { PlayerFormView } from './forms.ts';
import type { TagView } from './tags.ts';

/**
 * NOT part of the frozen SDK contract — this ships with the server, same as
 * surface.ts. Shared between the surface (player) and agent verticals so both
 * sides of the chat loop agree on one shape.
 */
/**
 * `session_id` is optional and best-effort: the server verifies it belongs to
 * the caller and degrades to a `null` event stamp when it cannot (the session
 * row may not have been uploaded yet). It never gates the send.
 */
export const SendMessageBody = z
  .object({
    body: z.string().max(4000),
    session_id: z.uuid().optional(),
    attachment: z
      .object({
        key: z.string().min(1),
        filename: z.string().min(1).max(255),
        mime_type: z.string().min(1),
        byte_size: z.number().int().positive(),
      })
      .optional(),
    /**
     * Present only when this send is answering a form's `attachment` field —
     * the client-local form progress (see FormCard.tsx) names which field it
     * is answering, since form state is never server-refetched mid-form.
     */
    form_field_key: z.string().min(1).optional(),
  })
  .refine((v) => v.body.trim().length > 0 || v.attachment !== undefined, {
    message: 'body must be non-empty, or an attachment must be provided',
    path: ['body'],
  });

export const SendAgentMessageBody = z
  .object({
    conversation_id: z.uuid(),
    body: z.string().max(4000),
    visibility: z.enum(['public', 'internal']).default('public'),
    attachment: z
      .object({
        key: z.string().min(1),
        filename: z.string().min(1).max(255),
        mime_type: z.string().min(1),
        byte_size: z.number().int().positive(),
      })
      .optional(),
  })
  .refine((v) => v.body.trim().length > 0 || v.attachment !== undefined, {
    message: 'body must be non-empty, or an attachment must be provided',
    path: ['body'],
  });

export const RequestUploadBody = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1),
  byte_size: z.number().int().positive(),
});

export type RequestUploadResponse = {
  key: string;
  upload_url: string;
  expires_at: string;
};

export const MarkPlayerReadBody = z.object({ up_to_seq: z.number().int().nonnegative() });

export const MarkAgentReadBody = z.object({
  conversation_id: z.uuid(),
  up_to_seq: z.number().int().nonnegative(),
});

export type ChatAuthorType = 'player' | 'agent' | 'bot' | 'system';
export type ChatDeliveryState = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
export type ConversationStatusValue =
  'new' | 'bot_active' | 'open' | 'awaiting_player' | 'escalated' | 'resolved' | 'closed';
export type ConversationPriorityValue = 'p1' | 'p2' | 'p3' | 'p4';

export type PlayerMessageView = {
  id: string;
  seq: number;
  author_type: ChatAuthorType;
  /** Display identity resolved from this message's author fields, never the ticket assignee. */
  author_name?: string;
  body: string;
  delivery_state: ChatDeliveryState;
  /** ISO 8601, or null until the other side reads it. Additive — the frozen contract permits new response fields. */
  read_at: string | null;
  created_at: string;
  /**
   * The article this bot answer was written from, or null. Additive — the frozen
   * contract permits new response fields. Clients append their own "Read more"
   * affordance from this; the model is never asked to write a link.
   */
  article_id: string | null;
  /**
   * The signed `url` is added later by the GET read path (Task 5) — this task
   * only inserts the row and returns its non-URL fields on the send response,
   * so `url` is always null until then. Null when the message has no
   * attachment. Same shape as AgentMessageView's, kept symmetric ahead of the
   * webview phase, even though this phase only ever populates it via the
   * agent send path.
   */
  attachment: {
    id: string;
    filename: string;
    mime_type: string;
    byte_size: number;
    url: string | null;
  } | null;
};

/** Same fields as PlayerMessageView plus the two an agent may see and a player may not. */
export type AgentMessageView = PlayerMessageView & {
  author_agent_id: string | null;
  visibility: 'public' | 'internal';
  attachment: {
    id: string;
    filename: string;
    mime_type: string;
    byte_size: number;
    url: string | null;
  } | null;
};

export type PlayerMessagesResponse = {
  conversation_id: string | null;
  messages: PlayerMessageView[];
  status?: ConversationStatusValue;
  /** 'none' when there is no conversation at all. */
  confirm_phase: ConfirmPhaseValue;
  /**
   * The pinned form card's whole state, or null. Always present, never
   * undefined — the same rule confirm_phase follows, so the card has one thing
   * to test. Non-null only when confirm_phase === 'form' and an in_progress
   * submission still exists; a reconnect therefore resumes at the right
   * question with earlier answers intact.
   */
  form: PlayerFormView | null;
};
export type AgentMessagesResponse = { messages: AgentMessageView[] };
export type ClaimResponse = { claimed: boolean };
export type TakeOverResponse = { taken_over: boolean };

export type AgentConversationSummary = {
  id: string;
  player: { external_player_id: string };
  status: ConversationStatusValue;
  confirm_phase: ConfirmPhaseValue;
  last_message_preview: string | null;
  last_message_at: string | null;
  /**
   * Null for unassigned/bot-handled rows. Needed because "agentAssigned" is
   * every agent's queue, not the viewer's own — a row appearing there says
   * nothing about who owns it, so ownership can't be inferred from which
   * queue bucket a row came from.
   */
  assigned_agent_id: string | null;
  /** Null alongside assigned_agent_id when unassigned or bot-handled. */
  assigned_agent_name: string | null;
  priority: ConversationPriorityValue;
  tags: TagView[];
  /** ISO timestamp. */
  created_at: string;
  subintent: { id: string; name: string } | null;
  number: number;
};
export type AgentConversationsResponse = {
  conversations: AgentConversationSummary[];
  nextCursor: string | null;
};

/** The inbox-room payload: id and new status only, never the full row. */
export type ConversationChangedEvent = { conversation_id: string; status: ConversationStatusValue };

/**
 * The read-receipt payload. A high-water sequence number and a timestamp — no
 * bodies, no ids of individual messages. `reader_type` is who *did* the reading,
 * so a client can ignore an echo of its own action.
 */
export type MessageReadEvent = {
  conversation_id: string;
  up_to_seq: number;
  reader_type: 'player' | 'agent';
  read_at: string;
};

/**
 * Which yes/no question, if any, is currently on the player's screen. Mirrors
 * `conversation.confirm_phase` exactly. The player-facing banner renders
 * whenever this is not 'none'; the value only tells the *server* what a tap
 * means, which is why the webview never branches on it.
 */
export type ConfirmPhaseValue =
  | 'none'
  | 'bot_article'
  | 'agent_ask'
  | 'form'
  | 'inactivity_ask'
  | 'player_stated';

/**
 * The banner's Yes/No. No conversation id: the thread is resolved from the
 * player token under RLS, same as every other surface route. `session_id` is
 * best-effort attribution only — verified server-side, degraded to null on any
 * miss, and never a gate.
 */
export const ResolutionAnswerBody = z.object({
  helped: z.boolean(),
  session_id: z.uuid().optional(),
});

export type ResolutionAnswerResponse = {
  confirm_phase: ConfirmPhaseValue;
  status: ConversationStatusValue;
};

export type AskResolvedResponse = { asked: boolean };

export type ForceResolveResponse = { resolved: boolean };

export type EscalateResponse = { escalated: boolean };

export type UnescalateResponse = { unescalated: boolean };

/**
 * "Open a new ticket" from the resolved banner. No conversation id, same as the
 * rest of the surface: the thread being closed is the player's latest, resolved
 * from the token under RLS. `session_id` is best-effort attribution — verified
 * server-side, degraded to null on any miss.
 */
export const NewTicketBody = z.object({ session_id: z.uuid().optional() });

/**
 * Deliberately the same shape `POST /surface/messages` returns when it creates a
 * conversation, so the webview reuses one response handler. `message` is always
 * null here — a new ticket starts empty.
 */
export type NewTicketResponse = {
  conversation_id: string;
  status: ConversationStatusValue;
  message: null;
};

/** Emitted to both conversation rooms on every confirm_phase transition. A
 *  decline posts no message, so this is the only signal either client gets. */
export type ConversationPhaseChangedEvent = {
  conversation_id: string;
  confirm_phase: ConfirmPhaseValue;
};
