import { Router } from 'express';
import { requirePlayerToken } from '../shared/middleware/requirePlayerToken.ts';
import { requireSdkHeaders } from '../shared/middleware/requireSdkHeaders.ts';
import { getEnv } from '../env.ts';
import { sessionsRouter } from './routers/sessionsRouter.ts';
import { incidentsRouter } from './routers/incidentsRouter.ts';
import { unreadRouter } from './routers/unreadRouter.ts';
import { createRateLimiter } from '../shared/rateLimit/limiter.ts';
import { playerIdentityKey } from '../shared/rateLimit/keys.ts';
import { RATE_LIMIT_TIERS } from '../shared/rateLimit/tiers.ts';

export const sdkRouter = Router();
sdkRouter.use(requirePlayerToken, requireSdkHeaders);
sdkRouter.use(
  createRateLimiter({
    tier: 'reads',
    keyType: 'identity',
    windowMs: RATE_LIMIT_TIERS.reads.windowMs,
    max: RATE_LIMIT_TIERS.reads.identityMax,
    keyFn: playerIdentityKey,
  }),
);

/** Test-only introspection, kept only under NODE_ENV=test for auth.middleware.test.ts. */
if (getEnv().NODE_ENV === 'test') {
  sdkRouter.get('/_whoami', (req, res) => {
    res.json(req.player);
  });
}

sdkRouter.use(sessionsRouter);
sdkRouter.use(incidentsRouter);
sdkRouter.use(unreadRouter);
