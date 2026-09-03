import { Router } from 'express';
import { devAgents, devLogin } from '../controllers/authController.ts';
import { createRateLimiter } from '../../shared/rateLimit/limiter.ts';
import { ipKey } from '../../shared/rateLimit/keys.ts';
import { RATE_LIMIT_TIERS } from '../../shared/rateLimit/tiers.ts';

export const authRouter = Router();

const authRateLimiter = createRateLimiter({
  tier: 'auth',
  keyType: 'ip',
  windowMs: RATE_LIMIT_TIERS.auth.windowMs,
  max: RATE_LIMIT_TIERS.auth.ipMax,
  keyFn: ipKey,
});

authRouter.get('/auth/dev-agents', authRateLimiter, devAgents);
authRouter.post('/auth/dev-login', authRateLimiter, devLogin);
