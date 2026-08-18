import type { Server } from 'socket.io'
import { getIo } from './socketServer.ts'
import { logger } from '../logging/logger.ts'

/**
 * `getIo()` throws when no socket server exists — correct for a request path,
 * wrong for a background job, which must still commit its work in a worker
 * process (or a test) that never started one. Same shape as
 * domain/forms/emitFormTerminated.ts, lifted out so both jobs share it.
 */
export function tryIo(tag: string, meta?: Record<string, unknown>): Server | null {
  try {
    return getIo()
  } catch (err) {
    logger.warn(tag, 'skipping realtime emit: socket server not initialised', {
      ...meta,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
