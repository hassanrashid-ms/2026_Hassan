import type { ErrorRequestHandler, Response } from 'express'
import { InvalidWorkspaceId } from './shared/db/withWorkspace.ts'
import { logger } from './shared/logging/logger.ts'

export type ErrorCode =
  | 'unauthorized'
  | 'workspace_mismatch'
  | 'forbidden'
  | 'not_found'
  | 'unparseable_body'
  | 'invalid_request'
  | 'internal'

export function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } })
}

/**
 * Express 5 forwards a rejected promise from a handler here automatically, so no
 * asyncHandler wrapper is needed anywhere in this codebase.
 *
 * Never `console.error(error)` on the whole object. `InvalidWorkspaceId`
 * (src/shared/db/withWorkspace.ts) deliberately keeps the rejected value off its
 * `.message` and only on an enumerable `workspaceId` field, so that an
 * attacker-supplied string can be inspected by code but never lands in a log by
 * accident. Logging the object (or spreading it into a template) would
 * re-serialise that field and undo the guard. Log `error.name` / `error.message`
 * (and a stack, which is not attacker-controlled) instead.
 */
export const errorMiddleware: ErrorRequestHandler = (error, _req, res, _next) => {
  // express.json() throws this for malformed JSON and for a body over the limit.
  if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.parse.failed') {
    sendError(res, 400, 'unparseable_body', 'Request body is not valid JSON.')
    return
  }
  if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
    sendError(res, 413, 'unparseable_body', 'Request body is too large.')
    return
  }

  // Mapped to a generic 400 without ever reading `.workspaceId` — that field
  // exists for code to inspect, not for a response or a log line to echo.
  if (error instanceof InvalidWorkspaceId) {
    logger.error('error', `${error.name}: ${error.message}`)
    sendError(res, 400, 'invalid_request', 'Invalid workspace id.')
    return
  }

  if (error instanceof Error) {
    logger.error('error', `${error.name}: ${error.message}`, { stack: error.stack })
  } else {
    logger.error('error', 'non-Error thrown', { type: typeof error })
  }
  sendError(res, 500, 'internal', 'Something went wrong.')
}
