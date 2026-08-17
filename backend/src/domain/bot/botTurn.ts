// backend/src/domain/bot/botTurn.ts

import type { PlayerMessageView } from '@support/types'

/**
 * Model-chosen (`asked_for_person`, `no_article`, `sensitive` — passed directly
 * to the `handoff` tool), code-derived from a model choice (`article_rejected`,
 * from `confirm_resolution(false)`), or forced by a budget with no model call
 * involved at all (`unsure`, `turn_cap`).
 */
export type HandoffReason = 'asked_for_person' | 'article_rejected' | 'no_article' | 'sensitive' | 'unsure' | 'turn_cap'

export type UnavailableReason =
  | 'not_provisioned' // admin has the bot switched off
  | 'error' // a turn failed after its retries were exhausted
  | 'timeout' // callModel exceeded its 15s budget
  | 'invalid_response' // a refusal or an unparseable tool argument — not retried

/**
 * One `search_articles` call the model made while deciding this turn, with the
 * results it was shown. Titles are snapshotted here rather than resolved from
 * `article_id` at read time, so the record of what the bot was offered survives
 * a later rename or an article being archived — the `bot_article_offered`
 * precedent, and the reason `appendEvent` forbids live pointers in payloads.
 */
export type BotSearchRecord = {
  query: string
  results: { id: string; title: string }[]
}

type BotTurnOutcome =
  | { kind: 'noop' }
  | { kind: 'answer'; reply: string; subintentId: string | null; articleId?: string }
  | { kind: 'resolve'; subintentId: string | null }
  | { kind: 'handoff'; reason: HandoffReason; subintentId: string | null }
  | { kind: 'unavailable'; reason: UnavailableReason }

/**
 * `searches` rides on the decision rather than being written by the decider,
 * because the decider never writes — `applyBotTurn` is the single transactional
 * writer of a turn's outcome, and retrieval telemetry has to land in the same
 * transaction as the outcome it explains or the two can disagree.
 *
 * Intersected across the union rather than repeated on each member so a new
 * outcome kind cannot forget to carry it. Narrowing on `kind` is unaffected.
 * Optional because the budget-forced and error-fallback decisions are built
 * without ever calling a model — an absent field means "no search ran", which
 * is itself the answer to "did retrieval happen?".
 */
export type BotTurnDecision = BotTurnOutcome & { searches?: BotSearchRecord[] }

export type BotTurnInput = {
  workspaceId: string
  conversationId: string
  subintentId: string | null
  /** Guards whether confirm_resolution is offered to the model this turn. */
  confirmPhase: 'none' | 'bot_article' | 'agent_ask'
  /** Bot-authored messages so far, in this conversation. Drives MAX_BOT_MESSAGES. */
  botMessageCount: number
  /** Null if the player has never sent a message (should not happen once a turn runs). */
  lastPlayerMessageAt: Date | null
  history: PlayerMessageView[]
}

export type BotDecider = (input: BotTurnInput) => Promise<BotTurnDecision>

/** Only an admin's deliberate choice is silent. Every other reason gets an internal note. */
export const SILENT_UNAVAILABLE_REASONS: ReadonlySet<UnavailableReason> = new Set(['not_provisioned'])
