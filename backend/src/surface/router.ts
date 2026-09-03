import { Router } from 'express';
import { requirePlayerToken } from '../shared/middleware/requirePlayerToken.ts';
import { articleReadRouter } from './routers/articleReadRouter.ts';
import { articlesRouter } from './routers/articlesRouter.ts';
import { bootstrapRouter } from './routers/bootstrapRouter.ts';
import { formRouter } from './routers/formRouter.ts';
import { intentsRouter } from './routers/intentsRouter.ts';
import { messagesRouter } from './routers/messagesRouter.ts';
import { newTicketRouter } from './routers/newTicketRouter.ts';
import { resolutionRouter } from './routers/resolutionRouter.ts';
import { uploadsRouter } from './routers/uploadsRouter.ts';
import { createRateLimiter } from '../shared/rateLimit/limiter.ts';
import { playerIdentityKey } from '../shared/rateLimit/keys.ts';
import { RATE_LIMIT_TIERS } from '../shared/rateLimit/tiers.ts';

export const surfaceRouter = Router();

// requirePlayerToken only. A browser page has no reason to know the workspace slug,
// so requireSdkHeaders is deliberately absent here.
surfaceRouter.use(requirePlayerToken);
surfaceRouter.use(
  createRateLimiter({
    tier: 'reads',
    keyType: 'identity',
    windowMs: RATE_LIMIT_TIERS.reads.windowMs,
    max: RATE_LIMIT_TIERS.reads.identityMax,
    keyFn: playerIdentityKey,
  }),
);

surfaceRouter.use(bootstrapRouter);
surfaceRouter.use(articleReadRouter);
surfaceRouter.use(articlesRouter);
surfaceRouter.use(formRouter);
surfaceRouter.use(intentsRouter);
surfaceRouter.use(messagesRouter);
surfaceRouter.use(newTicketRouter);
surfaceRouter.use(resolutionRouter);
surfaceRouter.use(uploadsRouter);
