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

export type BotTurnDecision =
  | { kind: 'noop' }
  | { kind: 'answer'; reply: string; subintentId: string | null; articleId?: string }
  | { kind: 'resolve'; subintentId: string | null }
  | { kind: 'handoff'; reason: HandoffReason; subintentId: string | null }
  | { kind: 'unavailable'; reason: UnavailableReason }

export type BotTurnInput = {
  workspaceId: string
  conversationId: string
  subintentId: string | null
  /** Guards whether confirm_resolution is offered to the model this turn. */
  botPhase: 'none' | 'article_confirm'
  /** Bot-authored messages so far, in this conversation. Drives MAX_BOT_MESSAGES. */
  botMessageCount: number
  /** Null if the player has never sent a message (should not happen once a turn runs). */
  lastPlayerMessageAt: Date | null
  history: PlayerMessageView[]
}

export type BotDecider = (input: BotTurnInput) => Promise<BotTurnDecision>

/**
 * The scaffolding decider, replaced by `toolLoopDecider` in Task 10. Kept here
 * until that task so `botTurns.ts` still compiles between tasks.
 */
export const stubDecider: BotDecider = async () => ({ kind: 'unavailable', reason: 'error' })

/** Only an admin's deliberate choice is silent. Every other reason gets an internal note. */
export const SILENT_UNAVAILABLE_REASONS: ReadonlySet<UnavailableReason> = new Set(['not_provisioned'])
