import { Router } from 'express';
import { newTicketHandler } from '../controllers/newTicketController.ts';
import { createRateLimiter } from '../../shared/rateLimit/limiter.ts';
import { playerIdentityKey } from '../../shared/rateLimit/keys.ts';
import { RATE_LIMIT_TIERS } from '../../shared/rateLimit/tiers.ts';

export const newTicketRouter = Router();

const writesLimiter = createRateLimiter({
  tier: 'writes',
  keyType: 'identity',
  windowMs: RATE_LIMIT_TIERS.writes.windowMs,
  max: RATE_LIMIT_TIERS.writes.identityMax,
  keyFn: playerIdentityKey,
});

newTicketRouter.post('/new-ticket', writesLimiter, newTicketHandler);
