import { Router, type Router as RouterType } from 'express'
import { requirePlayerToken } from '../auth/requirePlayerToken.ts'
import { requireSdkHeaders } from '../auth/requireSdkHeaders.ts'
import { sessionsStart } from './sessionsStart.ts'
import { sessionsEnd } from './sessionsEnd.ts'

export const sdkRouter: RouterType = Router()

sdkRouter.use(requirePlayerToken, requireSdkHeaders)

/** Test-only introspection. Delete once Tasks 9-12 have populated this router. */
sdkRouter.get('/_whoami', (req, res) => {
  res.json(req.player)
})

sdkRouter.post('/sessions/start', sessionsStart)
sdkRouter.post('/sessions/end', sessionsEnd)

// Task 11 → POST /incidents
// Task 12 → GET  /unread
