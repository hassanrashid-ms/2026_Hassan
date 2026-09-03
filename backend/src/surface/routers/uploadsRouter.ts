import { Router } from 'express';
import { deleteUploadHandler, postUploadRequestHandler } from '../controllers/uploadsController.ts';
import { createRateLimiter } from '../../shared/rateLimit/limiter.ts';
import { playerIdentityKey } from '../../shared/rateLimit/keys.ts';
import { RATE_LIMIT_TIERS } from '../../shared/rateLimit/tiers.ts';

export const uploadsRouter = Router();

const sessionsUploadsLimiter = createRateLimiter({
  tier: 'sessionsUploads',
  keyType: 'identity',
  windowMs: RATE_LIMIT_TIERS.sessionsUploads.windowMs,
  max: RATE_LIMIT_TIERS.sessionsUploads.identityMax,
  keyFn: playerIdentityKey,
});

uploadsRouter.post('/uploads', sessionsUploadsLimiter, postUploadRequestHandler);
// :key contains slashes (pending/{ws}/{player}/{uuid}.ext) — Express 5 needs the
// wildcard form to capture the rest of the path in one param.
uploadsRouter.delete(
  '/uploads/{*key}',
  (req, res, next) => {
    const raw = req.params.key;
    req.params.key = Array.isArray(raw) ? raw.join('/') : (raw ?? '');
    next();
  },
  deleteUploadHandler,
);
