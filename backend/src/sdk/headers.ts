import type { PlayerContext } from '../shared/middleware/requirePlayerToken.ts'

/**
 * The four SDK headers, shaped for an event payload. Never include the token.
 */
export function headerPayload(player: PlayerContext): Record<string, unknown> {
  return {
    idempotency_key: player.idempotencyKey,
    sdk_version: player.sdkVersion,
    header_client_version: player.clientVersion,
  }
}
