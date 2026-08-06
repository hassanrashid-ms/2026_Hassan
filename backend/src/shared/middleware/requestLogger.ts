import type { RequestHandler } from 'express'
import { getEnv } from '../../env.ts'
import { logger } from '../logging/logger.ts'

/**
 * `none` skips even attaching the `finish` listener — this is on the hot path of
 * every request, so a disabled logger should cost nothing beyond a level check.
 */
export const requestLoggerMiddleware: RequestHandler = (req, res, next) => {
  const level = getEnv().LOG_LEVEL
  if (level === 'none') {
    next()
    return
  }

  const startedAt = performance.now()
  let responseBody: unknown

  if (level === 'verbose') {
    logger.info('http', `${req.method} ${req.path} ▶ request`, {
      headers: req.headers,
      query: req.query,
      body: req.body,
    })

    // Capture the outgoing body without altering it, so it can be logged once the
    // response actually finishes (below) instead of guessing from what was sent.
    const originalJson = res.json.bind(res)
    res.json = (body: unknown) => {
      responseBody = body
      return originalJson(body)
    }
  }

  res.on('finish', () => {
    const durationMs = Math.round(performance.now() - startedAt)
    if (level === 'verbose') {
      logger.info('http', `${req.method} ${req.path} -> ${res.statusCode} (${durationMs}ms)`, {
        responseHeaders: res.getHeaders(),
        responseBody,
      })
    } else {
      logger.info('http', `${req.method} ${req.path} -> ${res.statusCode} (${durationMs}ms)`)
    }
  })

  next()
}
