import { Router } from 'express';
import {
  formAnswerHandler,
  formSkipHandler,
  formSubmitHandler,
} from '../controllers/formController.ts';
import { createRateLimiter } from '../../shared/rateLimit/limiter.ts';
import { playerIdentityKey } from '../../shared/rateLimit/keys.ts';
import { RATE_LIMIT_TIERS } from '../../shared/rateLimit/tiers.ts';

export const formRouter = Router();

const writesLimiter = createRateLimiter({
  tier: 'writes',
  keyType: 'identity',
  windowMs: RATE_LIMIT_TIERS.writes.windowMs,
  max: RATE_LIMIT_TIERS.writes.identityMax,
  keyFn: playerIdentityKey,
});

formRouter.post('/form/answer', writesLimiter, formAnswerHandler);
formRouter.post('/form/submit', writesLimiter, formSubmitHandler);
formRouter.post('/form/skip', writesLimiter, formSkipHandler);
