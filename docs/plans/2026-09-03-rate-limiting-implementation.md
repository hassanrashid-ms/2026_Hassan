# Rate Limiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Redis-backed rate limiting across the Core API — tiered by route sensitivity, keyed by IP and by authenticated identity — with every trigger logged and persisted.

**Architecture:** A single `createRateLimiter` factory (built on `express-rate-limit` + `rate-limit-redis`, backed by a dedicated lazy `ioredis` client) produces middleware instances. A **baseline "reads" tier** is applied to every top-level router (`/auth`, `/sdk`, `/surface`, `/agent`, `/admin`) — IP-scoped at the `app.ts` mount point, identity-scoped just inside each router after its auth middleware runs. Stricter **"writes"**, **"sessionsUploads"**, and **"auth"** tiers are layered on top as extra middleware on specific sensitive routes. On every 429, the handler logs via `logger.warn` and fire-and-forget inserts a `rate_limit_hit` row.

**Tech Stack:** `express-rate-limit`, `rate-limit-redis`, existing `ioredis`, existing Drizzle schema/migration tooling, existing `vitest` + `supertest` test setup.

## Global Constraints

- Fail **open** on Redis errors — never block a request because the rate-limit store is down. Use `passOnStoreError: true` and log a warning.
- Every rate limit trigger logs via `logger.warn('rate_limit', ...)` — not sampled, one line per 429.
- Every rate limit trigger also writes a `rate_limit_hit` row, **fire-and-forget** (not awaited before responding) — a persistence failure must never affect the 429 response.
- 429 responses use the existing `sendError(res, status, code, message)` shape: `{ error: { code: "rate_limited", message: "..." } }`.
- No feature flag, no gradual rollout — ship live across all tiers at once.
- No new endpoints, so no `openapi.ts` changes.
- Tier numbers (windowMs always `60_000`):

  | Tier              | ipMax | identityMax |
  | ----------------- | ----- | ----------- |
  | `auth`            | 60    | —           |
  | `reads`           | 300   | 60          |
  | `writes`          | 200   | 30          |
  | `sessionsUploads` | 100   | 10          |

---

### Task 1: Dependencies + dedicated Redis client

**Files:**

- Modify: `backend/package.json`
- Create: `backend/src/shared/rateLimit/rateLimitRedis.ts`
- Test: `backend/tests/rateLimitRedis.test.ts`

**Interfaces:**

- Produces: `rateLimitRedisClient(): IORedis`, `closeRateLimitRedis(): Promise<void>`

- [ ] **Step 1: Add dependencies**

Add to `backend/package.json`'s `dependencies` (alphabetical, matching existing style):

```json
"express-rate-limit": "^7",
"rate-limit-redis": "^4",
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

```ts
// backend/tests/rateLimitRedis.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import {
  closeRateLimitRedis,
  rateLimitRedisClient,
} from '../src/shared/rateLimit/rateLimitRedis.ts';

afterAll(async () => {
  await closeRateLimitRedis();
});

describe('rateLimitRedisClient', () => {
  it('returns a connected, reusable client', async () => {
    const client = rateLimitRedisClient();
    expect(await client.ping()).toBe('PONG');
    expect(rateLimitRedisClient()).toBe(client);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @support/api test rateLimitRedis.test.ts`
Expected: FAIL — module `../src/shared/rateLimit/rateLimitRedis.ts` does not exist.

- [ ] **Step 4: Implement the client module**

```ts
// backend/src/shared/rateLimit/rateLimitRedis.ts
import IORedis from 'ioredis';
import { getEnv } from '../../env.ts';

let redisClient: IORedis | undefined;

export function rateLimitRedisClient(): IORedis {
  if (!redisClient) {
    redisClient = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  }
  return redisClient;
}

/** Test-only teardown, mirrors wsAuthCache.ts's closeWsAuthRedis. */
export async function closeRateLimitRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit().catch(() => redisClient!.disconnect());
    redisClient = undefined;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @support/api test rateLimitRedis.test.ts`
Expected: PASS (requires the dev Redis container up — same requirement as every other test run in this repo).

- [ ] **Step 6: Commit**

```bash
git add backend/package.json pnpm-lock.yaml backend/src/shared/rateLimit/rateLimitRedis.ts backend/tests/rateLimitRedis.test.ts
git commit -m "Add rate limiting Redis client"
```

---

### Task 2: `rate_limit_hit` schema + `rate_limited` error code

**Files:**

- Create: `backend/src/shared/db/schema/rateLimit.ts`
- Modify: `backend/src/shared/db/schema/index.ts`
- Modify: `backend/src/errors.ts`

**Interfaces:**

- Produces: `rateLimitHit` Drizzle table (columns: `id`, `tier`, `keyType`, `keyValue`, `path`, `method`, `createdAt`), `ErrorCode` now includes `'rate_limited'`.

- [ ] **Step 1: Add the schema file**

```ts
// backend/src/shared/db/schema/rateLimit.ts
import { bigserial, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const tz = { withTimezone: true, mode: 'date' } as const;

/** Unscoped, like workspace/agent — an IP-keyed hit on a pre-auth route has no
 * workspace to attach to, and this is a diagnostics log, not tenant data. */
export const rateLimitHit = pgTable(
  'rate_limit_hit',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    tier: text('tier').notNull(),
    keyType: text('key_type').notNull(),
    keyValue: text('key_value').notNull(),
    path: text('path').notNull(),
    method: text('method').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    index('rate_limit_hit_tier_created_idx').on(t.tier, t.createdAt),
    index('rate_limit_hit_key_value_created_idx').on(t.keyValue, t.createdAt),
  ],
);
```

- [ ] **Step 2: Export it from the schema barrel**

In `backend/src/shared/db/schema/index.ts`, add a line (matching the existing alphabetical-ish grouping, appended at the end is fine):

```ts
export * from './rateLimit.ts';
```

- [ ] **Step 3: Add the `rate_limited` error code**

In `backend/src/errors.ts`, add `'rate_limited'` to the `ErrorCode` union (append after `'too_many_files'`):

```ts
  | 'too_many_files'
  | 'rate_limited';
```

- [ ] **Step 4: Generate and commit the migration**

Run: `pnpm db:generate`
Run: `pnpm db:setup`

Verify the generated migration only adds the `rate_limit_hit` table and its two indexes — check `git diff` on the new migration file under `backend/src/shared/db/migrations/` (or wherever `drizzle-kit` writes it in this repo) before committing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/shared/db/schema/rateLimit.ts backend/src/shared/db/schema/index.ts backend/src/errors.ts backend/src/shared/db/migrations/
git commit -m "Add rate_limit_hit table and rate_limited error code"
```

---

### Task 3: Persistence helper

**Files:**

- Create: `backend/src/shared/rateLimit/recordRateLimitHit.ts`
- Test: `backend/tests/recordRateLimitHit.test.ts`

**Interfaces:**

- Consumes: `rateLimitHit` from `../db/schema/index.ts` (Task 2), `withoutWorkspace` from `../db/withWorkspace.ts`.
- Produces: `recordRateLimitHit(input: { tier: string; keyType: 'ip' | 'identity'; keyValue: string; path: string; method: string }): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/recordRateLimitHit.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeOwnerPool, ownerPool, truncateAll } from './helpers/db.ts';
import { recordRateLimitHit } from '../src/shared/rateLimit/recordRateLimitHit.ts';

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(async () => {
  await truncateAll();
});

describe('recordRateLimitHit', () => {
  it('inserts a row with the given fields', async () => {
    await recordRateLimitHit({
      tier: 'writes',
      keyType: 'identity',
      keyValue: 'agent-123',
      path: '/surface/messages',
      method: 'POST',
    });

    const { rows } = await ownerPool.query(
      'select tier, key_type, key_value, path, method from rate_limit_hit',
    );
    expect(rows).toEqual([
      {
        tier: 'writes',
        key_type: 'identity',
        key_value: 'agent-123',
        path: '/surface/messages',
        method: 'POST',
      },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test recordRateLimitHit.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper**

```ts
// backend/src/shared/rateLimit/recordRateLimitHit.ts
import { rateLimitHit } from '../db/schema/index.ts';
import { withoutWorkspace } from '../db/withWorkspace.ts';

export async function recordRateLimitHit(input: {
  tier: string;
  keyType: 'ip' | 'identity';
  keyValue: string;
  path: string;
  method: string;
}): Promise<void> {
  await withoutWorkspace((tx) =>
    tx.insert(rateLimitHit).values({
      tier: input.tier,
      keyType: input.keyType,
      keyValue: input.keyValue,
      path: input.path,
      method: input.method,
    }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/api test recordRateLimitHit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/shared/rateLimit/recordRateLimitHit.ts backend/tests/recordRateLimitHit.test.ts
git commit -m "Add rate limit hit persistence helper"
```

---

### Task 4: Limiter factory (keys, tiers, `createRateLimiter`)

**Files:**

- Create: `backend/src/shared/rateLimit/keys.ts`
- Create: `backend/src/shared/rateLimit/tiers.ts`
- Create: `backend/src/shared/rateLimit/limiter.ts`
- Test: `backend/tests/rateLimit.limiter.test.ts`

**Interfaces:**

- Consumes: `rateLimitRedisClient` (Task 1), `recordRateLimitHit` (Task 3), `sendError` and `ErrorCode` from `../../errors.ts`, `logger` from `../logging/logger.ts`.
- Produces:
  - `ipKey(req): string`, `agentIdentityKey(req): string`, `playerIdentityKey(req): string`
  - `RATE_LIMIT_TIERS: { auth, reads, writes, sessionsUploads }` (each `{ windowMs, ipMax, identityMax? }`)
  - `createRateLimiter(options: { tier: string; keyType: 'ip' | 'identity'; windowMs: number; max: number; keyFn: (req: Request) => string }): RequestHandler`

- [ ] **Step 1: Write the key helpers**

```ts
// backend/src/shared/rateLimit/keys.ts
import type { Request } from 'express';

export function ipKey(req: Request): string {
  return req.ip ?? 'unknown';
}

export function agentIdentityKey(req: Request): string {
  return req.agent?.agentId ?? 'unknown';
}

export function playerIdentityKey(req: Request): string {
  return req.player?.playerId ?? 'unknown';
}
```

- [ ] **Step 2: Write the tier config**

```ts
// backend/src/shared/rateLimit/tiers.ts
export const RATE_LIMIT_TIERS = {
  auth: { windowMs: 60_000, ipMax: 60 },
  reads: { windowMs: 60_000, ipMax: 300, identityMax: 60 },
  writes: { windowMs: 60_000, ipMax: 200, identityMax: 30 },
  sessionsUploads: { windowMs: 60_000, ipMax: 100, identityMax: 10 },
} as const;

export type RateLimitTierName = keyof typeof RATE_LIMIT_TIERS;
```

- [ ] **Step 3: Write the failing test for the factory**

```ts
// backend/tests/rateLimit.limiter.test.ts
import express from 'express';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeOwnerPool, ownerPool, truncateAll } from './helpers/db.ts';
import { closeRateLimitRedis } from '../src/shared/rateLimit/rateLimitRedis.ts';
import { createRateLimiter } from '../src/shared/rateLimit/limiter.ts';
import { logger } from '../src/shared/logging/logger.ts';

afterAll(async () => {
  await closeRateLimitRedis();
  await closeDb();
  await closeOwnerPool();
});

function buildTestApp(max: number) {
  const app = express();
  const limiter = createRateLimiter({
    tier: 'test-tier',
    keyType: 'ip',
    windowMs: 60_000,
    max,
    keyFn: (req) => req.ip ?? 'unknown',
  });
  app.get('/probe', limiter, (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('createRateLimiter', () => {
  it('allows requests under the limit', async () => {
    const app = buildTestApp(5);
    await request(app).get('/probe').expect(200);
  });

  it('returns 429 with the rate_limited error shape once the limit is exceeded', async () => {
    await truncateAll();
    const app = buildTestApp(1);
    await request(app).get('/probe').expect(200);
    const res = await request(app).get('/probe').expect(429);
    expect(res.body).toEqual({
      error: { code: 'rate_limited', message: 'Too many requests, try again later.' },
    });
  });

  it('logs a warning on trigger', async () => {
    await truncateAll();
    const warnSpy = vi.spyOn(logger, 'warn');
    const app = buildTestApp(1);
    await request(app).get('/probe').expect(200);
    await request(app).get('/probe').expect(429);
    expect(warnSpy).toHaveBeenCalledWith(
      'rate_limit',
      'blocked request',
      expect.objectContaining({ tier: 'test-tier', keyType: 'ip', path: '/probe', method: 'GET' }),
    );
    warnSpy.mockRestore();
  });

  it('persists a rate_limit_hit row on trigger', async () => {
    await truncateAll();
    const app = buildTestApp(1);
    await request(app).get('/probe').expect(200);
    await request(app).get('/probe').expect(429);

    await vi.waitFor(async () => {
      const { rows } = await ownerPool.query(
        'select tier, key_type, path, method from rate_limit_hit',
      );
      expect(rows).toEqual([{ tier: 'test-tier', key_type: 'ip', path: '/probe', method: 'GET' }]);
    });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @support/api test rateLimit.limiter.test.ts`
Expected: FAIL — `../src/shared/rateLimit/limiter.ts` does not exist.

- [ ] **Step 5: Implement the factory**

```ts
// backend/src/shared/rateLimit/limiter.ts
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @support/api test rateLimit.limiter.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/src/shared/rateLimit/keys.ts backend/src/shared/rateLimit/tiers.ts backend/src/shared/rateLimit/limiter.ts backend/tests/rateLimit.limiter.test.ts
git commit -m "Add rate limiter factory with logging and persistence"
```

---

### Task 5: Auth-tier wiring (pre-auth routes)

**Files:**

- Modify: `backend/src/app.ts`
- Modify: `backend/src/agent/routers/authRouter.ts`
- Test: `backend/tests/rateLimit.auth.test.ts`

**Interfaces:**

- Consumes: `createRateLimiter`, `RATE_LIMIT_TIERS.auth`, `ipKey` (Task 4).

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/rateLimit.auth.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { app } from './helpers/app.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeOwnerPool, truncateAll } from './helpers/db.ts';
import { closeRateLimitRedis } from '../src/shared/rateLimit/rateLimitRedis.ts';

afterAll(async () => {
  await closeRateLimitRedis();
  await closeDb();
  await closeOwnerPool();
});

describe('auth-tier rate limiting', () => {
  it('sets the auth-tier RateLimit-Limit header on /auth/player-token', async () => {
    await truncateAll();
    const res = await request(app).post('/auth/player-token').send({});
    expect(res.headers['ratelimit-limit']).toBe('60');
  });

  it('sets the auth-tier RateLimit-Limit header on /agent/auth/dev-login', async () => {
    await truncateAll();
    const res = await request(app).post('/agent/auth/dev-login').send({});
    expect(res.headers['ratelimit-limit']).toBe('60');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test rateLimit.auth.test.ts`
Expected: FAIL — no `ratelimit-limit` header present yet.

- [ ] **Step 3: Wire the limiter into `app.ts`**

In `backend/src/app.ts`, add the import and build the limiter once, applying it only to the `/auth` mount (path-scoped, so it never runs for other routers):

```ts
import { createRateLimiter } from './shared/rateLimit/limiter.ts';
import { ipKey } from './shared/rateLimit/keys.ts';
import { RATE_LIMIT_TIERS } from './shared/rateLimit/tiers.ts';
```

Change:

```ts
app.use('/auth', playerTokenRouter);
```

to:

```ts
const authRateLimiter = createRateLimiter({
  tier: 'auth',
  keyType: 'ip',
  windowMs: RATE_LIMIT_TIERS.auth.windowMs,
  max: RATE_LIMIT_TIERS.auth.ipMax,
  keyFn: ipKey,
});

app.use('/auth', authRateLimiter, playerTokenRouter);
```

- [ ] **Step 4: Wire the limiter into `authRouter.ts`**

`authRouter` is mounted unconditionally inside `agentRouter` before `requireAgentSession`, so the auth-tier limiter must be applied directly on its two routes (not router-wide) — otherwise it would throttle the entire `/agent` router, not just login attempts.

In `backend/src/agent/routers/authRouter.ts`:

```ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @support/api test rateLimit.auth.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/app.ts backend/src/agent/routers/authRouter.ts backend/tests/rateLimit.auth.test.ts
git commit -m "Wire auth-tier rate limiting on pre-auth routes"
```

---

### Task 6: Reads-tier baseline wiring (all four authenticated routers)

**Files:**

- Modify: `backend/src/app.ts`
- Modify: `backend/src/sdk/router.ts`
- Modify: `backend/src/surface/router.ts`
- Modify: `backend/src/agent/router.ts`
- Modify: `backend/src/admin/router.ts`
- Test: `backend/tests/rateLimit.reads.test.ts`

**Interfaces:**

- Consumes: `createRateLimiter`, `RATE_LIMIT_TIERS.reads`, `ipKey`, `agentIdentityKey`, `playerIdentityKey` (Task 4).

Each router gets two limiters: an **IP** one applied path-scoped in `app.ts` (safe — top-level `app.use(path, ...)` only runs for matching requests), and an **identity** one applied inside the router file itself, immediately after its auth middleware populates `req.player`/`req.agent`, and _before_ any sub-router is mounted (so it covers literally everything in that router — no leakage, since it's the very top of that router's chain).

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/rateLimit.reads.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { app, mintToken } from './helpers/app.ts';
import { closeDb } from '../src/shared/db/client.ts';
import {
  closeOwnerPool,
  seedPlayer,
  seedSession,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';
import { closeRateLimitRedis } from '../src/shared/rateLimit/rateLimitRedis.ts';

afterAll(async () => {
  await closeRateLimitRedis();
  await closeDb();
  await closeOwnerPool();
});

describe('reads-tier baseline rate limiting', () => {
  it('sets the reads-tier IP limit on /sdk', async () => {
    await truncateAll();
    const res = await request(app).get('/sdk/_whoami');
    expect(res.headers['ratelimit-limit']).toBe('300');
  });

  it('sets the reads-tier identity limit on /surface once authenticated', async () => {
    await truncateAll();
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    await seedSession({ workspaceId, playerId });
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p1',
    });
    const res = await request(app).get('/surface/messages').set('Authorization', `Bearer ${token}`);
    expect(res.headers['ratelimit-limit']).toBe('60');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test rateLimit.reads.test.ts`
Expected: FAIL — no headers set yet.

- [ ] **Step 3: Wire IP-tier limiters in `app.ts`**

Extend the block from Task 5 with one IP limiter per remaining router, applied path-scoped:

```ts
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
```

(Four separate `createRateLimiter` calls, not a shared instance, so each router gets its own independent Redis counter bucket — otherwise traffic to `/sdk` would eat into `/surface`'s IP budget.)

- [ ] **Step 4: Wire identity-tier limiter in `sdk/router.ts`**

```ts
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
```

(Inserted immediately after the existing `sdkRouter.use(requirePlayerToken, requireSdkHeaders);` line, before the `NODE_ENV === 'test'` block and the three sub-router mounts.)

- [ ] **Step 5: Wire identity-tier limiter in `surface/router.ts`**

```ts
import { createRateLimiter } from '../shared/rateLimit/limiter.ts';
import { playerIdentityKey } from '../shared/rateLimit/keys.ts';
import { RATE_LIMIT_TIERS } from '../shared/rateLimit/tiers.ts';

export const surfaceRouter = Router();
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
```

(Inserted immediately after `surfaceRouter.use(requirePlayerToken);`, before any of the nine sub-router mounts.)

- [ ] **Step 6: Wire identity-tier limiter in `agent/router.ts`**

```ts
import { createRateLimiter } from '../shared/rateLimit/limiter.ts';
import { agentIdentityKey } from '../shared/rateLimit/keys.ts';
import { RATE_LIMIT_TIERS } from '../shared/rateLimit/tiers.ts';

export const agentRouter = Router();
agentRouter.use(authRouter);
agentRouter.use(requireAgentSession);
agentRouter.use(
  createRateLimiter({
    tier: 'reads',
    keyType: 'identity',
    windowMs: RATE_LIMIT_TIERS.reads.windowMs,
    max: RATE_LIMIT_TIERS.reads.identityMax,
    keyFn: agentIdentityKey,
  }),
);
agentRouter.use(membershipsRouter);
// ...rest unchanged
```

(Inserted immediately after `agentRouter.use(requireAgentSession);`, before `agentRouter.use(membershipsRouter);` and everything after it.)

- [ ] **Step 7: Wire identity-tier limiter in `admin/router.ts`**

```ts
import { createRateLimiter } from '../shared/rateLimit/limiter.ts';
import { agentIdentityKey } from '../shared/rateLimit/keys.ts';
import { RATE_LIMIT_TIERS } from '../shared/rateLimit/tiers.ts';

export const adminRouter = Router();
adminRouter.use(requireAgentSession);
adminRouter.use(requireAdminAccess);
adminRouter.use(
  createRateLimiter({
    tier: 'reads',
    keyType: 'identity',
    windowMs: RATE_LIMIT_TIERS.reads.windowMs,
    max: RATE_LIMIT_TIERS.reads.identityMax,
    keyFn: agentIdentityKey,
  }),
);
adminRouter.use(workspacesRouter);
adminRouter.use(agentsRouter);
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @support/api test rateLimit.reads.test.ts`
Expected: PASS

- [ ] **Step 9: Run the full backend suite to check for regressions**

Run: `pnpm --filter @support/api test`
Expected: PASS. (Rate limiting now runs on every request in every existing test — if any existing test makes an unusually high number of requests to the same route within one test process, watch for a spurious 429; the reads tier's 60–300/min ceiling is generous enough that this is not expected, but confirm.)

- [ ] **Step 10: Commit**

```bash
git add backend/src/app.ts backend/src/sdk/router.ts backend/src/surface/router.ts backend/src/agent/router.ts backend/src/admin/router.ts backend/tests/rateLimit.reads.test.ts
git commit -m "Wire reads-tier baseline rate limiting on all authenticated routers"
```

---

### Task 7: Writes and sessions/uploads tier overrides on sensitive routes

**Files:**

- Modify: `backend/src/surface/routers/messagesRouter.ts`
- Modify: `backend/src/surface/routers/newTicketRouter.ts`
- Modify: `backend/src/surface/routers/formRouter.ts`
- Modify: `backend/src/sdk/routers/sessionsRouter.ts`
- Modify: `backend/src/surface/routers/uploadsRouter.ts`
- Modify: `backend/src/agent/routers/uploadsRouter.ts`
- Test: `backend/tests/rateLimit.writesAndUploads.test.ts`

**Interfaces:**

- Consumes: `createRateLimiter`, `RATE_LIMIT_TIERS.writes`, `RATE_LIMIT_TIERS.sessionsUploads`, `playerIdentityKey` (Task 4). All six routes below sit under `/surface` or `/sdk`, both player-authenticated, so `playerIdentityKey` is the identity key throughout — there is no agent-facing writes/sessionsUploads route in this design (agent console traffic is covered by the reads tier from Task 6).

These limiters run **in addition to** the reads-tier baseline already wired in Task 6 — a request to a sensitive route passes through both; the stricter one binds first in practice.

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/rateLimit.writesAndUploads.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { app, mintToken } from './helpers/app.ts';
import { closeDb } from '../src/shared/db/client.ts';
import {
  closeOwnerPool,
  seedPlayer,
  seedSession,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';
import { closeRateLimitRedis } from '../src/shared/rateLimit/rateLimitRedis.ts';

afterAll(async () => {
  await closeRateLimitRedis();
  await closeDb();
  await closeOwnerPool();
});

async function authedPlayer() {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  await seedSession({ workspaceId, playerId });
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'p1',
  });
  return token;
}

describe('writes and sessionsUploads tier overrides', () => {
  it('applies the writes tier to POST /surface/messages', async () => {
    await truncateAll();
    const token = await authedPlayer();
    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hi' });
    expect(res.headers['ratelimit-limit']).toBe('30');
  });

  it('applies the writes tier to POST /surface/new-ticket', async () => {
    await truncateAll();
    const token = await authedPlayer();
    const res = await request(app)
      .post('/surface/new-ticket')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.headers['ratelimit-limit']).toBe('30');
  });

  it('applies the sessionsUploads tier to POST /sdk/sessions/start', async () => {
    await truncateAll();
    const token = await authedPlayer();
    const res = await request(app)
      .post('/sdk/sessions/start')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Support-Workspace', 'placeholder')
      .send({});
    expect(res.headers['ratelimit-limit']).toBe('10');
  });

  it('applies the sessionsUploads tier to POST /surface/uploads', async () => {
    await truncateAll();
    const token = await authedPlayer();
    const res = await request(app)
      .post('/surface/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.headers['ratelimit-limit']).toBe('10');
  });
});
```

Note: the `/sdk/sessions/start` test may need adjusting for whatever `requireSdkHeaders` actually requires (e.g. the real workspace slug header name/value) — check `backend/src/shared/middleware/requireSdkHeaders.ts` if this test fails on a 400/401 before reaching the rate limiter, and fix the request setup, not the production code.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test rateLimit.writesAndUploads.test.ts`
Expected: FAIL — no `ratelimit-limit` header for these specific values yet (they're currently only getting the reads-tier header from Task 6).

- [ ] **Step 3: Wire the writes tier onto `messagesRouter.ts`**

```ts
// backend/src/surface/routers/messagesRouter.ts
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
```

(Only the message-posting write route gets the stricter tier — reading messages and marking read stay on the reads-tier baseline from Task 6.)

- [ ] **Step 4: Wire the writes tier onto `newTicketRouter.ts`**

```ts
// backend/src/surface/routers/newTicketRouter.ts
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
```

- [ ] **Step 5: Wire the writes tier onto `formRouter.ts`**

```ts
// backend/src/surface/routers/formRouter.ts
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
```

- [ ] **Step 6: Wire the sessionsUploads tier onto `sdk/routers/sessionsRouter.ts`**

```ts
// backend/src/sdk/routers/sessionsRouter.ts
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
```

(Only session _start_ gets the stricter tier, per the design — `/sessions/end` stays on the reads-tier baseline.)

- [ ] **Step 7: Wire the sessionsUploads tier onto `surface/routers/uploadsRouter.ts`**

```ts
// backend/src/surface/routers/uploadsRouter.ts
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
```

- [ ] **Step 8: Wire the sessionsUploads tier onto `agent/routers/uploadsRouter.ts`**

Same pattern as Step 7, but note this file's `playerIdentityKey` is wrong — agent-side uploads happen under `requireAgentSession`, so `req.player` is never populated there. Use `agentIdentityKey` instead:

```ts
// backend/src/agent/routers/uploadsRouter.ts
import { Router } from 'express';
import { deleteUploadHandler, postUploadRequestHandler } from '../controllers/uploadsController.ts';
import { createRateLimiter } from '../../shared/rateLimit/limiter.ts';
import { agentIdentityKey } from '../../shared/rateLimit/keys.ts';
import { RATE_LIMIT_TIERS } from '../../shared/rateLimit/tiers.ts';

export const uploadsRouter = Router();

const sessionsUploadsLimiter = createRateLimiter({
  tier: 'sessionsUploads',
  keyType: 'identity',
  windowMs: RATE_LIMIT_TIERS.sessionsUploads.windowMs,
  max: RATE_LIMIT_TIERS.sessionsUploads.identityMax,
  keyFn: agentIdentityKey,
});

uploadsRouter.post('/uploads', sessionsUploadsLimiter, postUploadRequestHandler);
// :key contains slashes (pending/{ws}/{agent}/{uuid}.ext) — Express 5 needs the
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
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm --filter @support/api test rateLimit.writesAndUploads.test.ts`
Expected: PASS

- [ ] **Step 10: Run the full backend suite**

Run: `pnpm --filter @support/api test`
Expected: PASS

- [ ] **Step 11: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add backend/src/surface/routers/messagesRouter.ts backend/src/surface/routers/newTicketRouter.ts backend/src/surface/routers/formRouter.ts backend/src/sdk/routers/sessionsRouter.ts backend/src/surface/routers/uploadsRouter.ts backend/src/agent/routers/uploadsRouter.ts backend/tests/rateLimit.writesAndUploads.test.ts
git commit -m "Wire writes and sessionsUploads tier overrides on sensitive routes"
```
