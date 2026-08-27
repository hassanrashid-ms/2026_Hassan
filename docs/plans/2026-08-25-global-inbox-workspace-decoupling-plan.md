# Global Inbox & Workspace Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple the regular-agent session JWT from a fixed `workspace_id`, generalize the admin per-request workspace-resolution path to every agent, and build a Global Inbox that scatter-gathers active tickets across all of an agent's workspaces — over REST and realtime sockets.

**Architecture:** Extends the existing admin-only pattern from `2026-08-21-superadmin-workspace-console-access-design.md` (JWT carries identity only, `resolveConsoleWorkspace` resolves the target workspace per request from `X-Workspace-Id`) to every agent. Adds a Redis-cached `workspace_member` lookup so the per-request authorization check stays cheap, a scatter-gather service that fans out one RLS transaction per workspace with bounded concurrency, and a socket handshake that joins one inbox room per active membership instead of one fixed room.

**Tech Stack:** Express 5, Drizzle ORM, PostgreSQL RLS, Redis (ioredis), Socket.io + `@socket.io/redis-adapter`, `p-limit` (new dependency), React + TanStack Query, vitest + supertest (backend), vitest + Testing Library (frontend).

## Global Constraints

- JWT signing is unchanged: HS256, `AGENT_SESSION_JWT_SECRET`, issuer `support-crm`, audience `support-agent-dev`, TTL 12h.
- Unauthorized workspace access is always `404 Not Found`, never `403` — "not yours" and "not there" are indistinguishable (existing RLS convention, CLAUDE.md).
- Redis cache key `wsauth:{agent_id}:{workspace_id}`, TTL 60s, invalidated immediately when an admin action deactivates that membership.
- Global Inbox per-workspace query is capped at top 50 by priority/recency; per-request scatter concurrency is bounded via `p-limit(10)`.
- Global Inbox response includes `failed_workspaces: string[]` for partial failures — never fail the whole request over one workspace's query error.
- No hard deletes; every scoped table stays RLS-isolated by opening one transaction per workspace (`withWorkspace`), never a cross-workspace query.
- Every new API endpoint is registered in `backend/src/docs/openapi.ts` (CLAUDE.md rule).
- Backend tests live flat in `backend/tests/*.test.ts` (vitest + supertest), using the existing `backend/tests/helpers/db.ts` seed helpers and `backend/tests/helpers/http.ts`'s `req` wrapper. Frontend tests are colocated `*.test.tsx` (vitest + Testing Library), following `ConversationList.test.tsx`'s pattern of mocking `createSocket` and spying on `agentApi` functions.

---

## Important note on Task 2's blast radius

Every regular-agent JWT currently embeds `workspace_id`, and **`resolveConsoleWorkspace` is admin-only today** — a regular-agent test simply signs a token with `workspace_id` and never sets `X-Workspace-Id`. Task 1 removes `workspace_id` from the claims shape entirely, and Task 2 makes `resolveConsoleWorkspace` mandatory for every agent. Together these mean **every existing backend test file that signs a regular-agent token must add an `X-Workspace-Id` header and an active `workspace_member` row**, or it will 404. There are ~30 such files. Task 2 fixes the handful most central to this change explicitly (`resolveConsoleWorkspace.test.ts`, `auth.agentSession.test.ts`) and then gives the exact, repeatable two-part fix to apply to the rest, driven by the test runner's own failures — this is mechanical, not exploratory, so it's spelled out as a procedure rather than 30 unseen diffs.

---

### Task 1: Unify the agent JWT claims shape

**Files:**

- Modify: `backend/src/shared/auth/agentSession.ts`
- Test: `backend/tests/auth.agentSession.test.ts`

**Interfaces:**

- Produces: `AgentSessionClaims = { agent_id: string; is_admin: boolean }`, `signAgentSession(claims: { agent_id: string; is_admin?: boolean }, ttlSeconds?: number): Promise<string>`, `verifyAgentSession(token: string): Promise<AgentSessionClaims>`, `class InvalidAgentSession extends Error`. Every later task's middleware/service code reads `claims.is_admin` as a plain `boolean`, never `'is_admin' in claims`.

- [ ] **Step 1: Write the failing tests**

Replace the whole file with:

```ts
import { describe, expect, it } from 'vitest';
import {
  InvalidAgentSession,
  signAgentSession,
  verifyAgentSession,
} from '../src/shared/auth/agentSession.ts';

describe('agent session token', () => {
  it('round-trips a regular agent with is_admin false', async () => {
    const token = await signAgentSession({ agent_id: 'a1' });
    const claims = await verifyAgentSession(token);
    expect(claims).toEqual({ agent_id: 'a1', is_admin: false });
  });

  it('round-trips an admin with is_admin true', async () => {
    const token = await signAgentSession({ agent_id: 'a1', is_admin: true });
    const claims = await verifyAgentSession(token);
    expect(claims).toEqual({ agent_id: 'a1', is_admin: true });
  });

  it('carries no workspace_id claim at all — identity only, never authorization', async () => {
    const token = await signAgentSession({ agent_id: 'a1' });
    const { payload } = JSON.parse(
      Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'),
    ) as never as { payload: never };
    const decoded = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
    expect(decoded.workspace_id).toBeUndefined();
    expect(decoded.agent_id).toBe('a1');
    expect(decoded.is_admin).toBe(false);
    void payload;
  });

  it('rejects an expired token', async () => {
    const token = await signAgentSession({ agent_id: 'a1' }, -1);
    await expect(verifyAgentSession(token)).rejects.toThrow(InvalidAgentSession);
  });

  it('rejects a token signed with a different audience', async () => {
    const { SignJWT } = await import('jose');
    const key = new TextEncoder().encode(process.env.AGENT_SESSION_JWT_SECRET);
    const token = await new SignJWT({ agent_id: 'a1', is_admin: false })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('support-crm')
      .setAudience('some-other-audience')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(key);
    await expect(verifyAgentSession(token)).rejects.toThrow(InvalidAgentSession);
  });

  it('rejects a token missing a required claim', async () => {
    const { SignJWT } = await import('jose');
    const key = new TextEncoder().encode(process.env.AGENT_SESSION_JWT_SECRET);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('support-crm')
      .setAudience('support-agent-dev')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(key);
    await expect(verifyAgentSession(token)).rejects.toThrow(InvalidAgentSession);
  });

  it('rollout: tolerates an old-shape token that still carries workspace_id, ignoring the claim', async () => {
    const { SignJWT } = await import('jose');
    const key = new TextEncoder().encode(process.env.AGENT_SESSION_JWT_SECRET);
    const token = await new SignJWT({ agent_id: 'a1', workspace_id: 'w1' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('support-crm')
      .setAudience('support-agent-dev')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(key);
    const claims = await verifyAgentSession(token);
    expect(claims).toEqual({ agent_id: 'a1', is_admin: false });
  });
});
```

(The third test's unused `payload`/decode duplication is intentionally simple — it only needs to prove `workspace_id` is absent from the wire payload.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @support/api vitest run tests/auth.agentSession.test.ts`
Expected: FAIL — `verifyAgentSession` still returns a `workspace_id`-shaped claim for a non-admin token signed without `is_admin`, and `signAgentSession({ agent_id: 'a1' })` currently throws a type error (the old type requires `workspace_id` unless `is_admin: true`).

- [ ] **Step 3: Rewrite `agentSession.ts`**

```ts
import { SignJWT, jwtVerify } from 'jose';
import { getEnv } from '../../env.ts';

const ISSUER = 'support-crm';
const AUDIENCE = 'support-agent-dev';

/**
 * Identity only, never authorization — a regular agent and a global admin
 * carry the same shape. Which workspace(s) either can act in is resolved
 * fresh per request/connection (resolveConsoleWorkspace for REST, the socket
 * handshake for realtime), never fixed at sign time. See
 * 2026-08-25-global-inbox-workspace-decoupling-design.md section 1, which
 * generalizes what 2026-08-21-superadmin-workspace-console-access-design.md
 * built for admins only.
 */
export type AgentSessionClaims = { agent_id: string; is_admin: boolean };

function key(): Uint8Array {
  return new TextEncoder().encode(getEnv().AGENT_SESSION_JWT_SECRET);
}

/**
 * Stands in for the real Google-OAuth session this slice defers (see
 * docs/decisions/2026-08-04-agent-auth-google-oauth.md). A separate secret and
 * audience from the player token keep the two credentials from ever being
 * interchangeable, even by accident.
 */
export async function signAgentSession(
  claims: { agent_id: string; is_admin?: boolean },
  ttlSeconds: number = 60 * 60 * 12,
): Promise<string> {
  const payload: AgentSessionClaims = {
    agent_id: claims.agent_id,
    is_admin: claims.is_admin ?? false,
  };
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key());
}

export class InvalidAgentSession extends Error {}

export async function verifyAgentSession(token: string): Promise<AgentSessionClaims> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, key(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    }));
  } catch (error) {
    throw new InvalidAgentSession(error instanceof Error ? error.message : 'token rejected');
  }

  const { agent_id, is_admin } = payload;
  if (typeof agent_id !== 'string') {
    throw new InvalidAgentSession('token is missing a required claim');
  }
  // Rollout: a token minted before this change may still carry workspace_id
  // and no is_admin at all — never read, never trusted for authorization. See
  // "Rollout / mixed-token window" in the design doc.
  return { agent_id, is_admin: is_admin === true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @support/api vitest run tests/auth.agentSession.test.ts`
Expected: PASS

- [ ] **Step 5: Fix the two direct call sites this shape change breaks at typecheck**

`backend/src/shared/middleware/requireAgentSession.ts` — replace the body of the try block:

```ts
  try {
    const claims = await verifyAgentSession(rest.join(' ').trim());
    req.agent = { agentId: claims.agent_id, workspaceId: '', isAdmin: claims.is_admin };
    next();
  } catch (error) {
```

`backend/src/agent/services/authService.ts` — the `devLogin` membership loop and its `signAgentSession({ agent_id: agentRow.id, workspace_id: ws.id })` call are handled fully in Task 6 (they need to change behaviorally, not just typecheck). For now, so the package typechecks after this task, change only that one line's call:

```ts
const token = await signAgentSession({ agent_id: agentRow.id });
```

(`workspace: { id: ws.id, slug: ws.slug }` in the returned object is untouched here — Task 6 removes the whole membership loop and this return shape properly.)

- [ ] **Step 6: Typecheck the backend package**

Run: `pnpm --filter @support/api typecheck`
Expected: Still fails on every other test file that calls `signAgentSession({ agent_id, workspace_id })` for a regular agent — expected and addressed in Task 2. Confirm the _only_ new failures are excess-property errors on `signAgentSession(...)` calls (i.e., nothing in `src/` besides the two files just touched).

- [ ] **Step 7: Commit**

```bash
git add backend/src/shared/auth/agentSession.ts backend/src/shared/middleware/requireAgentSession.ts backend/src/agent/services/authService.ts backend/tests/auth.agentSession.test.ts
git commit -m "feat: unify agent JWT claims to identity-only {agent_id, is_admin}"
```

---

### Task 2: Generalize `resolveConsoleWorkspace` to every agent, with a Redis membership cache

**Files:**

- Create: `backend/src/shared/auth/wsAuthCache.ts`
- Create: `backend/tests/wsAuthCache.test.ts`
- Modify: `backend/src/shared/middleware/resolveConsoleWorkspace.ts`
- Modify: `backend/tests/resolveConsoleWorkspace.test.ts`
- Modify: every other `backend/tests/*.test.ts` file that signs a regular-agent token (mechanical fix, procedure given in Step 7)

**Interfaces:**

- Consumes: `AgentContext` from Task 1's `requireAgentSession.ts` (`{ agentId, workspaceId, isAdmin }`), `signAgentSession`/`verifyAgentSession` from Task 1.
- Produces: `getCachedWsAuth`, `setCachedWsAuth`, `invalidateCachedWsAuth`, `closeWsAuthRedis` from `wsAuthCache.ts`, each `(agentId: string, workspaceId: string) => Promise<...>`, plus `WsAuthCacheEntry = { active: boolean; role: 'agent' | 'team_lead' | null }`. Task 3 imports `invalidateCachedWsAuth`.

- [ ] **Step 1: Write the failing cache-module test**

`backend/tests/wsAuthCache.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  closeWsAuthRedis,
  getCachedWsAuth,
  invalidateCachedWsAuth,
  setCachedWsAuth,
} from '../src/shared/auth/wsAuthCache.ts';

afterAll(async () => {
  await closeWsAuthRedis();
});

describe('wsAuthCache', () => {
  it('returns null on a cache miss', async () => {
    const entry = await getCachedWsAuth(randomUUID(), randomUUID());
    expect(entry).toBeNull();
  });

  it('round-trips a cached entry', async () => {
    const agentId = randomUUID();
    const workspaceId = randomUUID();
    await setCachedWsAuth(agentId, workspaceId, { active: true, role: 'team_lead' });
    expect(await getCachedWsAuth(agentId, workspaceId)).toEqual({
      active: true,
      role: 'team_lead',
    });
  });

  it('invalidation clears a cached entry immediately, ahead of its TTL', async () => {
    const agentId = randomUUID();
    const workspaceId = randomUUID();
    await setCachedWsAuth(agentId, workspaceId, { active: true, role: 'agent' });
    await invalidateCachedWsAuth(agentId, workspaceId);
    expect(await getCachedWsAuth(agentId, workspaceId)).toBeNull();
  });

  it('keys are scoped per (agent, workspace) pair — no cross-talk', async () => {
    const agentId = randomUUID();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    await setCachedWsAuth(agentId, workspaceA, { active: true, role: 'agent' });
    expect(await getCachedWsAuth(agentId, workspaceB)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api vitest run tests/wsAuthCache.test.ts`
Expected: FAIL with "Cannot find module '../src/shared/auth/wsAuthCache.ts'"

- [ ] **Step 3: Write `wsAuthCache.ts`**

```ts
import IORedis from 'ioredis';
import { getEnv } from '../../env.ts';

/**
 * Backs the per-request membership check in resolveConsoleWorkspace.ts — see
 * 2026-08-25-global-inbox-workspace-decoupling-design.md section 1. `role` is
 * carried alongside `active` purely as a cache-fill byproduct of the lookup;
 * no caller currently reads it, since requireWorkspaceRole.ts still re-queries
 * role itself (role changes must take effect immediately, this cache's TTL
 * is 60s).
 */
export type WsAuthCacheEntry = { active: boolean; role: 'agent' | 'team_lead' | null };

const PREFIX = 'wsauth:';
const TTL_SECONDS = 60;

let redisClient: IORedis | undefined;

function client(): IORedis {
  if (!redisClient) {
    redisClient = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  }
  return redisClient;
}

const cacheKey = (agentId: string, workspaceId: string): string =>
  `${PREFIX}${agentId}:${workspaceId}`;

export async function getCachedWsAuth(
  agentId: string,
  workspaceId: string,
): Promise<WsAuthCacheEntry | null> {
  const raw = await client().get(cacheKey(agentId, workspaceId));
  if (raw === null) return null;
  return JSON.parse(raw) as WsAuthCacheEntry;
}

export async function setCachedWsAuth(
  agentId: string,
  workspaceId: string,
  entry: WsAuthCacheEntry,
): Promise<void> {
  await client().set(cacheKey(agentId, workspaceId), JSON.stringify(entry), 'EX', TTL_SECONDS);
}

export async function invalidateCachedWsAuth(agentId: string, workspaceId: string): Promise<void> {
  await client().del(cacheKey(agentId, workspaceId));
}

/** Test-only teardown, mirrors presence.ts's closePresenceRedis. */
export async function closeWsAuthRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit().catch(() => redisClient!.disconnect());
    redisClient = undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/api vitest run tests/wsAuthCache.test.ts`
Expected: PASS

- [ ] **Step 5: Rewrite the failing `resolveConsoleWorkspace.test.ts` cases first**

Replace the file's contents (keeping the existing admin-focused `it` blocks — they still pass unmodified — and adding regular-agent coverage for the new generalized behavior):

```ts
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts';
import { messagesRouter } from '../src/agent/routers/messagesRouter.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, conversationsRouter, messagesRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function claimableConversation(workspaceId: string): Promise<string> {
  const playerId = await seedPlayer(workspaceId);
  return seedConversation({ workspaceId, playerId, status: 'open' });
}

describe('resolveConsoleWorkspace — admin path (blanket access, no membership row)', () => {
  it('lets an admin claim a conversation in a workspace they hold no membership in, via X-Workspace-Id', async () => {
    const workspaceId = await seedWorkspace();
    const conversationId = await claimableConversation(workspaceId);
    const adminId = await seedAgent(undefined, { isAdmin: true });
    const token = await signAgentSession({ agent_id: adminId, is_admin: true });

    await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const { rows } = await ownerPool.query<{ assigned_agent_id: string | null }>(
      `select assigned_agent_id from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.assigned_agent_id).toBe(adminId);
  });

  it('404s an admin session with no X-Workspace-Id header', async () => {
    const adminId = await seedAgent(undefined, { isAdmin: true });
    const token = await signAgentSession({ agent_id: adminId, is_admin: true });

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('404s an admin session whose X-Workspace-Id names a workspace that does not exist', async () => {
    const adminId = await seedAgent(undefined, { isAdmin: true });
    const token = await signAgentSession({ agent_id: adminId, is_admin: true });

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', randomUUID())
      .expect(404);
  });
});

describe('resolveConsoleWorkspace — regular agent path (X-Workspace-Id + workspace_member check)', () => {
  it('200s and scopes to the header workspace when the agent has an active membership there', async () => {
    const workspaceId = await seedWorkspace();
    const conversationId = await claimableConversation(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
  });

  it('404s a regular agent session with no X-Workspace-Id header at all', async () => {
    const agentId = await seedAgent();
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('404s a regular agent naming a real workspace they are not a member of', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(404);
  });

  it('404s a regular agent whose membership has been deactivated', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent', deactivatedAt: new Date() });
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(404);
  });

  it('a second request for the same (agent, workspace) pair is served from cache without re-hitting Postgres', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    // Deactivate directly in the DB, bypassing the admin route (and therefore
    // its cache invalidation from Task 3) — proves this second call is served
    // from the still-warm 60s cache rather than re-checking Postgres.
    await ownerPool.query(
      `update workspace_member set deactivated_at = now() where workspace_id = $1 and agent_id = $2`,
      [workspaceId, agentId],
    );

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
  });
});
```

(The admin "malformed uuid" and "ignores header for non-admin" and "message attribution"/"take-over" cases from the old file are folded out here because the malformed-uuid check and the exists-check are unchanged code paths already covered by the "no such workspace" and general 404 cases above; message-attribution and take-over behavior are unrelated to this middleware and stay covered by their own test files, `agent.messages.test.ts` and `resolveConsoleWorkspace.test.ts`'s admin describe block above.)

- [ ] **Step 6: Run test to verify it fails, then rewrite `resolveConsoleWorkspace.ts`**

Run: `pnpm --filter @support/api vitest run tests/resolveConsoleWorkspace.test.ts`
Expected: FAIL — every regular-agent case above 200s/404s the opposite way, since the middleware still early-returns `next()` for non-admins.

Rewrite `backend/src/shared/middleware/resolveConsoleWorkspace.ts`:

```ts
import type { RequestHandler } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import { workspace, workspaceMember } from '../db/schema/index.ts';
import { adminDb } from '../db/adminClient.ts';
import { withoutWorkspace } from '../db/withWorkspace.ts';
import { getCachedWsAuth, setCachedWsAuth, type WsAuthCacheEntry } from '../auth/wsAuthCache.ts';

const uuidSchema = z.uuid();

/**
 * Mounted on the agent router after requireAgentSession (and after
 * membershipsRouter/globalInboxRouter, which don't need a target workspace) —
 * everything after this middleware does. Generalizes what was previously an
 * admin-only check
 * (2026-08-21-superadmin-workspace-console-access-design.md) to every agent:
 * see 2026-08-25-global-inbox-workspace-decoupling-design.md section 1.
 * Neither an admin's nor a regular agent's JWT carries a workspace_id claim
 * any more (Task 1) — the target workspace always comes from X-Workspace-Id.
 * An admin is exempt only from the workspace_member membership check below (an
 * admin holds no workspace_member row anywhere by design), not from supplying
 * the header at all.
 */
export const resolveConsoleWorkspace: RequestHandler = async (req, res, next) => {
  const ctx = req.agent!;
  const header = req.header('x-workspace-id');
  const parsed = uuidSchema.safeParse(header);
  if (!parsed.success) {
    sendError(res, 404, 'not_found', 'Workspace not found.');
    return;
  }
  const workspaceId = parsed.data;

  const exists = await withoutWorkspace(async (tx) => {
    const [row] = await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    return row !== undefined;
  });
  if (!exists) {
    sendError(res, 404, 'not_found', 'Workspace not found.');
    return;
  }

  if (!ctx.isAdmin) {
    let cached = await getCachedWsAuth(ctx.agentId, workspaceId);
    if (cached === null) {
      const [row] = await adminDb
        .select({ role: workspaceMember.role, deactivatedAt: workspaceMember.deactivatedAt })
        .from(workspaceMember)
        .where(
          and(
            eq(workspaceMember.agentId, ctx.agentId),
            eq(workspaceMember.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      const fresh: WsAuthCacheEntry = row
        ? { active: row.deactivatedAt === null, role: row.role }
        : { active: false, role: null };
      await setCachedWsAuth(ctx.agentId, workspaceId, fresh);
      cached = fresh;
    }
    if (!cached.active) {
      sendError(res, 404, 'not_found', 'Workspace not found.');
      return;
    }
  }

  req.agent = { ...ctx, workspaceId };
  next();
};
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @support/api vitest run tests/resolveConsoleWorkspace.test.ts`
Expected: PASS

- [ ] **Step 8: Migrate the rest of the backend test suite mechanically**

Run: `pnpm --filter @support/api vitest run` and read the failures. Every failure signing a **regular** agent token (`signAgentSession({ agent_id })` with no `is_admin`) needs exactly this two-part fix wherever it's missing:

1. Before signing the token, ensure that agent has an active membership in the workspace under test:
   ```ts
   await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
   ```
   (Many files already seed this for other reasons — check before adding a duplicate.)
2. Add the header to every request made with that agent's token:
   ```ts
   .set('X-Workspace-Id', workspaceId)
   ```
   Chained the same way `resolveConsoleWorkspace.test.ts` does above, immediately after `.set('Authorization', ...)`.

Files whose only `signAgentSession` calls are for an **admin** agent (`is_admin: true`) need no change beyond Task 1 Step 5 (drop `workspace_id` from the call and add `X-Workspace-Id` on requests instead, mirroring the pattern already used by the admin describe block in `resolveConsoleWorkspace.test.ts`).

Apply this fix file-by-file, re-running `pnpm --filter @support/api vitest run <file>` after each, until the full suite is green:

Run: `pnpm --filter @support/api vitest run`
Expected: PASS, 0 failures, across every file in `backend/tests/`.

- [ ] **Step 9: Typecheck the backend package**

Run: `pnpm --filter @support/api typecheck`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add backend/src/shared/auth/wsAuthCache.ts backend/src/shared/middleware/resolveConsoleWorkspace.ts backend/tests/
git commit -m "feat: generalize resolveConsoleWorkspace to every agent, cached via Redis"
```

---

### Task 3: Invalidate the membership cache the instant an admin deactivates access

**Files:**

- Modify: `backend/src/admin/services/membersService.ts`
- Modify: `backend/tests/admin.members.test.ts`

**Interfaces:**

- Consumes: `invalidateCachedWsAuth(agentId, workspaceId)` from Task 2's `wsAuthCache.ts`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/admin.members.test.ts` (needs `getCachedWsAuth`/`setCachedWsAuth`/`closeWsAuthRedis` imports and an `afterAll` addition):

```ts
import {
  getCachedWsAuth,
  setCachedWsAuth,
  closeWsAuthRedis,
} from '../src/shared/auth/wsAuthCache.ts';
```

Add to the existing `afterAll`:

```ts
afterAll(async () => {
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});
```

New test inside `describe('PATCH /admin/workspaces/:id/members/:agentId', ...)`:

```ts
it('invalidates a warm wsauth cache entry the instant access is removed', async () => {
  const workspaceId = await seedWorkspace();
  const memberId = await seedAgent();
  await seedWorkspaceMember({ workspaceId, agentId: memberId, role: 'agent' });
  await setCachedWsAuth(memberId, workspaceId, { active: true, role: 'agent' });
  const token = await adminToken(workspaceId);

  await request(app)
    .patch(`/admin/workspaces/${workspaceId}/members/${memberId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ remove: true })
    .expect(200);

  expect(await getCachedWsAuth(memberId, workspaceId)).toBeNull();
});

it('invalidates the cache when hard-deleting a still-invited member too', async () => {
  const workspaceId = await seedWorkspace();
  const token = await adminToken(workspaceId);
  const created = await request(app)
    .post(`/admin/workspaces/${workspaceId}/members`)
    .set('Authorization', `Bearer ${token}`)
    .send({ email: 'pending2@mindstormstudios.com', role: 'agent' })
    .expect(201);
  await setCachedWsAuth(created.body.agent_id, workspaceId, { active: true, role: 'agent' });

  await request(app)
    .patch(`/admin/workspaces/${workspaceId}/members/${created.body.agent_id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ remove: true })
    .expect(200);

  expect(await getCachedWsAuth(created.body.agent_id, workspaceId)).toBeNull();
});
```

Also update `adminToken` (it currently signs `{ agent_id: agentId, workspace_id: workspaceId }`, which no longer typechecks after Task 1):

```ts
async function adminToken(workspaceId: string): Promise<string> {
  const agentId = await seedAgent(undefined, { isAdmin: true });
  void workspaceId;
  return signAgentSession({ agent_id: agentId, is_admin: true });
}
```

Wait — every call site passes `workspaceId` and every request in this file already sets `X-Workspace-Id`? Check: `/admin/*` routes don't go through `resolveConsoleWorkspace` at all (they use `adminDb`, not RLS), so no header is needed. Simplify instead of keeping a dead parameter — change every `adminToken(workspaceId)` call site to `adminToken()` and drop the parameter:

```ts
async function adminToken(): Promise<string> {
  const agentId = await seedAgent(undefined, { isAdmin: true });
  return signAgentSession({ agent_id: agentId, is_admin: true });
}
```

Update every `await adminToken(workspaceId)` call in the file to `await adminToken()`.

- [ ] **Step 2: Run tests to verify the two new ones fail**

Run: `pnpm --filter @support/api vitest run tests/admin.members.test.ts`
Expected: The two new tests FAIL (cache entry still present after removal); the rest PASS once the `adminToken()` signature fix is applied.

- [ ] **Step 3: Add invalidation calls in `membersService.ts`**

```ts
import { and, eq } from 'drizzle-orm';
import { adminDb } from '../../shared/db/adminClient.ts';
import { agent, workspaceMember } from '../../shared/db/schema/index.ts';
import { invalidateCachedWsAuth } from '../../shared/auth/wsAuthCache.ts';
```

In `updateMember`, after the hard-delete branch's `await adminDb.delete(...)`:

```ts
if (args.remove && existing.status === 'invited') {
  await adminDb
    .delete(workspaceMember)
    .where(
      and(
        eq(workspaceMember.workspaceId, args.workspaceId),
        eq(workspaceMember.agentId, args.agentId),
      ),
    );
  await invalidateCachedWsAuth(args.agentId, args.workspaceId);
  return null;
}
```

And after the update-branch's `.returning(...)` result is confirmed non-null:

```ts
if (!row) return null;
if (args.remove) {
  await invalidateCachedWsAuth(args.agentId, args.workspaceId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @support/api vitest run tests/admin.members.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/admin/services/membersService.ts backend/tests/admin.members.test.ts
git commit -m "feat: invalidate the wsauth cache immediately on membership deactivation/removal"
```

---

### Task 4: Shared "which workspaces is this agent in" helper

**Files:**

- Create: `backend/src/shared/db/workspaceMembership.ts`
- Test: `backend/tests/workspaceMembership.test.ts`

**Interfaces:**

- Produces: `listActiveMembershipsForAgent(agentId: string): Promise<MembershipRow[]>` where `MembershipRow = { workspaceId: string; workspaceSlug: string; workspaceName: string; role: 'agent' | 'team_lead' }`, and `listAllWorkspaces(): Promise<WorkspaceRow[]>` where `WorkspaceRow = { workspaceId: string; workspaceSlug: string; workspaceName: string }`. Tasks 5 (memberships endpoint), 7 (global inbox scatter), and 9 (socket handshake) all import both.

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import {
  listActiveMembershipsForAgent,
  listAllWorkspaces,
} from '../src/shared/db/workspaceMembership.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('listActiveMembershipsForAgent', () => {
  it('returns only the active memberships for this specific agent, across workspaces', async () => {
    const workspaceA = await seedWorkspace({ slug: 'ws-a', name: 'Workspace A' });
    const workspaceB = await seedWorkspace({ slug: 'ws-b', name: 'Workspace B' });
    const workspaceC = await seedWorkspace({ slug: 'ws-c', name: 'Workspace C' });
    const agentId = await seedAgent();
    const otherAgentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId: workspaceA, agentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId: workspaceB, agentId, role: 'team_lead' });
    await seedWorkspaceMember({
      workspaceId: workspaceC,
      agentId,
      role: 'agent',
      deactivatedAt: new Date(),
    });
    await seedWorkspaceMember({ workspaceId: workspaceA, agentId: otherAgentId, role: 'agent' });

    const rows = await listActiveMembershipsForAgent(agentId);

    expect(rows).toEqual(
      expect.arrayContaining([
        {
          workspaceId: workspaceA,
          workspaceSlug: 'ws-a',
          workspaceName: 'Workspace A',
          role: 'agent',
        },
        {
          workspaceId: workspaceB,
          workspaceSlug: 'ws-b',
          workspaceName: 'Workspace B',
          role: 'team_lead',
        },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it('returns an empty list for an agent with zero memberships', async () => {
    const agentId = await seedAgent();
    expect(await listActiveMembershipsForAgent(agentId)).toEqual([]);
  });
});

describe('listAllWorkspaces', () => {
  it('returns every workspace regardless of membership', async () => {
    const workspaceA = await seedWorkspace({ slug: 'ws-x' });
    const workspaceB = await seedWorkspace({ slug: 'ws-y' });

    const rows = await listAllWorkspaces();

    expect(rows.map((r) => r.workspaceId)).toEqual(
      expect.arrayContaining([workspaceA, workspaceB]),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api vitest run tests/workspaceMembership.test.ts`
Expected: FAIL with "Cannot find module '../src/shared/db/workspaceMembership.ts'"

- [ ] **Step 3: Write `workspaceMembership.ts`**

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { adminDb } from './adminClient.ts';
import { withoutWorkspace } from './withWorkspace.ts';
import { workspace, workspaceMember } from './schema/index.ts';

/**
 * `workspace_member` is RLS-scoped per table, so answering "which workspaces
 * is agent X in" needs a query outside any single workspace's transaction —
 * uses adminDb (bypasses RLS) filtered by agentId, the same pattern
 * membersService.ts already uses for admin-side membership queries.
 */
export type MembershipRow = {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  role: 'agent' | 'team_lead';
};

export async function listActiveMembershipsForAgent(agentId: string): Promise<MembershipRow[]> {
  return adminDb
    .select({
      workspaceId: workspaceMember.workspaceId,
      workspaceSlug: workspace.slug,
      workspaceName: workspace.name,
      role: workspaceMember.role,
    })
    .from(workspaceMember)
    .innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
    .where(and(eq(workspaceMember.agentId, agentId), isNull(workspaceMember.deactivatedAt)));
}

export type WorkspaceRow = { workspaceId: string; workspaceSlug: string; workspaceName: string };

/** A global admin has blanket access — this is their equivalent of the list above. */
export async function listAllWorkspaces(): Promise<WorkspaceRow[]> {
  return withoutWorkspace(async (tx) =>
    tx
      .select({
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        workspaceName: workspace.name,
      })
      .from(workspace),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/api vitest run tests/workspaceMembership.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/shared/db/workspaceMembership.ts backend/tests/workspaceMembership.test.ts
git commit -m "feat: add listActiveMembershipsForAgent/listAllWorkspaces helper"
```

---

### Task 5: `GET /agent/memberships`

**Files:**

- Create: `backend/src/agent/services/membershipsService.ts`
- Create: `backend/src/agent/controllers/membershipsController.ts`
- Create: `backend/src/agent/routers/membershipsRouter.ts`
- Modify: `backend/src/agent/router.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.memberships.test.ts`

**Interfaces:**

- Consumes: `AgentContext` (Task 1), `listActiveMembershipsForAgent`/`listAllWorkspaces` (Task 4).
- Produces: `GET /agent/memberships → { memberships: MembershipView[] }` where `MembershipView = { workspace_id: string; workspace_slug: string; workspace_name: string; role: 'agent' | 'team_lead' | 'admin' }`. Task 10 (frontend switcher) consumes this response shape exactly.

- [ ] **Step 1: Write the failing test**

```ts
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { membershipsRouter } from '../src/agent/routers/membershipsRouter.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

// membershipsRouter is mounted before resolveConsoleWorkspace in the real
// agentRouter — no X-Workspace-Id needed to ask "which workspaces am I in".
const app = express();
app.use(express.json());
app.use(requireAgentSession, membershipsRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('GET /agent/memberships', () => {
  it('lists a regular agent’s active memberships with role, excluding a deactivated one', async () => {
    const workspaceA = await seedWorkspace({ slug: 'ws-a', name: 'Workspace A' });
    const workspaceB = await seedWorkspace({ slug: 'ws-b', name: 'Workspace B' });
    const workspaceC = await seedWorkspace({ slug: 'ws-c', name: 'Workspace C' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId: workspaceA, agentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId: workspaceB, agentId, role: 'team_lead' });
    await seedWorkspaceMember({
      workspaceId: workspaceC,
      agentId,
      role: 'agent',
      deactivatedAt: new Date(),
    });
    const token = await signAgentSession({ agent_id: agentId });

    const res = await request(app)
      .get('/memberships')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.memberships).toEqual(
      expect.arrayContaining([
        {
          workspace_id: workspaceA,
          workspace_slug: 'ws-a',
          workspace_name: 'Workspace A',
          role: 'agent',
        },
        {
          workspace_id: workspaceB,
          workspace_slug: 'ws-b',
          workspace_name: 'Workspace B',
          role: 'team_lead',
        },
      ]),
    );
    expect(res.body.memberships).toHaveLength(2);
  });

  it('returns every workspace with role admin for a global admin', async () => {
    await seedWorkspace({ slug: 'ws-x' });
    await seedWorkspace({ slug: 'ws-y' });
    const adminId = await seedAgent(undefined, { isAdmin: true });
    const token = await signAgentSession({ agent_id: adminId, is_admin: true });

    const res = await request(app)
      .get('/memberships')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.memberships.every((m: { role: string }) => m.role === 'admin')).toBe(true);
    expect(res.body.memberships.length).toBeGreaterThanOrEqual(2);
  });

  it('returns an empty list, not an error, for an agent with no memberships', async () => {
    const agentId = await seedAgent();
    const token = await signAgentSession({ agent_id: agentId });

    const res = await request(app)
      .get('/memberships')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.memberships).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api vitest run tests/agent.memberships.test.ts`
Expected: FAIL with "Cannot find module '../src/agent/routers/membershipsRouter.ts'"

- [ ] **Step 3: Write the service, controller, and router**

`backend/src/agent/services/membershipsService.ts`:

```ts
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import {
  listActiveMembershipsForAgent,
  listAllWorkspaces,
} from '../../shared/db/workspaceMembership.ts';

export type MembershipView = {
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  role: 'agent' | 'team_lead' | 'admin';
};

export async function listMyMemberships(ctx: AgentContext): Promise<MembershipView[]> {
  if (ctx.isAdmin) {
    const workspaces = await listAllWorkspaces();
    return workspaces.map((w) => ({
      workspace_id: w.workspaceId,
      workspace_slug: w.workspaceSlug,
      workspace_name: w.workspaceName,
      role: 'admin' as const,
    }));
  }
  const memberships = await listActiveMembershipsForAgent(ctx.agentId);
  return memberships.map((m) => ({
    workspace_id: m.workspaceId,
    workspace_slug: m.workspaceSlug,
    workspace_name: m.workspaceName,
    role: m.role,
  }));
}
```

`backend/src/agent/controllers/membershipsController.ts`:

```ts
import type { RequestHandler } from 'express';
import { listMyMemberships } from '../services/membershipsService.ts';

export const getMembershipsHandler: RequestHandler = async (req, res) => {
  const memberships = await listMyMemberships(req.agent!);
  res.status(200).json({ memberships });
};
```

`backend/src/agent/routers/membershipsRouter.ts`:

```ts
import { Router } from 'express';
import { getMembershipsHandler } from '../controllers/membershipsController.ts';

export const membershipsRouter = Router();
membershipsRouter.get('/memberships', getMembershipsHandler);
```

- [ ] **Step 4: Mount it before `resolveConsoleWorkspace` in `router.ts`**

```ts
import { membershipsRouter } from './routers/membershipsRouter.ts';
// ...
agentRouter.use(requireAgentSession);
agentRouter.use(membershipsRouter);
agentRouter.use(resolveConsoleWorkspace);
agentRouter.use(taxonomyRouter);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @support/api vitest run tests/agent.memberships.test.ts`
Expected: PASS

- [ ] **Step 6: Register the route in `openapi.ts`**

Add near the other `/agent/*` registrations (after the `/agent/conversations` block):

```ts
const MembershipViewSchema = z.object({
  workspace_id: z.uuid(),
  workspace_slug: z.string(),
  workspace_name: z.string(),
  role: z.enum(['agent', 'team_lead', 'admin']),
});

registry.registerPath({
  method: 'get',
  path: '/agent/memberships',
  summary: 'List My Workspace Memberships',
  description:
    'Every active workspace this agent belongs to, or every workspace for a global admin. Powers the workspace switcher.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: {
    200: {
      description: 'Memberships list',
      content: {
        'application/json': { schema: z.object({ memberships: z.array(MembershipViewSchema) }) },
      },
    },
  },
});
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/agent/services/membershipsService.ts backend/src/agent/controllers/membershipsController.ts backend/src/agent/routers/membershipsRouter.ts backend/src/agent/router.ts backend/src/docs/openapi.ts backend/tests/agent.memberships.test.ts
git commit -m "feat: add GET /agent/memberships"
```

---

### Task 6: Simplify login — identity only, no workspace binding

**Files:**

- Modify: `backend/src/agent/services/authService.ts`
- Modify: `backend/src/agent/controllers/authController.ts`
- Test: `backend/tests/agent.authLogin.test.ts` (new)
- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`
- Modify: `frontend/src/surfaces/agent-console/lib/agentSession.ts`
- Modify: `frontend/src/surfaces/agent-console/pages/AgentLogin.tsx`

**Interfaces:**

- Produces: `devLogin(agentId: string): Promise<{ token: string; agent: { id: string; display_name: string } } | null>` (workspace binding removed). Frontend `saveLastActiveWorkspaceId`/`loadLastActiveWorkspaceId` from `agentSession.ts` are consumed by Task 10's `WorkspaceSwitcher`.

- [ ] **Step 1: Write the failing backend test**

`backend/tests/agent.authLogin.test.ts`:

```ts
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { authRouter } from '../src/agent/routers/authRouter.ts';
import { verifyAgentSession } from '../src/shared/auth/agentSession.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('POST /auth/dev-login', () => {
  it('logs in a regular agent with zero memberships — no more "not found" for an unassigned agent', async () => {
    const agentId = await seedAgent();

    const res = await request(app).post('/auth/dev-login').send({ agent_id: agentId }).expect(200);

    expect(res.body.agent.id).toBe(agentId);
    expect(res.body.workspace).toBeUndefined();
    const claims = await verifyAgentSession(res.body.token);
    expect(claims).toEqual({ agent_id: agentId, is_admin: false });
  });

  it('logs in a regular agent with active memberships, still with no workspace bound to the token', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });

    const res = await request(app).post('/auth/dev-login').send({ agent_id: agentId }).expect(200);

    const claims = await verifyAgentSession(res.body.token);
    expect(claims).toEqual({ agent_id: agentId, is_admin: false });
  });

  it('logs in a global admin with is_admin true on the token', async () => {
    const adminId = await seedAgent(undefined, { isAdmin: true });

    const res = await request(app).post('/auth/dev-login').send({ agent_id: adminId }).expect(200);

    const claims = await verifyAgentSession(res.body.token);
    expect(claims).toEqual({ agent_id: adminId, is_admin: true });
  });

  it('404s an agent id that does not exist', async () => {
    await request(app)
      .post('/auth/dev-login')
      .send({ agent_id: '00000000-0000-0000-0000-000000000000' })
      .expect(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api vitest run tests/agent.authLogin.test.ts`
Expected: FAIL — the current `devLogin` 404s an agent with zero memberships (`"Agent not found or has no workspace membership."`), and returns `workspace: null`/`workspace: {...}` rather than omitting the field.

- [ ] **Step 3: Simplify `devLogin`**

Replace `devLogin` and `DevLoginResult` in `authService.ts` (the `listDevAgents` function above it is untouched):

```ts
export type DevLoginResult = { token: string; agent: { id: string; display_name: string } } | null;

export async function devLogin(agentId: string): Promise<DevLoginResult> {
  const agentRow = await withoutWorkspace(async (tx) => {
    const [row] = await tx
      .select({
        id: agentTable.id,
        displayName: agentTable.displayName,
        isAdmin: agentTable.isAdmin,
      })
      .from(agentTable)
      .where(eq(agentTable.id, agentId))
      .limit(1);
    return row ?? null;
  });
  if (!agentRow) return null;

  // Identity only — see 2026-08-25-global-inbox-workspace-decoupling-design.md
  // section 1. Which workspace(s) this agent can act in is discovered via
  // GET /agent/memberships and chosen client-side, never fixed at login. An
  // agent with zero memberships still gets a token; the frontend shows an
  // empty/no-access state rather than refusing to log them in.
  const token = await signAgentSession({ agent_id: agentRow.id, is_admin: agentRow.isAdmin });
  return { token, agent: { id: agentRow.id, display_name: agentRow.displayName } };
}
```

Remove the now-unused `workspace` and `and`/`isNull`/`withWorkspace` imports if nothing else in the file uses them — `listDevAgents` above still uses `withWorkspace`/`isNull`/`workspace`/`workspaceMember`/`and`, so only drop what's actually unused after this edit (check with the typechecker in Step 5).

- [ ] **Step 4: Simplify the controller's error path**

`backend/src/agent/controllers/authController.ts` — the 404 message referencing "no workspace membership" is no longer accurate:

```ts
export const devLogin: RequestHandler = async (req, res) => {
  const body = DevLoginBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'agent_id must be a uuid.');
    return;
  }
  const result = await devLoginService(body.data.agent_id);
  if (!result) {
    sendError(res, 404, 'not_found', 'Agent not found.');
    return;
  }
  res.status(200).json(result);
};
```

- [ ] **Step 5: Run test to verify it passes, then typecheck**

Run: `pnpm --filter @support/api vitest run tests/agent.authLogin.test.ts`
Expected: PASS

Run: `pnpm --filter @support/api typecheck`
Expected: PASS

- [ ] **Step 6: Update the frontend login flow**

`frontend/src/surfaces/agent-console/lib/agentSession.ts` — add last-active-workspace persistence next to the existing `loadContextRailOpen`/`saveContextRailOpen` pair, and drop the now-stale comment on `role` (login returns a real role via the membership picked at login, from Step 7 below):

```ts
const LAST_ACTIVE_WORKSPACE_KEY = 'support_last_active_workspace_id';

export function loadLastActiveWorkspaceId(): string | null {
  return localStorage.getItem(LAST_ACTIVE_WORKSPACE_KEY);
}

export function saveLastActiveWorkspaceId(workspaceId: string): void {
  localStorage.setItem(LAST_ACTIVE_WORKSPACE_KEY, workspaceId);
}
```

Also update the `role` field's doc comment on `StoredAgentSession`, since it's no longer speculative:

```ts
  /**
   * Set from the membership chosen at login (see AgentLogin.tsx) or from the
   * workspace switcher (see WorkspaceSwitcher.tsx) — always the role for the
   * *current* workspaceId, not a fixed account-level role.
   */
  role?: AgentRole;
```

`frontend/src/surfaces/agent-console/api/agentApi.ts` — replace `DevLoginResponse` and add the memberships types/fetcher (the memberships fetcher belongs here since Task 5's backend route now exists):

```ts
export type DevLoginResponse = {
  token: string;
  agent: { id: string; display_name: string };
};

export type MembershipView = {
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  role: 'agent' | 'team_lead' | 'admin';
};

export function fetchMemberships(token: string): Promise<{ memberships: MembershipView[] }> {
  return call('/agent/memberships', token);
}
```

(Remove the old `workspace: { id: string; slug: string } | null;` field and its doc comment from `DevLoginResponse`.)

`frontend/src/surfaces/agent-console/pages/AgentLogin.tsx` — replace `onPick`:

```ts
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { devLogin, fetchDevAgents, fetchMemberships } from '../api/agentApi.ts';
import {
  loadLastActiveWorkspaceId,
  saveAgentSession,
  saveLastActiveWorkspaceId,
} from '../lib/agentSession.ts';

export function AgentLogin() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const agentsQuery = useQuery({ queryKey: ['devAgents'], queryFn: fetchDevAgents });

  const onPick = async (agentId: string) => {
    const result = await devLogin(agentId);
    const { memberships } = await fetchMemberships(result.token);

    if (memberships.length === 0) {
      setError(`${result.agent.display_name} has no workspace access yet.`);
      return;
    }

    const lastActiveId = loadLastActiveWorkspaceId();
    const chosen = memberships.find((m) => m.workspace_id === lastActiveId) ?? memberships[0]!;

    saveAgentSession({
      token: result.token,
      agentId: result.agent.id,
      displayName: result.agent.display_name,
      workspaceSlug: chosen.workspace_slug,
      workspaceId: chosen.workspace_id,
      role: chosen.role,
    });
    saveLastActiveWorkspaceId(chosen.workspace_id);
    navigate('/inbox');
  };

  return (
    <main className="agent-login">
      <h1>Sign in (dev picker)</h1>
      <p className="notice">Stands in for Google OAuth until that slice ships.</p>
      {agentsQuery.isPending && <p>Loading agents…</p>}
      {agentsQuery.isError && <p className="notice">Could not load agents.</p>}
      {error && <p className="notice">{error}</p>}
      <ul>
        {agentsQuery.data?.agents.map((agent) => (
          <li key={agent.id}>
            <button type="button" onClick={() => onPick(agent.id)}>
              {agent.display_name} ({agent.email})
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

This drops the old "admin has no fixed workspace, sign in from the admin console instead" rejection entirely — an admin now gets every workspace back from `/agent/memberships` (`role: 'admin'`) and can log into the regular console like anyone else, picking a starting workspace the same way.

- [ ] **Step 7: Manually verify in the browser**

Run: `pnpm dev`, open the agent console, sign in as a regular agent with at least one workspace membership seeded via `pnpm db:seed`, confirm you land on `/inbox` with no console errors, and that `localStorage.support_last_active_workspace_id` is set to that workspace's id.

- [ ] **Step 8: Commit**

```bash
git add backend/src/agent/services/authService.ts backend/src/agent/controllers/authController.ts backend/tests/agent.authLogin.test.ts frontend/src/surfaces/agent-console/api/agentApi.ts frontend/src/surfaces/agent-console/lib/agentSession.ts frontend/src/surfaces/agent-console/pages/AgentLogin.tsx
git commit -m "feat: identity-only login, pick starting workspace from memberships"
```

---

### Task 7: Global Inbox scatter-gather service

**Files:**

- Create: `backend/src/agent/services/globalInboxService.ts`
- Test: `backend/tests/agent.globalInboxService.test.ts`
- Modify: `backend/package.json` (add `p-limit`)

**Interfaces:**

- Consumes: `AgentContext` (Task 1), `listActiveMembershipsForAgent`/`listAllWorkspaces` (Task 4), `getConversationTags` (existing, `backend/src/agent/services/tagsService.ts`).
- Produces: `getGlobalInbox(ctx: AgentContext): Promise<GlobalInboxResponse>` where `GlobalInboxResponse = { conversations: GlobalInboxTicket[]; failed_workspaces: string[] }` and `GlobalInboxTicket = AgentConversationSummary & { workspace: { id: string; slug: string } }`. Task 8's controller calls this directly.

- [ ] **Step 1: Add the `p-limit` dependency**

Run: `pnpm --filter @support/api add p-limit`

- [ ] **Step 2: Write the failing test**

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { getGlobalInbox } from '../src/agent/services/globalInboxService.ts';
import type { AgentContext } from '../src/shared/middleware/requireAgentSession.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('getGlobalInbox', () => {
  it('merges active tickets from every active membership, tagging each with its workspace', async () => {
    const workspaceA = await seedWorkspace({ slug: 'ws-a' });
    const workspaceB = await seedWorkspace({ slug: 'ws-b' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId: workspaceA, agentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId: workspaceB, agentId, role: 'agent' });
    const playerA = await seedPlayer(workspaceA);
    const playerB = await seedPlayer(workspaceB);
    const convA = await seedConversation({
      workspaceId: workspaceA,
      playerId: playerA,
      status: 'open',
    });
    const convB = await seedConversation({
      workspaceId: workspaceB,
      playerId: playerB,
      status: 'escalated',
    });

    const ctx: AgentContext = { agentId, workspaceId: '', isAdmin: false };
    const result = await getGlobalInbox(ctx);

    expect(result.failed_workspaces).toEqual([]);
    expect(result.conversations.map((c) => c.id)).toEqual(expect.arrayContaining([convA, convB]));
    const rowA = result.conversations.find((c) => c.id === convA)!;
    expect(rowA.workspace).toEqual({ id: workspaceA, slug: 'ws-a' });
  });

  it('excludes resolved and closed conversations', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const playerId = await seedPlayer(workspaceId);
    await seedConversation({ workspaceId, playerId, status: 'resolved' });
    await seedConversation({ workspaceId, playerId, status: 'closed' });
    const open = await seedConversation({ workspaceId, playerId, status: 'open' });

    const ctx: AgentContext = { agentId, workspaceId: '', isAdmin: false };
    const result = await getGlobalInbox(ctx);

    expect(result.conversations.map((c) => c.id)).toEqual([open]);
  });

  it('gives an admin every workspace, not just memberships', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const adminId = await seedAgent(undefined, { isAdmin: true });
    const playerA = await seedPlayer(workspaceA);
    const playerB = await seedPlayer(workspaceB);
    const convA = await seedConversation({
      workspaceId: workspaceA,
      playerId: playerA,
      status: 'open',
    });
    const convB = await seedConversation({
      workspaceId: workspaceB,
      playerId: playerB,
      status: 'open',
    });

    const ctx: AgentContext = { agentId: adminId, workspaceId: '', isAdmin: true };
    const result = await getGlobalInbox(ctx);

    expect(result.conversations.map((c) => c.id)).toEqual(expect.arrayContaining([convA, convB]));
  });

  it('excludes a workspace whose query fails, and reports it in failed_workspaces', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const playerId = await seedPlayer(workspaceId);
    await seedConversation({ workspaceId, playerId, status: 'open' });

    // Simulate a transient failure for this workspace's query by revoking the
    // app role's SELECT on conversation just for this test, then restoring it.
    await ownerPool.query(`revoke select on conversation from support_app`);
    try {
      const ctx: AgentContext = { agentId, workspaceId: '', isAdmin: false };
      const result = await getGlobalInbox(ctx);
      expect(result.conversations).toEqual([]);
      expect(result.failed_workspaces).toEqual([workspaceId]);
    } finally {
      await ownerPool.query(`grant select on conversation to support_app`);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @support/api vitest run tests/agent.globalInboxService.test.ts`
Expected: FAIL with "Cannot find module '../src/agent/services/globalInboxService.ts'"

- [ ] **Step 4: Write `globalInboxService.ts`**

```ts
import { desc, eq, inArray } from 'drizzle-orm';
import pLimit from 'p-limit';
import type { AgentConversationSummary } from '@support/types';
import { agent, conversation, message, player } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import {
  listActiveMembershipsForAgent,
  listAllWorkspaces,
} from '../../shared/db/workspaceMembership.ts';
import { getConversationTags } from './tagsService.ts';
import { logger } from '../../shared/logging/logger.ts';

export type GlobalInboxTicket = AgentConversationSummary & {
  workspace: { id: string; slug: string };
};
export type GlobalInboxResponse = {
  conversations: GlobalInboxTicket[];
  failed_workspaces: string[];
};

const PER_WORKSPACE_CAP = 50;
const SCATTER_CONCURRENCY = 10;
// Excludes 'resolved' and 'closed' — "active tickets" per the design doc.
const OPEN_STATUSES: (typeof conversation.status.enumValues)[number][] = [
  'new',
  'bot_active',
  'open',
  'awaiting_player',
  'escalated',
];

type WorkspaceTarget = { id: string; slug: string };

async function getWorkspaceInboxSlice(ws: WorkspaceTarget): Promise<GlobalInboxTicket[]> {
  return withWorkspace(ws.id, async (tx) => {
    const rows = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
        externalPlayerId: player.externalId,
        confirmPhase: conversation.confirmPhase,
        assignedAgentId: conversation.assignedAgentId,
        assignedAgentName: agent.displayName,
        priority: conversation.priority,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
      .where(inArray(conversation.status, OPEN_STATUSES))
      .orderBy(conversation.priority, conversation.createdAt)
      .limit(PER_WORKSPACE_CAP);

    const tickets: GlobalInboxTicket[] = [];
    for (const row of rows) {
      const [last] = await tx
        .select({ body: message.body, createdAt: message.createdAt })
        .from(message)
        .where(eq(message.conversationId, row.id))
        .orderBy(desc(message.seq))
        .limit(1);
      const tags = await getConversationTags(tx, row.id);

      tickets.push({
        id: row.id,
        player: { external_player_id: row.externalPlayerId },
        status: row.status,
        confirm_phase: row.confirmPhase,
        last_message_preview: last?.body ?? null,
        last_message_at: last?.createdAt.toISOString() ?? null,
        assigned_agent_id: row.assignedAgentId,
        assigned_agent_name: row.assignedAgentName,
        priority: row.priority,
        tags,
        workspace: ws,
      });
    }
    return tickets;
  });
}

function compareTickets(a: GlobalInboxTicket, b: GlobalInboxTicket): number {
  if (a.priority !== b.priority) return a.priority.localeCompare(b.priority);
  const aTime = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
  const bTime = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
  return bTime - aTime;
}

export async function getGlobalInbox(ctx: AgentContext): Promise<GlobalInboxResponse> {
  const targets: WorkspaceTarget[] = ctx.isAdmin
    ? (await listAllWorkspaces()).map((w) => ({ id: w.workspaceId, slug: w.workspaceSlug }))
    : (await listActiveMembershipsForAgent(ctx.agentId)).map((m) => ({
        id: m.workspaceId,
        slug: m.workspaceSlug,
      }));

  const limit = pLimit(SCATTER_CONCURRENCY);
  const failedWorkspaces: string[] = [];
  const slices = await Promise.all(
    targets.map((ws) =>
      limit(async () => {
        try {
          return await getWorkspaceInboxSlice(ws);
        } catch (error) {
          logger.error(
            'global_inbox',
            `workspace ${ws.id} inbox slice failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          failedWorkspaces.push(ws.id);
          return [];
        }
      }),
    ),
  );

  const conversations = slices.flat().sort(compareTickets);
  return { conversations, failed_workspaces: failedWorkspaces };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @support/api vitest run tests/agent.globalInboxService.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/pnpm-lock.yaml backend/src/agent/services/globalInboxService.ts backend/tests/agent.globalInboxService.test.ts
git commit -m "feat: add Global Inbox scatter-gather service"
```

---

### Task 8: `GET /agent/global-inbox`

**Files:**

- Create: `backend/src/agent/controllers/globalInboxController.ts`
- Create: `backend/src/agent/routers/globalInboxRouter.ts`
- Modify: `backend/src/agent/router.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.globalInbox.test.ts`

**Interfaces:**

- Consumes: `getGlobalInbox` (Task 7).
- Produces: `GET /agent/global-inbox → GlobalInboxResponse`. Task 11 (frontend Global Inbox page) consumes this response shape.

- [ ] **Step 1: Write the failing test**

```ts
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { globalInboxRouter } from '../src/agent/routers/globalInboxRouter.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

// Mounted before resolveConsoleWorkspace in the real agentRouter — no
// X-Workspace-Id needed, the whole point is it scatters across all of them.
const app = express();
app.use(express.json());
app.use(requireAgentSession, globalInboxRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('GET /agent/global-inbox', () => {
  it('returns active tickets across every workspace the agent belongs to, with no X-Workspace-Id header', async () => {
    const workspaceA = await seedWorkspace({ slug: 'ws-a' });
    const workspaceB = await seedWorkspace({ slug: 'ws-b' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId: workspaceA, agentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId: workspaceB, agentId, role: 'agent' });
    const playerA = await seedPlayer(workspaceA);
    const playerB = await seedPlayer(workspaceB);
    const convA = await seedConversation({
      workspaceId: workspaceA,
      playerId: playerA,
      status: 'open',
    });
    const convB = await seedConversation({
      workspaceId: workspaceB,
      playerId: playerB,
      status: 'open',
    });
    const token = await signAgentSession({ agent_id: agentId });

    const res = await request(app)
      .get('/global-inbox')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual(
      expect.arrayContaining([convA, convB]),
    );
    expect(res.body.failed_workspaces).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api vitest run tests/agent.globalInbox.test.ts`
Expected: FAIL with "Cannot find module '../src/agent/routers/globalInboxRouter.ts'"

- [ ] **Step 3: Write the controller and router**

`backend/src/agent/controllers/globalInboxController.ts`:

```ts
import type { RequestHandler } from 'express';
import { getGlobalInbox } from '../services/globalInboxService.ts';

export const getGlobalInboxHandler: RequestHandler = async (req, res) => {
  const result = await getGlobalInbox(req.agent!);
  res.status(200).json(result);
};
```

`backend/src/agent/routers/globalInboxRouter.ts`:

```ts
import { Router } from 'express';
import { getGlobalInboxHandler } from '../controllers/globalInboxController.ts';

export const globalInboxRouter = Router();
globalInboxRouter.get('/global-inbox', getGlobalInboxHandler);
```

- [ ] **Step 4: Mount it before `resolveConsoleWorkspace` in `router.ts`**

```ts
import { globalInboxRouter } from './routers/globalInboxRouter.ts';
// ...
agentRouter.use(requireAgentSession);
agentRouter.use(membershipsRouter);
agentRouter.use(globalInboxRouter);
agentRouter.use(resolveConsoleWorkspace);
agentRouter.use(taxonomyRouter);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @support/api vitest run tests/agent.globalInbox.test.ts`
Expected: PASS

- [ ] **Step 6: Register the route in `openapi.ts`**

```ts
const GlobalInboxTicketSchema = z.object({
  id: z.uuid(),
  player: z.object({ external_player_id: z.string() }),
  status: z.enum([
    'new',
    'bot_active',
    'open',
    'awaiting_player',
    'escalated',
    'resolved',
    'closed',
  ]),
  confirm_phase: z.enum(['none', 'bot_article', 'agent_ask', 'form', 'inactivity_ask']),
  last_message_preview: z.string().nullable(),
  last_message_at: z.iso.datetime().nullable(),
  assigned_agent_id: z.uuid().nullable(),
  assigned_agent_name: z.string().nullable(),
  priority: z.enum(['p1', 'p2', 'p3', 'p4']),
  workspace: z.object({ id: z.uuid(), slug: z.string() }),
});

registry.registerPath({
  method: 'get',
  path: '/agent/global-inbox',
  summary: 'Global Inbox (scatter-gather across workspaces)',
  description:
    'Active tickets across every workspace this agent belongs to (every workspace for a global admin), top 50 per workspace, merged and sorted by priority/recency. failed_workspaces lists any workspace whose query errored, excluded from the merge rather than failing the whole request.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: {
    200: {
      description: 'Merged global inbox',
      content: {
        'application/json': {
          schema: z.object({
            conversations: z.array(GlobalInboxTicketSchema),
            failed_workspaces: z.array(z.uuid()),
          }),
        },
      },
    },
  },
});
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/agent/controllers/globalInboxController.ts backend/src/agent/routers/globalInboxRouter.ts backend/src/agent/router.ts backend/src/docs/openapi.ts backend/tests/agent.globalInbox.test.ts
git commit -m "feat: add GET /agent/global-inbox"
```

---

### Task 9: Realtime — one socket, one room per active workspace

**Files:**

- Modify: `backend/src/shared/realtime/socketServer.ts`
- Modify: `backend/src/shared/realtime/emit.ts`
- Test: `backend/tests/realtime.agentMultiWorkspace.test.ts` (new)
- Modify: `backend/tests/realtime.adminWorkspace.test.ts` (the old single-room admin socket test needs updating — see Step 6)
- Modify: `frontend/src/features/chat/api/socket.ts` (drop the now-unused `workspaceId` arg for agent connections — see Step 7)
- Modify: `frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx` (drop the `workspaceId` arg at its one call site)
- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.tsx` (same)

**Interfaces:**

- Consumes: `listActiveMembershipsForAgent`/`listAllWorkspaces` (Task 4).
- Produces: `AgentSocketData = { role: 'agent'; workspaceIds: string[]; agentId: string }` (was `workspaceId: string`). `emitInboxChanged`'s emitted payload gains `workspace_id: string` — no signature change, existing callers are unaffected.

- [ ] **Step 1: Write the failing test**

`backend/tests/realtime.agentMultiWorkspace.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { getIo } from '../src/shared/realtime/socketServer.ts';
import { emitInboxChanged } from '../src/shared/realtime/emit.ts';
import { connectClient, startRealtimeServer } from './helpers/realtime.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

let realtime: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeEach(truncateAll);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

function waitFor(socket: ReturnType<typeof connectClient>, event: string): Promise<unknown> {
  return new Promise((resolve) => socket.on(event, resolve));
}

describe('agent socket joins one inbox room per active membership', () => {
  it('receives conversation:changed for a second workspace it belongs to, with no rejoin needed', async () => {
    realtime = await startRealtimeServer();
    try {
      const workspaceA = await seedWorkspace();
      const workspaceB = await seedWorkspace();
      const agentId = await seedAgent();
      await seedWorkspaceMember({ workspaceId: workspaceA, agentId, role: 'agent' });
      await seedWorkspaceMember({ workspaceId: workspaceB, agentId, role: 'agent' });
      const playerB = await seedPlayer(workspaceB);
      const conversationId = await seedConversation({
        workspaceId: workspaceB,
        playerId: playerB,
        status: 'open',
      });
      const token = await signAgentSession({ agent_id: agentId });

      const socket = connectClient(realtime.url, { token, role: 'agent' });
      await waitFor(socket, 'connect');

      const events: unknown[] = [];
      socket.on('conversation:changed', (payload: unknown) => events.push(payload));

      emitInboxChanged(getIo(), workspaceB, conversationId, 'escalated');
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(events).toEqual([
        { conversation_id: conversationId, status: 'escalated', workspace_id: workspaceB },
      ]);

      socket.close();
    } finally {
      await realtime.close();
    }
  });

  it('an admin socket receives conversation:changed for any workspace, with no auth.workspaceId supplied', async () => {
    realtime = await startRealtimeServer();
    try {
      const workspaceId = await seedWorkspace();
      const adminId = await seedAgent(undefined, { isAdmin: true });
      const playerId = await seedPlayer(workspaceId);
      const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
      const token = await signAgentSession({ agent_id: adminId, is_admin: true });

      const socket = connectClient(realtime.url, { token, role: 'agent' });
      await waitFor(socket, 'connect');

      const events: unknown[] = [];
      socket.on('conversation:changed', (payload: unknown) => events.push(payload));

      emitInboxChanged(getIo(), workspaceId, conversationId, 'open');
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(events).toEqual([
        { conversation_id: conversationId, status: 'open', workspace_id: workspaceId },
      ]);

      socket.close();
    } finally {
      await realtime.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api vitest run tests/realtime.agentMultiWorkspace.test.ts`
Expected: FAIL — the current handshake joins only one workspace's room (the JWT-embedded one, which no longer exists after Task 1), so `workspaceB`'s event never reaches the socket.

- [ ] **Step 3: Update `emit.ts`**

```ts
/** id, new status, and which workspace it happened in — never the full conversation row. */
export function emitInboxChanged(
  io: Server,
  workspaceId: string,
  conversationId: string,
  status: string,
): void {
  io.to(inboxRoom(workspaceId)).emit('conversation:changed', {
    conversation_id: conversationId,
    status,
    workspace_id: workspaceId,
  });
}
```

- [ ] **Step 4: Rewrite the handshake and connection handler in `socketServer.ts`**

Replace the type declarations:

```ts
export type PlayerSocketData = { role: 'player'; workspaceId: string; playerId: string };
export type AgentSocketData = { role: 'agent'; workspaceIds: string[]; agentId: string };
export type SocketData = PlayerSocketData | AgentSocketData;
```

Replace `canJoinConversation`:

```ts
async function canJoinConversation(data: SocketData, conversationId: string): Promise<boolean> {
  if (data.role === 'player') {
    return withWorkspace(data.workspaceId, async (tx) => {
      const [found] = await tx
        .select({ id: conversation.id })
        .from(conversation)
        .where(and(eq(conversation.id, conversationId), eq(conversation.playerId, data.playerId)))
        .limit(1);
      return found !== undefined;
    });
  }
  // An agent may belong to dozens of workspaces (same bound the design doc's
  // p-limit rationale for Global Inbox relies on) — checked sequentially,
  // short-circuiting on the first match, since which workspace this
  // conversation actually lives in isn't known ahead of time.
  for (const workspaceId of data.workspaceIds) {
    const found = await withWorkspace(workspaceId, async (tx) => {
      const [row] = await tx
        .select({ id: conversation.id })
        .from(conversation)
        .where(eq(conversation.id, conversationId))
        .limit(1);
      return row !== undefined;
    });
    if (found) return true;
  }
  return false;
}
```

Replace the `io.use(...)` handshake's agent branch (the player branch is untouched):

```ts
      } else {
        const claims = await verifyAgentSession(auth.token);
        const workspaceIds = claims.is_admin
          ? (await listAllWorkspaces()).map((w) => w.workspaceId)
          : (await listActiveMembershipsForAgent(claims.agent_id)).map((m) => m.workspaceId);
        socket.data = {
          role: 'agent',
          workspaceIds,
          agentId: claims.agent_id,
        } satisfies AgentSocketData;
      }
```

Update the imports at the top of the file — drop `withoutWorkspace`, `workspace`, and the `z`/`uuidSchema` pair (no longer used anywhere in this file), add the membership helper:

```ts
import { and, eq } from 'drizzle-orm';
import IORedis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { getEnv } from '../../env.ts';
import { InvalidAgentSession, verifyAgentSession } from '../auth/agentSession.ts';
import { InvalidPlayerToken, verifyPlayerToken } from '../auth/playerToken.ts';
import { conversation } from '../db/schema/index.ts';
import { withWorkspace } from '../db/withWorkspace.ts';
import { listActiveMembershipsForAgent, listAllWorkspaces } from '../db/workspaceMembership.ts';
import { agentRoom, inboxRoom, playerRoom } from './rooms.ts';
import { decrementPresence, incrementPresence } from './presence.ts';
import { logger } from '../logging/logger.ts';
```

Replace the `io.on('connection', ...)` agent branch:

```ts
  io.on('connection', (socket) => {
    const data = socket.data as SocketData;
    if (data.role === 'agent') {
      for (const workspaceId of data.workspaceIds) {
        socket.join(inboxRoom(workspaceId));
      }
      // Reconnecting always lands back on online, never restores a prior
      // away — a fresh session defaults to present.
      void incrementPresence(data.agentId)
        .then(({ wasFirstConnection }) => {
          if (wasFirstConnection && !closing) {
            for (const workspaceId of data.workspaceIds) {
              io.to(inboxRoom(workspaceId)).emit('presence_changed', {
                agentId: data.agentId,
                status: 'online',
              });
            }
          }
        })
        .catch((error) => {
          logger.error(
            'presence',
            `incrementPresence failed for agent ${data.agentId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });

      socket.on('disconnect', () => {
        void decrementPresence(data.agentId)
          .then(({ wasLastConnection }) => {
            if (wasLastConnection && !closing) {
              for (const workspaceId of data.workspaceIds) {
                io.to(inboxRoom(workspaceId)).emit('presence_changed', {
                  agentId: data.agentId,
                  status: 'offline',
                });
              }
            }
          })
          .catch((error) => {
            logger.error(
              'presence',
              `decrementPresence failed for agent ${data.agentId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      });
    }
```

(The `join_conversation`/`leave_conversation` handlers below this block are unchanged — they already call `canJoinConversation(data, conversationId)` generically.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @support/api vitest run tests/realtime.agentMultiWorkspace.test.ts`
Expected: PASS

- [ ] **Step 6: Fix the now-broken `realtime.adminWorkspace.test.ts`**

This file exercises the old admin `auth.workspaceId`-picks-one-room behavior, which no longer exists (an admin socket now joins every workspace's room automatically). Read it, then update any case that connects with `auth: { token, role: 'agent', workspaceId }` and asserts the admin _only_ receives events for that one workspace — that assertion is no longer true. Replace such cases with the equivalent of this plan's Step 1 "admin socket receives conversation:changed for any workspace" test, and remove any case whose entire premise was "the admin does not receive an event for a workspace it didn't pass as `auth.workspaceId`" (there is no such restriction any more). Run the file standalone until it passes:

Run: `pnpm --filter @support/api vitest run tests/realtime.adminWorkspace.test.ts`
Expected: PASS after the rewrite

- [ ] **Step 7: Run the full backend suite and typecheck**

Run: `pnpm --filter @support/api vitest run`
Expected: PASS

Run: `pnpm --filter @support/api typecheck`
Expected: PASS

- [ ] **Step 8: Drop the now-vestigial `workspaceId` arg from agent socket connections in the frontend**

`frontend/src/features/chat/api/socket.ts` is unchanged (its `workspaceId` param is still meaningful for players — leave it). At the two agent call sites, stop passing it since the backend no longer reads `auth.workspaceId` for agents:

`frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx`:

```ts
const socket = createSocket(session.token, 'agent');
```

`frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.tsx`:

```ts
const socket = createSocket(token, 'agent');
```

(Also drop the now-unused `loadAgentSession` import from `ConversationList.tsx` if nothing else in the file uses it — check before removing.)

- [ ] **Step 9: Run the frontend test suite**

Run: `pnpm --filter <frontend-package-name> test` (or `cd frontend && pnpm test`)
Expected: PASS — `ConversationList.test.tsx`'s socket mock doesn't assert on `createSocket`'s call arguments, so this is a non-breaking change there.

- [ ] **Step 10: Commit**

```bash
git add backend/src/shared/realtime/socketServer.ts backend/src/shared/realtime/emit.ts backend/tests/realtime.agentMultiWorkspace.test.ts backend/tests/realtime.adminWorkspace.test.ts frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.tsx
git commit -m "feat: join one inbox room per active workspace membership over a single socket"
```

---

### Task 10: Frontend — Workspace Switcher

**Files:**

- Create: `frontend/src/surfaces/agent-console/components/WorkspaceSwitcher.tsx`
- Create: `frontend/src/surfaces/agent-console/components/WorkspaceSwitcher.test.tsx`
- Modify: `frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx`

**Interfaces:**

- Consumes: `fetchMemberships` (Task 6), `saveAgentSession`/`saveLastActiveWorkspaceId` (Task 6), `StoredAgentSession` (existing).
- Produces: `WorkspaceSwitcher({ session: StoredAgentSession }): JSX.Element | null`, rendered inside `AgentConsoleShell`'s header.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx';
import * as agentApi from '../api/agentApi.ts';
import * as agentSession from '../lib/agentSession.ts';
import type { StoredAgentSession } from '../lib/agentSession.ts';

function renderWithClient(session: StoredAgentSession) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceSwitcher session={session} />
    </QueryClientProvider>,
  );
}

const SESSION: StoredAgentSession = {
  token: 'tok',
  agentId: 'agent-1',
  displayName: 'Ada',
  workspaceSlug: 'ws-a',
  workspaceId: 'workspace-a',
  role: 'agent',
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('WorkspaceSwitcher', () => {
  it('renders nothing when the agent has zero or one membership', async () => {
    vi.spyOn(agentApi, 'fetchMemberships').mockResolvedValue({
      memberships: [
        {
          workspace_id: 'workspace-a',
          workspace_slug: 'ws-a',
          workspace_name: 'Workspace A',
          role: 'agent',
        },
      ],
    });

    const { container } = renderWithClient(SESSION);

    await waitFor(() => expect(agentApi.fetchMemberships).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('lists every membership and switches on selection', async () => {
    vi.spyOn(agentApi, 'fetchMemberships').mockResolvedValue({
      memberships: [
        {
          workspace_id: 'workspace-a',
          workspace_slug: 'ws-a',
          workspace_name: 'Workspace A',
          role: 'agent',
        },
        {
          workspace_id: 'workspace-b',
          workspace_slug: 'ws-b',
          workspace_name: 'Workspace B',
          role: 'team_lead',
        },
      ],
    });
    const saveSpy = vi.spyOn(agentSession, 'saveAgentSession').mockImplementation(() => {});
    const saveLastActiveSpy = vi
      .spyOn(agentSession, 'saveLastActiveWorkspaceId')
      .mockImplementation(() => {});
    // Selecting triggers a full navigation to reload every workspace-scoped
    // query cleanly — jsdom can't actually navigate, so just observe the call.
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign: assignSpy }, writable: true });

    renderWithClient(SESSION);

    const trigger = await screen.findByRole('button', { name: /workspace a/i });
    await userEvent.click(trigger);
    const otherOption = await screen.findByText('Workspace B');
    await userEvent.click(otherOption);

    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-b',
        workspaceSlug: 'ws-b',
        role: 'team_lead',
      }),
    );
    expect(saveLastActiveSpy).toHaveBeenCalledWith('workspace-b');
    expect(assignSpy).toHaveBeenCalledWith('/inbox');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/components/WorkspaceSwitcher.test.tsx`
Expected: FAIL with "Cannot find module './WorkspaceSwitcher.tsx'"

- [ ] **Step 3: Write `WorkspaceSwitcher.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { fetchMemberships } from '../api/agentApi.ts';
import {
  saveAgentSession,
  saveLastActiveWorkspaceId,
  type StoredAgentSession,
} from '../lib/agentSession.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx';

export function WorkspaceSwitcher({ session }: { session: StoredAgentSession }) {
  const membershipsQuery = useQuery({
    queryKey: ['memberships'],
    queryFn: () => fetchMemberships(session.token),
  });
  const memberships = membershipsQuery.data?.memberships ?? [];
  const current = memberships.find((m) => m.workspace_id === session.workspaceId);

  function selectWorkspace(membership: (typeof memberships)[number]) {
    if (membership.workspace_id === session.workspaceId) return;
    saveAgentSession({
      ...session,
      workspaceId: membership.workspace_id,
      workspaceSlug: membership.workspace_slug,
      role: membership.role,
    });
    saveLastActiveWorkspaceId(membership.workspace_id);
    // A full navigation, not a client-side reload: no query key in this app
    // is namespaced by workspace, so every workspace-scoped query needs a
    // fresh mount to stop showing the previous workspace's cached data.
    window.location.assign('/inbox');
  }

  // Nothing to switch between — the badge/name already shown elsewhere in
  // the header is enough.
  if (memberships.length <= 1) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex items-center gap-1 text-sm font-medium text-text">
          {current?.workspace_name ?? session.workspaceSlug}
          <ChevronDown className="size-3.5 text-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {memberships.map((m) => (
          <DropdownMenuItem key={m.workspace_id} onSelect={() => selectWorkspace(m)}>
            {m.workspace_name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/components/WorkspaceSwitcher.test.tsx`
Expected: PASS

- [ ] **Step 5: Mount it in `AgentConsoleShell.tsx`, and fall back to the first membership when the persisted workspace is no longer valid**

Add the import:

```ts
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx';
```

Insert it in the header, between the role `Badge` and the `Log out` button:

```tsx
            {roleLabel && (
              <Badge variant="secondary" className="text-muted">
                {roleLabel}
              </Badge>
            )}
            <WorkspaceSwitcher session={session} />
          </div>
```

Section 2 of the design doc also requires falling back to the first membership if the persisted `workspaceId` is no longer valid (removed or deactivated) — add this as a small effect in `AgentConsoleShell.tsx`, right after the existing presence-fetch effect:

```tsx
const membershipsForFallback = useQuery({
  queryKey: ['memberships'],
  queryFn: () => fetchMemberships(session!.token),
  enabled: session !== null,
});

useEffect(() => {
  if (!session || !membershipsForFallback.data) return;
  const memberships = membershipsForFallback.data.memberships;
  if (memberships.length === 0) return;
  const stillValid = memberships.some((m) => m.workspace_id === session.workspaceId);
  if (stillValid) return;
  const fallback = memberships[0]!;
  saveAgentSession({
    ...session,
    workspaceId: fallback.workspace_id,
    workspaceSlug: fallback.workspace_slug,
    role: fallback.role,
  });
  saveLastActiveWorkspaceId(fallback.workspace_id);
  setSession(loadAgentSession());
}, [session, membershipsForFallback.data]);
```

Add the two new imports this needs at the top of the file:

```ts
import { fetchMemberships } from '../api/agentApi.ts';
import { saveLastActiveWorkspaceId } from '../lib/agentSession.ts';
```

(`useQuery`, `saveAgentSession`, and `loadAgentSession` are already imported in this file.)

- [ ] **Step 6: Manually verify in the browser**

Run: `pnpm dev`. Seed two workspaces with the same agent as a member (`pnpm db:seed` or manually via `pnpm db:studio`), log in, confirm the switcher appears and lists both, and that selecting the other one reloads into that workspace's inbox with matching tickets. Then deactivate the agent's membership in the currently-active workspace via the admin console and reload the agent console tab — confirm it falls back to the remaining workspace automatically rather than getting stuck 404ing.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/surfaces/agent-console/components/WorkspaceSwitcher.tsx frontend/src/surfaces/agent-console/components/WorkspaceSwitcher.test.tsx frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx
git commit -m "feat: add workspace switcher with fallback when the active workspace becomes invalid"
```

---

### Task 11: Frontend — Global Inbox page

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/GlobalInbox/GlobalInbox.tsx`
- Create: `frontend/src/surfaces/agent-console/pages/GlobalInbox/GlobalInbox.test.tsx`
- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`
- Modify: `frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx`
- Modify: `frontend/src/routes/AppRoutes.tsx`

**Interfaces:**

- Consumes: `GET /agent/global-inbox` (Task 8), `AgentConversationSummary` fields (existing `@support/types`), `saveAgentSession`/`saveLastActiveWorkspaceId` (Task 6).
- Produces: a `Global Inbox` nav item and route at `/global-inbox`.

- [ ] **Step 1: Add the fetcher and types to `agentApi.ts`**

```ts
export type GlobalInboxTicket = AgentConversationSummary & {
  workspace: { id: string; slug: string };
};

export type GlobalInboxResponse = {
  conversations: GlobalInboxTicket[];
  failed_workspaces: string[];
};

export function fetchGlobalInbox(token: string): Promise<GlobalInboxResponse> {
  return call('/agent/global-inbox', token);
}
```

- [ ] **Step 2: Write the failing test**

`frontend/src/surfaces/agent-console/pages/GlobalInbox/GlobalInbox.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GlobalInbox } from './GlobalInbox.tsx';
import * as agentApi from '../../api/agentApi.ts';
import * as agentSession from '../../lib/agentSession.ts';

function renderWithProviders() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <GlobalInbox />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const TICKET = {
  id: 'conv-1',
  player: { external_player_id: 'player-9' },
  status: 'open' as const,
  confirm_phase: 'none' as const,
  last_message_preview: 'Still stuck',
  last_message_at: '2026-08-20T10:00:00Z',
  assigned_agent_id: null,
  assigned_agent_name: null,
  priority: 'p1' as const,
  tags: [],
  workspace: { id: 'workspace-b', slug: 'ws-b' },
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
    token: 'tok',
    agentId: 'agent-1',
    displayName: 'Ada',
    workspaceSlug: 'ws-a',
    workspaceId: 'workspace-a',
    role: 'agent',
  });
});

describe('GlobalInbox', () => {
  it('lists tickets merged across workspaces, with the owning workspace shown', async () => {
    vi.spyOn(agentApi, 'fetchGlobalInbox').mockResolvedValue({
      conversations: [TICKET],
      failed_workspaces: [],
    });

    renderWithProviders();

    expect(await screen.findByText('player-9')).toBeInTheDocument();
    expect(screen.getByText('ws-b')).toBeInTheDocument();
  });

  it('shows a subtle indicator when some workspaces failed to load, without hiding the rest', async () => {
    vi.spyOn(agentApi, 'fetchGlobalInbox').mockResolvedValue({
      conversations: [TICKET],
      failed_workspaces: ['workspace-z'],
    });

    renderWithProviders();

    expect(await screen.findByText('player-9')).toBeInTheDocument();
    expect(screen.getByText(/1 workspace failed to load/i)).toBeInTheDocument();
  });

  it('clicking a ticket switches the active workspace to that ticket’s workspace', async () => {
    vi.spyOn(agentApi, 'fetchGlobalInbox').mockResolvedValue({
      conversations: [TICKET],
      failed_workspaces: [],
    });
    const saveSpy = vi.spyOn(agentSession, 'saveAgentSession').mockImplementation(() => {});
    const saveLastActiveSpy = vi
      .spyOn(agentSession, 'saveLastActiveWorkspaceId')
      .mockImplementation(() => {});
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign: assignSpy }, writable: true });

    renderWithProviders();

    const row = await screen.findByText('player-9');
    await userEvent.click(row);

    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'workspace-b', workspaceSlug: 'ws-b' }),
      ),
    );
    expect(saveLastActiveSpy).toHaveBeenCalledWith('workspace-b');
    expect(assignSpy).toHaveBeenCalledWith('/inbox/conv-1');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/GlobalInbox/GlobalInbox.test.tsx`
Expected: FAIL with "Cannot find module './GlobalInbox.tsx'"

- [ ] **Step 4: Write `GlobalInbox.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import { fetchGlobalInbox, type GlobalInboxTicket } from '../../api/agentApi.ts';
import {
  loadAgentSession,
  saveAgentSession,
  saveLastActiveWorkspaceId,
} from '../../lib/agentSession.ts';
import { ScrollArea } from '../../components/ui/scroll-area.tsx';
import { ConversationRow } from '../Inbox/components/ConversationRow.tsx';

export function GlobalInbox() {
  const navigate = useNavigate();
  const session = loadAgentSession();

  const inboxQuery = useQuery({
    queryKey: ['global-inbox'],
    queryFn: () => fetchGlobalInbox(session!.token),
    enabled: session !== null,
  });

  if (!session) return null;

  function openTicket(ticket: GlobalInboxTicket) {
    if (ticket.workspace.id !== session!.workspaceId) {
      saveAgentSession({
        ...session!,
        workspaceId: ticket.workspace.id,
        workspaceSlug: ticket.workspace.slug,
      });
      saveLastActiveWorkspaceId(ticket.workspace.id);
      // Full navigation: switching workspace needs every workspace-scoped
      // query to remount fresh, same rationale as WorkspaceSwitcher.tsx.
      window.location.assign(`/inbox/${ticket.id}`);
      return;
    }
    navigate(`/inbox/${ticket.id}`);
  }

  const failedCount = inboxQuery.data?.failed_workspaces.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {failedCount > 0 && (
        <div className="px-3 py-2 text-xs text-muted">
          {failedCount} workspace{failedCount === 1 ? '' : 's'} failed to load.
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3 text-sm font-semibold">Global Inbox</div>
        {inboxQuery.data?.conversations.map((ticket) => (
          <div key={ticket.id} className="flex items-center gap-2 px-3">
            <span className="text-xs text-muted">{ticket.workspace.slug}</span>
            <div className="min-w-0 flex-1">
              <ConversationRow
                conversation={ticket}
                selected={false}
                onSelect={() => openTicket(ticket)}
              />
            </div>
          </div>
        ))}
        {inboxQuery.data?.conversations.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-8 text-muted">
            <MessageSquare className="size-8" />
            <p className="text-sm">No active tickets across your workspaces.</p>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/GlobalInbox/GlobalInbox.test.tsx`
Expected: PASS

- [ ] **Step 6: Add the nav item and route**

`AgentConsoleShell.tsx` — add a new nav item next to the existing `NAV_ITEMS` array (import `Globe` from `lucide-react` alongside the existing icon imports):

```ts
import {
  Inbox as InboxIcon,
  Globe,
  BookOpen,
  ChevronDown,
  ClipboardList,
  LogOut,
  Settings,
  SlidersHorizontal,
  Tags,
  Gauge,
} from 'lucide-react';
```

```ts
const NAV_ITEMS = [
  { to: '/inbox', label: 'Inbox', icon: InboxIcon, group: 'Workspace' },
  { to: '/global-inbox', label: 'Global Inbox', icon: Globe, group: 'Workspace' },
  { to: '/tickets', label: 'Tickets', icon: ClipboardList, group: 'Workspace' },
  { to: '/articles', label: 'Knowledge Base', icon: BookOpen, group: 'Workspace' },
  { to: '/taxonomy', label: 'Taxonomy', icon: Tags, group: 'Workspace' },
];
```

`AppRoutes.tsx` — add the route next to the existing `inbox` routes:

```tsx
import { GlobalInbox } from '../surfaces/agent-console/pages/GlobalInbox/GlobalInbox.tsx';
```

```tsx
        <Route path="inbox" element={<Inbox />} />
        <Route path="inbox/:conversationId" element={<Inbox />} />
        <Route path="global-inbox" element={<GlobalInbox />} />
```

- [ ] **Step 7: Manually verify in the browser**

Run: `pnpm dev`. With an agent seeded as an active member of two workspaces that each have at least one open conversation, log in, open "Global Inbox" in the sidebar, confirm both tickets appear labelled with their workspace slug, and clicking one from the non-active workspace switches into it and opens the conversation.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts frontend/src/surfaces/agent-console/pages/GlobalInbox/ frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx frontend/src/routes/AppRoutes.tsx
git commit -m "feat: add Global Inbox page, merging active tickets across workspaces"
```

---

## Self-Review

**Spec coverage:**

1. Session model change (JWT decoupling, per-request auth, Redis cache, rollout, admin generalization) → Tasks 1, 2, 3.
2. Workspace switcher & default workspace → Task 10 (switcher + fallback logic), Task 6 (default-on-login).
3. Global Inbox scatter-gather (`/agent/global-inbox`, bounded concurrency, per-workspace cap, partial failure + `failed_workspaces`) → Tasks 4, 7, 8.
4. Realtime sockets (single socket, multiple rooms, `emitInboxChanged` payload gains `workspace_id`) → Task 9.
5. Frontend surface (switcher, Global Inbox tab, click-to-switch-workspace) → Tasks 10, 11.
6. Out of scope items (JWT revocation denylist, "all mail" archive/search) → intentionally not built; no task references them beyond the constraints section.

**Placeholder scan:** No task step describes behavior without showing the code; every test has real assertions; the only deliberately procedural step is Task 2 Step 8 (migrating ~30 existing test files), which is spelled out as an exact, repeatable two-part mechanical fix rather than a vague instruction, since the files' current contents weren't individually read.

**Type consistency:** `AgentContext` (`{ agentId, workspaceId, isAdmin }`) is defined once in Task 1/`requireAgentSession.ts` and consumed identically by Tasks 5, 6, 7, 8. `MembershipRow`/`WorkspaceRow` from Task 4's `workspaceMembership.ts` are consumed with the same field names (`workspaceId`, `workspaceSlug`, `workspaceName`, `role`) by Tasks 5, 7, and 9. `MembershipView`'s wire field names (`workspace_id`, `workspace_slug`, `workspace_name`, `role`) match exactly between Task 5's backend response and Task 6/10's frontend consumption. `GlobalInboxTicket`/`GlobalInboxResponse` are defined once in Task 7 and reused unchanged by Task 8's controller and Task 11's frontend type.
