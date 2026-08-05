import { Router } from 'express'
import { requirePlayerToken } from '../auth/requirePlayerToken.ts'
import { requireSdkHeaders } from '../auth/requireSdkHeaders.ts'
import { getEnv } from '../env.ts'
import { sessionsStart } from './sessionsStart.ts'
import { sessionsEnd } from './sessionsEnd.ts'
import { incidents } from './incidents.ts'
import { unread } from './unread.ts'

export const sdkRouter = Router()

sdkRouter.use(requirePlayerToken, requireSdkHeaders)

/** Test-only introspection, kept only under NODE_ENV=test for auth.middleware.test.ts. */
if (getEnv().NODE_ENV === 'test') {
  sdkRouter.get('/_whoami', (req, res) => {
    res.json(req.player)
  })
}

sdkRouter.post('/sessions/start', sessionsStart)
sdkRouter.post('/sessions/end', sessionsEnd)
sdkRouter.post('/incidents', incidents)
sdkRouter.get('/unread', unread)
