// backend/src/domain/bot/botTurn.ts

/**
 * Both members are spec 4's to produce (a real decider never runs here). Declared
 * here because the outcome they feed — `applyBotTurn`'s `handoff` shape — is built
 * in this slice, so a type that grew in the slice that consumes it would make that
 * slice a control-flow change rather than a one-function swap.
 */
export type HandoffReason = 'model' | 'turn_cap'

export type UnavailableReason =
  | 'not_provisioned' // admin has the bot switched off
  | 'not_implemented' // no decider exists yet — removed once a real one lands
  | 'error' // a turn failed after its retries were exhausted
  | 'timeout' // reserved for the tool-calling decider
  | 'invalid_response' // reserved for the tool-calling decider

export type BotTurnDecision =
  | { kind: 'noop' }
  | { kind: 'answer'; reply: string; subintentId: string }
  | { kind: 'handoff'; reason: HandoffReason; subintentId: string | null }
  | { kind: 'unavailable'; reason: UnavailableReason }

export type BotTurnInput = {
  workspaceId: string
  conversationId: string
}

export type BotDecider = (input: BotTurnInput) => Promise<BotTurnDecision>

/**
 * The scaffolding decider. `'not_implemented'` exists so a real decider's arrival
 * is a type error at this exact reference, forcing its removal rather than leaving
 * it reachable in production by accident.
 */
export const stubDecider: BotDecider = async () => ({ kind: 'unavailable', reason: 'not_implemented' })

/**
 * Two `unavailable` reasons are not incidents: an admin deliberately switched the
 * bot off, or no decider has been built yet. Every other reason gets an internal
 * note — see `applyBotTurn`.
 */
export const SILENT_UNAVAILABLE_REASONS: ReadonlySet<UnavailableReason> = new Set(['not_provisioned', 'not_implemented'])
