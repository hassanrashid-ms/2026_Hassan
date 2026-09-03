import { Router } from 'express';
import { sessionsEnd, sessionsStart } from '../controllers/sessionsController.ts';
import { createRateLimiter } from '../../shared/rateLimit/limiter.ts';
import { playerIdentityKey } from '../../shared/rateLimit/keys.ts';
import { RATE_LIMIT_TIERS } from '../../shared/rateLimit/tiers.ts';

export const sessionsRouter = Router();

const sessionsUploadsLimiter = createRateLimiter({
  tier: 'sessionsUploads',
  keyType: 'identity',
  windowMs: RATE_LIMIT_TIERS.sessionsUploads.windowMs,
  max: RATE_LIMIT_TIERS.sessionsUploads.identityMax,
  keyFn: playerIdentityKey,
});

sessionsRouter.post('/sessions/start', sessionsUploadsLimiter, sessionsStart);
sessionsRouter.post('/sessions/end', sessionsEnd);
