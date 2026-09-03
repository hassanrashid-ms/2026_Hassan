import type { Request, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { sendError } from '../../errors.ts';
import { logger } from '../logging/logger.ts';
import { rateLimitRedisClient } from './rateLimitRedis.ts';
import { recordRateLimitHit } from './recordRateLimitHit.ts';

export function createRateLimiter(options: {
  tier: string;
  keyType: 'ip' | 'identity';
  windowMs: number;
  max: number;
  keyFn: (req: Request) => string;
}): RequestHandler {
  const { tier, keyType, windowMs, max, keyFn } = options;

  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true,
    keyGenerator: keyFn,
    store: new RedisStore({
      prefix: `rl:${tier}:${keyType}:`,
      sendCommand: async (...args: string[]) => {
        try {
          return await rateLimitRedisClient().call(...args);
        } catch (error) {
          logger.warn('rate_limit', 'redis store error, failing open', {
            tier,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    }),
    handler: (req, res) => {
      const key = keyFn(req);
      logger.warn('rate_limit', 'blocked request', {
        tier,
        keyType,
        key,
        path: req.path,
        method: req.method,
      });
      recordRateLimitHit({
        tier,
        keyType,
        keyValue: key,
        path: req.path,
        method: req.method,
      }).catch((error) => {
        logger.warn('rate_limit', 'failed to persist rate_limit_hit', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
      sendError(res, 429, 'rate_limited', 'Too many requests, try again later.');
    },
  });
}
