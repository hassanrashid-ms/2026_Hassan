import { Router } from 'express';
import {
  getMessagesHandler,
  markReadHandler,
  postMessageHandler,
} from '../controllers/messagesController.ts';
import { createRateLimiter } from '../../shared/rateLimit/limiter.ts';
import { playerIdentityKey } from '../../shared/rateLimit/keys.ts';
import { RATE_LIMIT_TIERS } from '../../shared/rateLimit/tiers.ts';

export const messagesRouter = Router();

const writesLimiter = createRateLimiter({
  tier: 'writes',
  keyType: 'identity',
  windowMs: RATE_LIMIT_TIERS.writes.windowMs,
  max: RATE_LIMIT_TIERS.writes.identityMax,
  keyFn: playerIdentityKey,
});

messagesRouter.post('/messages', writesLimiter, postMessageHandler);
messagesRouter.get('/messages', getMessagesHandler);
messagesRouter.post('/messages/read', markReadHandler);
