import type { ConversationStatusValue } from './chat.ts'
import type { FormFieldType, FormSubmissionStatus } from './forms.ts'
import type { DeclaredFieldType } from './player-state.ts'
import type { TagView } from './tags.ts'

/** The resolving side. Mirrors the `resolution_source` pg enum. */
export type ResolutionSourceValue = 'bot' | 'agent' | 'player_confirmed' | 'timed_out'

/**
 * The header row for one conversation, fetched by id.
 *
 * This exists because Inbox.tsx finds the selected conversation by searching
 * the `unassigned` and `mine` lists. An older ticket — resolved, owned by
 * another agent — is in neither list and never will be, so opening one by URL
 * yields no header data at all.
 */
export type AgentConversationDetail = {
  id: string
  number: number
  player: { id: string; external_player_id: string }
  status: ConversationStatusValue
  subintent: { intent_name: string; subintent_name: string } | null
  assigned_agent: { id: string; display_name: string } | null
  resolution_source: ResolutionSourceValue | null
  /**
   * The assigned agent's display name when `resolution_source` is 'agent',
   * null otherwise. There is no resolved_by column — this is what the schema
   * knows.
   */
  resolved_by_agent_name: string | null
  created_at: string
}

/**
 * Four distinguishable cases, not one nullable object. A single nullable field
 * would collapse "the SDK never delivered a session" and "the game had nothing
 * to say" into one blank panel, and those are different bugs. None of the four
 * is an error: all return 200.
 */
export type AgentPlayerStateView =
  | { status: 'no_session' }
  | { status: 'not_captured' }
  | { status: 'missing' }
  | {
      status: 'captured'
      declared: { key: string; label: string; type: DeclaredFieldType; value: unknown }[]
      /** PII by default. Returned in full, not role-gated; the frontend renders it collapsed. */
      raw: Record<string, unknown>
      degraded_reason: string | null
      captured_at: string
    }

/** One row of the player's ticket history. No message bodies, ever. */
export type AgentTicketSummary = {
  id: string
  number: number
  created_at: string
  status: ConversationStatusValue
  subintent: { intent_name: string; subintent_name: string } | null
  resolution_source: ResolutionSourceValue | null
  resolved_by_agent_name: string | null
  reopen_count: number
}

/**
 * One row of the form section. Every field in the submission's version gets one,
 * answered or not: a gap is a row, never an omission, because the agent has to
 * be able to tell "the player did not answer this" from "this was never asked".
 */
export type AgentFormFieldView = {
  key: string
  /** From the submission's snapshotted form_version, never the current one. */
  label: string
  position: number
  /**
   * From the answer's own snapshotted field_type when answered — the value is
   * interpretable without resolving the version, which is why that column
   * exists. From the version's declared type when unanswered.
   */
  field_type: FormFieldType
  /** null when the field has no answer row. Read `answered`, not this. */
  value: unknown
  answered: boolean
}

/**
 * The form section of the context rail. `null` on the response when this
 * conversation was never offered a form — the frontend omits the section
 * entirely rather than opening onto nothing, the same precedent `raw` sets.
 */
export type AgentFormView = {
  form_name: string
  /** The submission's snapshot. The section header names it: "Purchase receipt · v1". */
  form_version: number
  status: FormSubmissionStatus
  /** The version's field count. The denominator in "2 of 4". */
  field_count: number
  /** Distinct answered keys that are in the version. Never exceeds field_count. */
  answered_count: number
  /** In `position` order, answered and unanswered alike. */
  fields: AgentFormFieldView[]
}

/**
 * The whole context rail in one payload — one endpoint rather than two, because
 * the rail is one thing, always fetched together, and its two halves have the
 * same cache lifetime.
 */
export type AgentConversationContextResponse = {
  player_state: AgentPlayerStateView
  /**
   * Includes the current conversation, so the rail can highlight the row the
   * agent just clicked instead of dropping it. Newest first, capped at 20 rows
   * counting that one. `summary.total_tickets` still excludes it.
   */
  tickets: AgentTicketSummary[]
  summary: {
    /** Excludes the current conversation. */
    total_tickets: number
    /** Reopens summed across that same population, not just the returned page. */
    total_reopened: number
    /** player.first_seen_at, ISO 8601. */
    first_contact_at: string
  }
  /**
   * null when this conversation has no form submission. Not an error and not an
   * empty object: the rail omits the section entirely.
   */
  form: AgentFormView | null
  /** Currently-attached (non-removed) tags for this conversation. */
  tags: TagView[]
}
