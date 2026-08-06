import { Router } from 'express'

// Sub-routers (auth, conversations, messages) are added by later tasks in this
// plan. Kept as its own file, mirroring sdk/router.ts and surface/router.ts, so
// those later tasks each add one `.use()` line rather than editing app.ts.
export const agentRouter = Router()
