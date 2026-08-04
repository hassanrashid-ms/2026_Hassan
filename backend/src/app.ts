import cors from 'cors'
import express from 'express'
import { getEnv } from './env.ts'
import { errorMiddleware } from './errors.ts'
import { playerTokenRouter } from './auth/playerTokenRoute.ts'
import { sdkRouter } from './sdk/router.ts'

export function createApp(): express.Express {
  const app = express()
  app.disable('x-powered-by')

  // 64 KB: generous for the largest plausible snapshot, small enough that an
  // oversized body is refused rather than truncated. Nothing inside an ACCEPTED
  // body is ever dropped — "nothing the game sends is ever dropped".
  app.use(express.json({ limit: '64kb' }))

  // The SDK is not a browser and needs no CORS. The web surface does: it is served
  // from webviewBaseUrl and calls apiBaseUrl.
  app.use(
    cors({
      origin: getEnv().SURFACE_ORIGINS,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  )

  app.get('/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.use('/auth', playerTokenRouter)
  app.use('/sdk', sdkRouter)
  // Task 14 mounts /surface.

  app.use(errorMiddleware)
  return app
}
