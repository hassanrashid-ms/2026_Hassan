import cors from 'cors';
import express from 'express';
import { getEnv } from './env.ts';
import { errorMiddleware } from './errors.ts';
import { requestLoggerMiddleware } from './shared/middleware/requestLogger.ts';
import { playerTokenRouter } from './shared/auth/playerTokenRoute.ts';
import { agentRouter } from './agent/router.ts';
import swaggerUi from 'swagger-ui-express';
import { openApiDocument } from './docs/openapi.ts';
import { sdkRouter } from './sdk/router.ts';
import { surfaceRouter } from './surface/router.ts';
import { adminRouter } from './admin/router.ts';
import { createRateLimiter } from './shared/rateLimit/limiter.ts';
import { ipKey } from './shared/rateLimit/keys.ts';
import { RATE_LIMIT_TIERS } from './shared/rateLimit/tiers.ts';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // 64 KB: generous for the largest plausible snapshot, small enough that an
  // oversized body is refused rather than truncated. Nothing inside an ACCEPTED
  // body is ever dropped — "nothing the game sends is ever dropped".
  app.use(express.json({ limit: '64kb' }));

  // Dev visibility: log every request so we can confirm traffic is arriving.
  // Verbosity (none/mild/verbose) is controlled by LOG_LEVEL — see shared/logging/logger.ts.
  app.use(requestLoggerMiddleware);

  // The SDK is not a browser and needs no CORS. The web surface does: it is served
  // from webviewBaseUrl and calls apiBaseUrl.
  app.use(
    cors({
      origin: getEnv().SURFACE_ORIGINS,
      methods: ['GET', 'POST', 'PATCH'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/docs/json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

  const authRateLimiter = createRateLimiter({
    tier: 'auth',
    keyType: 'ip',
    windowMs: RATE_LIMIT_TIERS.auth.windowMs,
    max: RATE_LIMIT_TIERS.auth.ipMax,
    keyFn: ipKey,
  });
  const sdkIpLimiter = createRateLimiter({
    tier: 'reads',
    keyType: 'ip',
    windowMs: RATE_LIMIT_TIERS.reads.windowMs,
    max: RATE_LIMIT_TIERS.reads.ipMax,
    keyFn: ipKey,
  });
  const surfaceIpLimiter = createRateLimiter({
    tier: 'reads',
    keyType: 'ip',
    windowMs: RATE_LIMIT_TIERS.reads.windowMs,
    max: RATE_LIMIT_TIERS.reads.ipMax,
    keyFn: ipKey,
  });
  const agentIpLimiter = createRateLimiter({
    tier: 'reads',
    keyType: 'ip',
    windowMs: RATE_LIMIT_TIERS.reads.windowMs,
    max: RATE_LIMIT_TIERS.reads.ipMax,
    keyFn: ipKey,
  });
  const adminIpLimiter = createRateLimiter({
    tier: 'reads',
    keyType: 'ip',
    windowMs: RATE_LIMIT_TIERS.reads.windowMs,
    max: RATE_LIMIT_TIERS.reads.ipMax,
    keyFn: ipKey,
  });

  app.use('/auth', authRateLimiter, playerTokenRouter);
  app.use('/sdk', sdkIpLimiter, sdkRouter);
  app.use('/surface', surfaceIpLimiter, surfaceRouter);
  app.use('/agent', agentIpLimiter, agentRouter);
  app.use('/admin', adminIpLimiter, adminRouter);

  app.use(errorMiddleware);
  return app;
}
