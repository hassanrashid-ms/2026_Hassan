import type { RequestHandler } from 'express'
import { SDK_HEADERS } from '@support/types'
import { sendError } from '../../errors.ts'

const normalise = (value: string | undefined): string | null => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

/**
 * `/sdk/*` only. The workspace slug in the header is NEVER used to scope a query —
 * it is cross-checked against the token claim so a build pointed at the wrong game
 * fails loudly instead of writing somewhere it shouldn't.
 *
 * 403 rather than 404 here: this is a header-versus-claim contradiction, not an
 * invisible row. The "expect 404, not 403" rule applies to RLS-hidden data.
 */
export const requireSdkHeaders: RequestHandler = (req, res, next) => {
  const player = req.player
  if (!player) {
    sendError(res, 401, 'unauthorized', 'Player token is required.')
    return
  }

  const claimed = normalise(req.header(SDK_HEADERS.workspace))
  if (!claimed) {
    sendError(res, 403, 'workspace_mismatch', `The ${SDK_HEADERS.workspace} header is required.`)
    return
  }
  if (claimed.toLowerCase() !== player.workspaceSlug.toLowerCase()) {
    sendError(res, 403, 'workspace_mismatch', 'Workspace header does not match the authenticated workspace.')
    return
  }

  // Logged, never load-bearing: the SDK's Outbox retries, so duplicate delivery is
  // expected and idempotency is handled by the client-generated primary key.
  player.idempotencyKey = normalise(req.header(SDK_HEADERS.idempotencyKey))
  player.sdkVersion = normalise(req.header(SDK_HEADERS.sdkVersion))
  player.clientVersion = normalise(req.header(SDK_HEADERS.clientVersion))
  next()
}
