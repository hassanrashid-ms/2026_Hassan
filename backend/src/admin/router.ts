import { Router } from 'express';
import { requireAgentSession } from '../shared/middleware/requireAgentSession.ts';
import { requireAdminAccess } from '../shared/middleware/requireAdminAccess.ts';
import { workspacesRouter } from './routers/workspacesRouter.ts';
import { agentsRouter } from './routers/agentsRouter.ts';
import { createRateLimiter } from '../shared/rateLimit/limiter.ts';
import { agentIdentityKey } from '../shared/rateLimit/keys.ts';
import { RATE_LIMIT_TIERS } from '../shared/rateLimit/tiers.ts';

export const adminRouter = Router();

adminRouter.use(requireAgentSession);
adminRouter.use(requireAdminAccess);
adminRouter.use(
  createRateLimiter({
    tier: 'reads',
    keyType: 'identity',
    windowMs: RATE_LIMIT_TIERS.reads.windowMs,
    max: RATE_LIMIT_TIERS.reads.identityMax,
    keyFn: agentIdentityKey,
  }),
);
adminRouter.use(workspacesRouter);
adminRouter.use(agentsRouter);
