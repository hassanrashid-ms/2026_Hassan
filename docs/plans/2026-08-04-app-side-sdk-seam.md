# App-side SDK Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `app` repo side of the Unity SDK seam — `POST /auth/player-token`, the four frozen `/sdk/*` endpoints, the session-timeout worker, and a deliberately-ugly web surface stub — so that a Unity build can open support, deliver a player-state snapshot, and end its session against a real server.

**Architecture:** A pnpm monorepo with three packages: `@support/types` (Zod wire schemas shared by server and web surface), `@support/api` (Express 5 + Drizzle + Postgres 17, tenant isolation by Row-Level Security), and `@support/web` (Vite + React player surface). Every request opens one transaction, sets `app.workspace_id` from the JWT, and lets RLS make cross-workspace access impossible. Every state change also appends a row to the append-only `event` table.

**Tech Stack:** Node 22 · pnpm · TypeScript (strict) · Express 5 · Zod 4 · Drizzle ORM + drizzle-kit · PostgreSQL 17 (`pgvector/pgvector:pg17`) · Redis 7 + BullMQ · Vitest + Supertest · Vite + React 19 · jose (JWT)

**Source specs (read before starting):**
- `docs/specs/2026-08-04-sdk-wire-contract.md` — **wins on request/response shapes**
- `docs/specs/2026-08-04-database-and-schema-design.md` — **wins on tables, columns, indexes**
- `../SDK/CRM/docs/specs/sdk-production-implementation.md` — the client half of the same contract
- `CLAUDE.md` — the summary of both plus the server decisions

**Scope:** build-order steps 1–3 of the wire contract. Step 4 (the Unity SDK) and step 5 (`POST /conversations`, `POST /messages`, chat UI, agent inbox) are **out of scope**.

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the specs.

**The contract is frozen.** *"Add response fields freely; never remove or retype one — old builds sit in app stores for years and cannot be recalled."* This applies to `/auth/player-token` and all four `/sdk/*` endpoints. It does **not** apply to `/surface/*`, which is versioned with the web app that calls it.

- **Unknown request fields are ignored, never rejected** — a newer SDK may send fields this server doesn't know yet, and it must still succeed.
- **Unknown `entry_point` values are accepted as-is.** Free-text label, not an enum.
- **Every `/sdk/*` endpoint returns `200` for anything recoverable.** Reserve `4xx` for auth failures and unparseable bodies.
- **Never `4xx` for a bad snapshot.** A malformed, empty or absent snapshot is a *state*: write the row with `is_missing = true` or `degraded_reason` set and return `200`.
- **The workspace comes from the JWT, never from `X-Support-Workspace`.** The header is only cross-checked so a misconfigured build fails loudly; a mismatch is `403`.
- **The SDK never holds a secret.** The workspace secret lives only in the game's own backend.
- **Player JWT TTL is 900 seconds (15 minutes).** Claims: `workspace_id`, `player_id`, `external_player_id`, `iat`, `exp`.
- **Tenancy is enforced by the database, not the ORM.** Every scoped table gets `CREATE POLICY tenant ON <t> USING (workspace_id = current_setting('app.workspace_id', true)::uuid)`; every request runs `SET LOCAL app.workspace_id` inside its transaction. Only `workspace` and `agent` are unscoped.
- **Cross-workspace reads return `404`, not `403`** — under RLS the rows are invisible, so the handler cannot distinguish "not yours" from "not there."
- **`event` is append-only** — enforced with `REVOKE UPDATE, DELETE`, not a convention.
- **No hard deletes anywhere; don't even write the route.** `ON DELETE RESTRICT` on every FK.
- **Missing data is a state, not an error.** Never a blank panel, never an error page, never a rejected write.
- **Treat `player_state_snapshot.raw` as PII by default** — uncontrolled client input, handled as personal data regardless of contents.
- **Never log a player token or a workspace secret.** Log the `Idempotency-Key`, `X-Support-Sdk` and `X-Support-Client-Version` values instead.
- Status values, delivery states and player-state keys are **lowercase snake_case**. Priority is `p1`–`p4`.
- User-facing copy uses **British spelling** (categorise, labelling, behaviour).
- **Self-serve rate counts sessions by `started_at`, never by `ended_at`** — a missing end must never silently shrink the denominator.

### Two additions to the schema spec

The schema doc's `workspace` and `session` rows do not carry the columns the wire contract requires. Both additions are recorded as an addendum in Task 17.

| Table | Added column | Why |
|---|---|---|
| `workspace` | `secret_hash text NOT NULL` | `POST /auth/player-token` authenticates with `Authorization: Bearer <workspace_secret>`; the secret has to be verifiable |
| `workspace` | `disabled_at timestamptz` | The wire contract requires `404` for a workspace that is *"not found **or disabled**"* |
| `session` | `ended_by session_end_reason` | The wire contract's timeout job marks closed sessions `ended_by = 'timeout'` |

### Three RLS traps that will bite

Written here because each one is invisible until it causes a cross-tenant bug.

1. **`SET LOCAL` cannot take a bind parameter.** `SET LOCAL app.workspace_id = $1` is a syntax error in Postgres. Use `select set_config('app.workspace_id', $1, true)`, which is a normal function call and parameterises fine.
2. **RLS does not apply to the table owner** unless the table is also `FORCE ROW LEVEL SECURITY`. The app therefore connects as a separate non-owner role (`support_app`) *and* every scoped table is forced, so neither a role mistake nor an owner connection can bypass a policy.
3. **Foreign-key checks bypass RLS.** They run as the referenced table's owner and ignore policies, so inserting a row that points at *another workspace's* `session_id` passes the FK check silently. **Any client-supplied id used as a FK must first be confirmed visible with an explicit RLS-scoped `SELECT`.** This affects `POST /sdk/incidents` (`session_id`) and both `/surface/*` routes.

---

## File Structure

```
/                                       (repo root — app repo, currently docs-only)
  package.json                          private root; scripts only
  pnpm-workspace.yaml
  .npmrc
  tsconfig.base.json
  docker-compose.yml                    Postgres 17 (pgvector) + Redis 7
  .env.example                          committed; .env is ignored
  .env.test.example

  packages/types/                       @support/types — the wire contract as Zod
    package.json  tsconfig.json
    src/index.ts                        barrel
    src/sdk-wire.ts                     the 4 SDK bodies + /auth/player-token
    src/player-state.ts                 declared/provider key constants
    src/surface.ts                      /surface/* shapes (not frozen)

  backend/                              @support/api
    package.json  tsconfig.json  drizzle.config.ts  vitest.config.ts
    src/env.ts                          Zod-validated process.env
    src/errors.ts                       error body shape + express error middleware
    src/app.ts                          express app factory (no listen)
    src/server.ts                       listen + job registration
    src/db/client.ts                    pg Pool + drizzle instance
    src/db/withWorkspace.ts             transaction helper; sets app.workspace_id
    src/db/schema/enums.ts
    src/db/schema/identity.ts           workspace, agent, workspaceMember
    src/db/schema/players.ts            player, session
    src/db/schema/playerState.ts        playerStateSnapshot, declaredField
    src/db/schema/conversations.ts      conversation, message  (minimal — see Task 3)
    src/db/schema/events.ts             event
    src/db/schema/index.ts              barrel
    src/db/sql/001_extensions.sql       citext
    src/db/sql/002_rls.sql              role, grants, policies, append-only
    src/db/setup.ts                     extensions → push → rls, idempotent
    src/db/seed.ts                      one workspace, one admin, 11 declared fields
    src/auth/jwt.ts                     sign/verify player token
    src/auth/workspaceSecret.ts         generate/parse/compare
    src/auth/playerTokenRoute.ts        POST /auth/player-token
    src/auth/requirePlayerToken.ts      JWT → req.player
    src/auth/requireSdkHeaders.ts       X-Support-* cross-check (｜/sdk/* only)
    src/events/appendEvent.ts
    src/playerState/split.ts            splitSnapshot()
    src/sdk/router.ts
    src/sdk/sessionsStart.ts
    src/sdk/sessionsEnd.ts
    src/sdk/incidents.ts
    src/sdk/unread.ts
    src/surface/router.ts
    src/surface/bootstrap.ts
    src/surface/articleRead.ts
    src/jobs/queue.ts                   BullMQ connection + queue/worker wiring
    src/jobs/sessionTimeout.ts          closeStaleSessions() + job handler
    tests/helpers/db.ts                 owner pool, truncate, factories
    tests/helpers/app.ts                supertest agent + token minting
    tests/globalSetup.ts                creates + sets up the test database
    tests/*.test.ts                     one file per task, named in each task

  frontend/                             @support/web — the player support surface
    package.json  tsconfig.json  vite.config.ts  index.html
    src/main.tsx
    src/boot.ts                         fragment/query parsing + URL scrubbing
    src/bridge.ts                       window.SupportBridge wrapper
    src/api.ts                          fetch wrapper carrying the player token
    src/SupportSurface.tsx              the whole stub UI
    src/styles.css
    src/boot.test.ts

  scripts/verify-seam.sh                the curl walkthrough from the build order
```

Each backend file has one responsibility and none exceeds ~150 lines. The split is by responsibility, not by layer: `src/sdk/` holds the frozen contract, `src/surface/` holds the unfrozen one, and `src/auth/` holds everything that turns a credential into a `req.player`.

**Deliberately deferred, with the migration that will add them:**

- The other 22 tables (taxonomy, knowledge + pgvector, forms, automation, `resolution_cycle`, `change_log`, `saved_filter`, `player_device`, `article_feedback`). Migration `002`, first task of the step-5 slice.
- **The `Other` intent and its catch-all subintent.** The build order says step 1 seeds *"one workspace and the `Other` taxonomy"* — impossible here, because `intent` and `subintent` do not exist yet. The seed moves to migration `002` and Task 17 records the deferral so it is not lost. Nothing in steps 1–3 classifies anything.
- `conversation.subintent_id`, `conversation.message_seq` incrementing, `resolution_cycle` — the minimal `conversation` and `message` tables in Task 3 exist only because `GET /sdk/unread` joins them.
- ESLint/Prettier. No linter has been decided for this repo; adding one is a separate decision, not a side effect of this plan.

---

### Task 1: Monorepo scaffold, Docker services, env loader

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `tsconfig.base.json`, `docker-compose.yml`, `.env.example`, `.env.test.example`
- Create: `backend/package.json`, `backend/tsconfig.json`, `backend/vitest.config.ts`, `backend/src/env.ts`
- Create: `packages/types/package.json` — **manifest only.** `backend/package.json` declares `"@support/types": "workspace:*"`, and `pnpm install` **hard-errors** with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` if the member does not exist. Write the exact manifest from Task 2 Step 1 and nothing else in that directory; Task 2 adds the tsconfig, the source files and the tests beside it. `main` pointing at a not-yet-existing `./src/index.ts` is harmless because nothing in Task 1 imports the package.
- Modify: `.gitignore`
- Test: `backend/tests/env.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `getEnv(): Env` and `loadEnv(source?: NodeJS.ProcessEnv): Env` from `backend/src/env.ts`, where `Env` has `NODE_ENV`, `PORT: number`, `DATABASE_URL: string`, `MIGRATION_DATABASE_URL: string`, `REDIS_URL: string`, `PLAYER_JWT_SECRET: string`, `PLAYER_TOKEN_TTL_SECONDS: number`, `SESSION_TIMEOUT_MINUTES: number`, `SURFACE_ORIGINS: string[]`.

- [ ] **Step 1: Write the root workspace manifests**

`pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
  - backend
  - frontend
```

`.npmrc`:

```ini
strict-peer-dependencies=false
auto-install-peers=true
```

`package.json`:

```json
{
  "name": "support-crm",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.0.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "pnpm --parallel --filter @support/api --filter @support/web dev",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "db:setup": "pnpm --filter @support/api db:setup",
    "db:seed": "pnpm --filter @support/api db:seed"
  }
}
```

Set `packageManager` to whatever `pnpm --version` reports on the machine; the value above is a placeholder for the pinning mechanism, not a version requirement.

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 2: Write `docker-compose.yml`**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    container_name: support-postgres
    environment:
      POSTGRES_USER: support_owner
      POSTGRES_PASSWORD: support_owner
      POSTGRES_DB: support
    ports: ["5432:5432"]
    volumes: ["support-pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U support_owner -d support"]
      interval: 5s
      timeout: 3s
      retries: 20

  redis:
    image: redis:7-alpine
    container_name: support-redis
    ports: ["6379:6379"]
    command: ["redis-server", "--appendonly", "yes"]
    volumes: ["support-redisdata:/data"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20

volumes:
  support-pgdata:
  support-redisdata:
```

Two services only. Redis is a queue and a pub/sub bus, not a system of record.

- [ ] **Step 3: Write `.env.example` and `.env.test.example`**

`.env.example`:

```bash
NODE_ENV=development
PORT=4000

# The app connects as support_app: a non-owner role with no BYPASSRLS.
DATABASE_URL=postgres://support_app:support_app@localhost:5432/support
# Migrations, RLS setup and test truncation connect as the owner.
MIGRATION_DATABASE_URL=postgres://support_owner:support_owner@localhost:5432/support

REDIS_URL=redis://localhost:6379

# 32+ chars. Generate with: openssl rand -base64 48
PLAYER_JWT_SECRET=change-me-change-me-change-me-change-me
PLAYER_TOKEN_TTL_SECONDS=900
SESSION_TIMEOUT_MINUTES=30

# Comma-separated origins allowed to call /surface/* from a browser.
SURFACE_ORIGINS=http://localhost:5173
```

`.env.test.example` is the same file with `NODE_ENV=test` and both URLs pointing at the `support_test` database.

- [ ] **Step 4: Extend `.gitignore`**

Read the existing file first, then ensure it contains at least:

```gitignore
node_modules/
dist/
.env
.env.test
*.log
.DS_Store
```

- [ ] **Step 5: Write `backend/package.json`**

```json
{
  "name": "@support/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch --experimental-strip-types src/server.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:setup": "node --experimental-strip-types src/db/setup.ts",
    "db:seed": "node --experimental-strip-types src/db/seed.ts"
  },
  "dependencies": {
    "@support/types": "workspace:*",
    "bullmq": "^5",
    "cors": "^2",
    "dotenv": "^16",
    "drizzle-orm": "latest",
    "express": "^5",
    "ioredis": "^5",
    "jose": "^6",
    "pg": "^8",
    "zod": "^4"
  },
  "devDependencies": {
    "@types/cors": "^2",
    "@types/express": "^5",
    "@types/node": "^22",
    "@types/pg": "^8",
    "@types/supertest": "^6",
    "drizzle-kit": "latest",
    "supertest": "^7",
    "typescript": "^5",
    "vitest": "latest"
  }
}
```

`drizzle-orm`, `drizzle-kit` and `vitest` are `latest` on purpose: drizzle is pre-1.0 and pinning a minor here would be guessing. Run `pnpm install`, then record the resolved versions in `pnpm-lock.yaml` (committed) and note them in the Task 17 README update.

`backend/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"],
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src", "tests", "drizzle.config.ts", "vitest.config.ts"]
}
```

- [ ] **Step 6: Write the failing test**

`backend/tests/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/env.ts'

const valid = {
  DATABASE_URL: 'postgres://support_app:pw@localhost:5432/support',
  MIGRATION_DATABASE_URL: 'postgres://support_owner:pw@localhost:5432/support',
  REDIS_URL: 'redis://localhost:6379',
  PLAYER_JWT_SECRET: 'x'.repeat(32),
}

describe('loadEnv', () => {
  it('applies the documented defaults', () => {
    const env = loadEnv(valid)
    expect(env.NODE_ENV).toBe('development')
    expect(env.PORT).toBe(4000)
    expect(env.PLAYER_TOKEN_TTL_SECONDS).toBe(900)
    expect(env.SESSION_TIMEOUT_MINUTES).toBe(30)
    expect(env.SURFACE_ORIGINS).toEqual(['http://localhost:5173'])
  })

  it('coerces numeric strings', () => {
    expect(loadEnv({ ...valid, PORT: '5000' }).PORT).toBe(5000)
  })

  it('splits and trims SURFACE_ORIGINS', () => {
    const env = loadEnv({ ...valid, SURFACE_ORIGINS: 'https://a.test, https://b.test' })
    expect(env.SURFACE_ORIGINS).toEqual(['https://a.test', 'https://b.test'])
  })

  it('throws when DATABASE_URL is missing', () => {
    const { DATABASE_URL, ...rest } = valid
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/)
  })

  it('throws when PLAYER_JWT_SECRET is too short to be worth having', () => {
    expect(() => loadEnv({ ...valid, PLAYER_JWT_SECRET: 'short' })).toThrow(/PLAYER_JWT_SECRET/)
  })
})
```

`backend/vitest.config.ts` — a single fork, because every test shares one Postgres database and RLS state lives in transactions:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/globalSetup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
})
```

`tests/globalSetup.ts` is a no-op stub in this task — it gains a body in Task 3:

```ts
export default async function setup() {
  // Task 3 replaces this with: create the test database, then run db/setup.
}
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm --filter @support/api test`
Expected: FAIL — `Cannot find module '../src/env.ts'`

- [ ] **Step 8: Write `backend/src/env.ts`**

```ts
import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  MIGRATION_DATABASE_URL: z.string().min(1, 'MIGRATION_DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  PLAYER_JWT_SECRET: z
    .string()
    .min(32, 'PLAYER_JWT_SECRET must be at least 32 characters'),
  PLAYER_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  SESSION_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),
  SURFACE_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
})

export type Env = z.infer<typeof EnvSchema>

export function loadEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment:\n${detail}`)
  }
  return parsed.data
}

let cached: Env | undefined

/** Memoised so a bad env fails once, loudly, rather than on every call. */
export function getEnv(): Env {
  cached ??= loadEnv()
  return cached
}

/** Tests only — forces the next getEnv() to re-read process.env. */
export function resetEnvCache(): void {
  cached = undefined
}
```

The issue-path prefix is what makes the `/DATABASE_URL/` and `/PLAYER_JWT_SECRET/` assertions pass.

Database URLs are `z.string().min(1)` rather than `z.url()`: `postgres://` is a valid URL but WHATWG parsing of Postgres connection strings is inconsistent across Node versions, and `pg` is the real validator.

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm --filter @support/api test`
Expected: PASS — 5 tests

- [ ] **Step 10: Verify the services come up**

```bash
cp .env.example .env
docker compose up -d
docker compose ps          # both containers healthy
docker compose exec postgres psql -U support_owner -d support -c 'select version()'
```

Expected: `PostgreSQL 17.x`. If the port is taken, change the host side of the mapping and `.env` together.

- [ ] **Step 11: Commit**

```bash
git add package.json pnpm-workspace.yaml .npmrc tsconfig.base.json docker-compose.yml \
        .env.example .env.test.example .gitignore pnpm-lock.yaml \
        backend/package.json backend/tsconfig.json backend/vitest.config.ts \
        backend/src/env.ts backend/tests/env.test.ts backend/tests/globalSetup.ts
git commit -m "feat: pnpm workspace, Postgres 17 + Redis compose, validated env"
```

---

### Task 2: `@support/types` — the wire contract as Zod

**Files:**
- Verify (already created by Task 1, as the workspace member `pnpm install` needs): `packages/types/package.json`. Confirm it matches Step 1 below and move on.
- Create: `packages/types/tsconfig.json`
- Create: `packages/types/src/index.ts`, `src/sdk-wire.ts`, `src/player-state.ts`, `src/surface.ts`
- Test: `packages/types/tests/sdk-wire.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, all from `@support/types`:
  - `PlayerTokenRequest` (Zod), `PlayerTokenResponse` (type `{ token: string; expires_in: number }`)
  - `SessionStartBody`, `SessionEndBody`, `IncidentBody` (Zod) and their inferred types
  - `UnreadResponse` (type `{ unread_count: number }`)
  - `SDK_HEADERS` — `{ idempotencyKey: 'idempotency-key', workspace: 'x-support-workspace', sdkVersion: 'x-support-sdk', clientVersion: 'x-support-client-version' }`
  - `DECLARED_FIELD_KEYS: readonly string[]` (11 keys), `PROVIDER_FIELD_KEYS: readonly string[]` (6 keys), `DECLARED_FIELD_SEED: readonly { key, label, type }[]`
  - `coerceInstant(input: unknown, fallback?: Date): Date`

- [ ] **Step 1: Write the package manifests**

`packages/types/package.json`:

```json
{
  "name": "@support/types",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^4" },
  "devDependencies": { "typescript": "^5", "vitest": "latest" }
}
```

Consumers import the TypeScript source directly — no build step, because both consumers already run TypeScript (`--experimental-strip-types` on the server, Vite on the web).

`packages/types/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "allowImportingTsExtensions": true },
  "include": ["src", "tests"]
}
```

- [ ] **Step 2: Write the failing test**

`packages/types/tests/sdk-wire.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  DECLARED_FIELD_KEYS,
  IncidentBody,
  PROVIDER_FIELD_KEYS,
  PlayerTokenRequest,
  SessionEndBody,
  SessionStartBody,
  coerceInstant,
} from '../src/index.ts'

// Verbatim from docs/specs/2026-08-04-sdk-wire-contract.md
const START_EXAMPLE = {
  session_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  entry_point: 'settings_menu',
  started_at: '2026-08-04T09:12:00Z',
  snapshot: {
    player_id: 'UserId7661',
    client_version: '6.2.01',
    platform: 'ios',
    os_version: '26.5.2',
    device_model: 'iPhone 13 Pro Max',
    locale: 'en-GB',
    player_level: 34,
    total_spend: 0.0,
    spend_tier: 'non-payer',
    account_created_at: '2026-07-27T09:12:00Z',
    last_session_at: '2026-08-03T08:40:00Z',
    extra: { ab_bucket: 'B', collection_status: 'event_in_progress' },
    degraded_reason: null,
  },
}

describe('SessionStartBody', () => {
  it('accepts the spec example unchanged', () => {
    const parsed = SessionStartBody.parse(START_EXAMPLE)
    expect(parsed.session_id).toBe(START_EXAMPLE.session_id)
    expect(parsed.entry_point).toBe('settings_menu')
    expect(parsed.snapshot).toEqual(START_EXAMPLE.snapshot)
  })

  it('ignores unknown request fields rather than rejecting them', () => {
    const parsed = SessionStartBody.parse({ ...START_EXAMPLE, invented_by_a_newer_sdk: true })
    expect(parsed.session_id).toBe(START_EXAMPLE.session_id)
  })

  it('accepts an unknown entry_point as-is', () => {
    const parsed = SessionStartBody.parse({ ...START_EXAMPLE, entry_point: 'brand_new_screen' })
    expect(parsed.entry_point).toBe('brand_new_screen')
  })

  it('falls back rather than failing on a missing or absurd entry_point', () => {
    expect(SessionStartBody.parse({ ...START_EXAMPLE, entry_point: undefined }).entry_point).toBe('unknown')
    expect(SessionStartBody.parse({ ...START_EXAMPLE, entry_point: 42 }).entry_point).toBe('unknown')
  })

  it('keeps a garbage snapshot instead of rejecting the request', () => {
    expect(SessionStartBody.parse({ ...START_EXAMPLE, snapshot: 'not an object' }).snapshot).toBe('not an object')
    expect(SessionStartBody.parse({ ...START_EXAMPLE, snapshot: undefined }).snapshot).toBeUndefined()
  })

  it('rejects a body with no usable session_id — that one is unparseable', () => {
    expect(SessionStartBody.safeParse({ ...START_EXAMPLE, session_id: 'nope' }).success).toBe(false)
    expect(SessionStartBody.safeParse({ ...START_EXAMPLE, session_id: undefined }).success).toBe(false)
  })
})

describe('SessionEndBody', () => {
  it('accepts the spec example', () => {
    const parsed = SessionEndBody.parse({
      session_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      duration_ms: 184200,
      conversation_created: false,
      articles_read: ['a_123', 'a_456'],
    })
    expect(parsed.duration_ms).toBe(184200)
    expect(parsed.articles_read).toEqual(['a_123', 'a_456'])
  })

  it('tolerates every untrusted field being absent or wrong-typed', () => {
    const parsed = SessionEndBody.parse({ session_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })
    expect(parsed.duration_ms).toBeNull()
    expect(parsed.conversation_created).toBeNull()
    expect(parsed.articles_read).toEqual([])
  })
})

describe('IncidentBody', () => {
  it('accepts the spec example', () => {
    const parsed = IncidentBody.parse({
      incident_id: 'c7a2ffff-4f89-11d3-9a0c-0305e82c3301',
      session_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      kind: 'token_timeout',
      detail: '5s elapsed, no response',
      sdk_version: '1.0.2',
      client_version: '6.2.01',
    })
    expect(parsed.kind).toBe('token_timeout')
  })

  it('accepts a null session_id — the SDK may fail before a session exists', () => {
    expect(IncidentBody.parse({ kind: 'webview_init_failed', session_id: null }).session_id).toBeNull()
  })

  it('accepts an unknown kind', () => {
    expect(IncidentBody.parse({ kind: 'something_new' }).kind).toBe('something_new')
  })
})

describe('PlayerTokenRequest', () => {
  it('accepts the spec example', () => {
    expect(PlayerTokenRequest.parse({ external_player_id: 'UserId7661' }).external_player_id).toBe('UserId7661')
  })

  it('rejects a malformed external_player_id', () => {
    expect(PlayerTokenRequest.safeParse({ external_player_id: '' }).success).toBe(false)
    expect(PlayerTokenRequest.safeParse({ external_player_id: 'a'.repeat(200) }).success).toBe(false)
    expect(PlayerTokenRequest.safeParse({ external_player_id: 'has space' }).success).toBe(false)
    expect(PlayerTokenRequest.safeParse({}).success).toBe(false)
  })
})

describe('declared field constants', () => {
  it('lists the 11 keys expected on every conversation', () => {
    expect(DECLARED_FIELD_KEYS).toHaveLength(11)
    expect([...DECLARED_FIELD_KEYS]).toEqual([
      'player_id',
      'client_version',
      'platform',
      'os_version',
      'device_model',
      'locale',
      'player_level',
      'total_spend',
      'spend_tier',
      'account_created_at',
      'last_session_at',
    ])
  })

  it('lists the 6 provider-supplied keys as a subset', () => {
    expect(PROVIDER_FIELD_KEYS).toHaveLength(6)
    for (const key of PROVIDER_FIELD_KEYS) expect(DECLARED_FIELD_KEYS).toContain(key)
  })
})

describe('coerceInstant', () => {
  const fallback = new Date('2026-08-04T10:00:00Z')

  it('accepts a sane ISO-8601 timestamp', () => {
    expect(coerceInstant('2026-08-04T09:12:00Z', fallback).toISOString()).toBe('2026-08-04T09:12:00.000Z')
  })

  it('falls back on junk, on a device clock in the far future, and on a prehistoric one', () => {
    expect(coerceInstant('yesterday-ish', fallback)).toEqual(fallback)
    expect(coerceInstant('2099-01-01T00:00:00Z', fallback)).toEqual(fallback)
    expect(coerceInstant('1999-01-01T00:00:00Z', fallback)).toEqual(fallback)
    expect(coerceInstant(undefined, fallback)).toEqual(fallback)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @support/types test`
Expected: FAIL — `Cannot find module '../src/index.ts'`

- [ ] **Step 4: Write `packages/types/src/player-state.ts`**

```ts
/**
 * The declared set expected on every conversation, per CLAUDE.md.
 * Order matters only for the readability of the seed.
 */
export const DECLARED_FIELD_KEYS = [
  'player_id',
  'client_version',
  'platform',
  'os_version',
  'device_model',
  'locale',
  'player_level',
  'total_spend',
  'spend_tier',
  'account_created_at',
  'last_session_at',
] as const

/**
 * The six the game's IPlayerStateProvider supplies. The rest come from the SDK's
 * DeviceProbe with no game involvement, so they are present even when the provider
 * throws on everything — which is exactly why `is_missing` is judged on these six
 * alone. See splitSnapshot() in the backend.
 */
export const PROVIDER_FIELD_KEYS = [
  'player_id',
  'player_level',
  'total_spend',
  'spend_tier',
  'account_created_at',
  'last_session_at',
] as const

export type DeclaredFieldType = 'string' | 'number' | 'boolean' | 'timestamp'

export const DECLARED_FIELD_SEED: readonly {
  key: (typeof DECLARED_FIELD_KEYS)[number]
  label: string
  type: DeclaredFieldType
}[] = [
  { key: 'player_id', label: 'Player ID', type: 'string' },
  { key: 'client_version', label: 'Client version', type: 'string' },
  { key: 'platform', label: 'Platform', type: 'string' },
  { key: 'os_version', label: 'OS version', type: 'string' },
  { key: 'device_model', label: 'Device model', type: 'string' },
  { key: 'locale', label: 'Locale', type: 'string' },
  { key: 'player_level', label: 'Player level', type: 'number' },
  { key: 'total_spend', label: 'Total spend', type: 'number' },
  { key: 'spend_tier', label: 'Spend tier', type: 'string' },
  { key: 'account_created_at', label: 'Account created', type: 'timestamp' },
  { key: 'last_session_at', label: 'Last session', type: 'timestamp' },
]
```

- [ ] **Step 5: Write `packages/types/src/sdk-wire.ts`**

```ts
import { z } from 'zod'

/** Lowercase, because Node lowercases incoming header names. */
export const SDK_HEADERS = {
  idempotencyKey: 'idempotency-key',
  workspace: 'x-support-workspace',
  sdkVersion: 'x-support-sdk',
  clientVersion: 'x-support-client-version',
} as const

const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2020, 0, 1)

/**
 * Device clocks lie. A timestamp that is unparseable, more than 24h in the future,
 * or from before 2020 is replaced by the fallback rather than rejected — the
 * request is still a real visit and must still be recorded.
 */
export function coerceInstant(input: unknown, fallback: Date = new Date()): Date {
  if (typeof input !== 'string' && !(input instanceof Date)) return fallback
  const candidate = input instanceof Date ? input : new Date(input)
  const ms = candidate.getTime()
  if (Number.isNaN(ms)) return fallback
  if (ms > fallback.getTime() + MAX_FUTURE_SKEW_MS) return fallback
  if (ms < EARLIEST_PLAUSIBLE_MS) return fallback
  return candidate
}

/** Free text, never an enum, so a game can add an entry point with no server release. */
const entryPoint = z.string().min(1).max(120).catch('unknown')

/**
 * `snapshot` is z.unknown(): anything the SDK sends survives to the splitter, and
 * a malformed snapshot is a state rather than a 422. Only `session_id` is
 * load-bearing enough to fail on — it is the primary key.
 */
export const SessionStartBody = z.object({
  session_id: z.uuid(),
  entry_point: entryPoint,
  started_at: z.unknown().optional(),
  snapshot: z.unknown().optional(),
})
export type SessionStartBody = z.infer<typeof SessionStartBody>

/**
 * duration_ms, conversation_created and articles_read are recorded but not trusted —
 * all three are derivable server-side. They exist for cross-checking a suspected
 * bug, so a wrong type becomes null rather than a rejection.
 */
export const SessionEndBody = z.object({
  session_id: z.uuid(),
  duration_ms: z.number().int().nonnegative().nullish().catch(null),
  conversation_created: z.boolean().nullish().catch(null),
  articles_read: z.array(z.string().max(200)).max(500).catch([]),
})
export type SessionEndBody = z.infer<typeof SessionEndBody>

/** Always 200 if the body parses: an incident report that itself errors is worse than useless. */
export const IncidentBody = z.object({
  incident_id: z.uuid().nullish().catch(null),
  session_id: z.uuid().nullish().catch(null),
  kind: z.string().min(1).max(120).catch('unknown'),
  detail: z.string().max(2000).catch(''),
  sdk_version: z.string().max(60).catch(''),
  client_version: z.string().max(60).catch(''),
})
export type IncidentBody = z.infer<typeof IncidentBody>

export type UnreadResponse = { unread_count: number }

export const PlayerTokenRequest = z.object({
  external_player_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
})
export type PlayerTokenRequest = z.infer<typeof PlayerTokenRequest>

export type PlayerTokenResponse = { token: string; expires_in: number }
```

Note on `z.object()` and unknown keys: Zod strips them silently by default, which is precisely the *"unknown request fields are ignored, never rejected"* rule. Never add `.strict()` to any schema in this file — it would make a newer SDK's request fail.

- [ ] **Step 6: Write `packages/types/src/surface.ts`**

```ts
import { z } from 'zod'

/**
 * NOT part of the frozen contract. The web surface ships with the server, so these
 * shapes may change freely — unlike anything in sdk-wire.ts.
 */
export const BootstrapQuery = z.object({ session_id: z.uuid() })

export const ArticleReadBody = z.object({
  session_id: z.uuid(),
  article_id: z.string().min(1).max(200),
})

export type PlayerStateAvailability = 'ok' | 'degraded' | 'missing' | 'absent'

export type BootstrapResponse = {
  session: { id: string; entry_point: string; started_at: string; ended_at: string | null }
  player: { external_player_id: string }
  player_state: {
    availability: PlayerStateAvailability
    captured_at: string | null
    degraded_reason: string | null
    declared: Record<string, unknown>
    raw?: Record<string, unknown>
  }
  unread_count: number
}
```

- [ ] **Step 7: Write `packages/types/src/index.ts`**

```ts
export * from './player-state.ts'
export * from './sdk-wire.ts'
export * from './surface.ts'
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @support/types test`
Expected: PASS — 17 tests

- [ ] **Step 9: Commit**

```bash
git add packages/types pnpm-lock.yaml
git commit -m "feat(types): the SDK wire contract as Zod schemas, additive-only"
```

---

### Task 3: Drizzle schema and the `db:setup` pipeline

**Files:**
- Create: `backend/drizzle.config.ts`
- Create: `backend/src/db/schema/enums.ts`, `identity.ts`, `players.ts`, `playerState.ts`, `conversations.ts`, `events.ts`, `index.ts`
- Create: `backend/src/db/client.ts`, `backend/src/db/sql/001_extensions.sql`, `backend/src/db/setup.ts`
- Modify: `backend/tests/globalSetup.ts`
- Test: `backend/tests/schema.test.ts`, `backend/tests/helpers/db.ts`

**Interfaces:**
- Consumes: `getEnv()` from Task 1.
- Produces:
  - `backend/src/db/schema/index.ts` re-exports tables `workspace`, `agent`, `workspaceMember`, `player`, `session`, `playerStateSnapshot`, `declaredField`, `conversation`, `message`, `event` and every pgEnum.
  - `backend/src/db/client.ts` exports `pool: Pool`, `db`, `type Db`, and `closeDb(): Promise<void>`.
  - `backend/src/db/setup.ts` exports `setupDatabase(url: string): Promise<void>`.
  - `backend/tests/helpers/db.ts` exports `ownerPool`, `truncateAll()`, `closeOwnerPool()`.
- Note for later tasks: `session.id` has **no default** — it is always supplied by the client.

- [ ] **Step 1: Write the failing test**

`backend/tests/schema.test.ts` asserts against `information_schema`, so it fails until both the schema files and the push exist:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ownerPool, closeOwnerPool } from './helpers/db.ts'

const EXPECTED_TABLES = [
  'agent',
  'conversation',
  'declared_field',
  'event',
  'message',
  'player',
  'player_state_snapshot',
  'session',
  'workspace',
  'workspace_member',
]

async function columns(table: string): Promise<Map<string, { type: string; nullable: boolean; hasDefault: boolean }>> {
  const { rows } = await ownerPool.query<{
    column_name: string
    data_type: string
    is_nullable: string
    column_default: string | null
  }>(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  )
  return new Map(
    rows.map((r) => [
      r.column_name,
      { type: r.data_type, nullable: r.is_nullable === 'YES', hasDefault: r.column_default !== null },
    ]),
  )
}

describe('schema', () => {
  afterAll(closeOwnerPool)

  it('creates exactly the ten tables of the SDK-path subset', async () => {
    const { rows } = await ownerPool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`,
    )
    expect(rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES)
  })

  it('gives session a client-supplied primary key with no default', async () => {
    const cols = await columns('session')
    expect(cols.get('id')?.hasDefault).toBe(false)
    expect(cols.get('ended_at')?.nullable).toBe(true)
    expect(cols.get('ended_by')?.nullable).toBe(true)
    expect(cols.get('entry_point')?.nullable).toBe(false)
  })

  it('carries the two columns the wire contract adds to workspace', async () => {
    const cols = await columns('workspace')
    expect(cols.get('secret_hash')?.nullable).toBe(false)
    expect(cols.get('disabled_at')?.nullable).toBe(true)
  })

  it('stores the snapshot split as two jsonb columns keyed to the session', async () => {
    const cols = await columns('player_state_snapshot')
    expect(cols.get('declared')?.type).toBe('jsonb')
    expect(cols.get('raw')?.type).toBe('jsonb')
    expect(cols.get('is_missing')?.nullable).toBe(false)
    expect(cols.get('degraded_reason')?.nullable).toBe(true)
    expect(cols.get('captured_at')?.nullable).toBe(false)

    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'player_state_snapshot'`,
    )
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/UNIQUE.*\(session_id\)/)
    expect(defs).toMatch(/gin \(declared jsonb_path_ops\)/)
  })

  it('indexes event for time-range scans and per-conversation reads', async () => {
    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'event'`,
    )
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/USING brin \(occurred_at\)/)
    expect(defs).toMatch(/\(conversation_id, occurred_at\)/)
  })

  it('carries workspace_id on every table except workspace and agent', async () => {
    for (const table of EXPECTED_TABLES) {
      const cols = await columns(table)
      const expected = table === 'workspace' || table === 'agent'
      expect(cols.has('workspace_id'), `${table}.workspace_id`).toBe(!expected)
    }
  })

  it('restricts every delete rather than cascading', async () => {
    const { rows } = await ownerPool.query<{ conname: string; confdeltype: string }>(
      `select conname, confdeltype from pg_constraint where contype = 'f'`,
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.confdeltype, row.conname).toBe('r') // r = RESTRICT
  })

  it('makes (conversation_id, seq) unique so ordering cannot collide', async () => {
    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'message'`,
    )
    expect(rows.map((r) => r.indexdef).join('\n')).toMatch(/UNIQUE.*\(conversation_id, seq\)/)
  })
})
```

`backend/tests/helpers/db.ts`:

```ts
import { Pool } from 'pg'
import { getEnv } from '../../src/env.ts'

/**
 * Tests connect as the owner for setup and teardown: TRUNCATE is an owner-only
 * privilege and support_app is deliberately never granted DELETE.
 */
export const ownerPool = new Pool({ connectionString: getEnv().MIGRATION_DATABASE_URL, max: 4 })

const SCOPED_TABLES = [
  'event',
  'message',
  'conversation',
  'player_state_snapshot',
  'declared_field',
  'session',
  'player',
  'workspace_member',
  'agent',
  'workspace',
]

export async function truncateAll(): Promise<void> {
  await ownerPool.query(`truncate table ${SCOPED_TABLES.join(', ')} restart identity cascade`)
}

export async function closeOwnerPool(): Promise<void> {
  await ownerPool.end()
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api test schema`
Expected: FAIL — relation "workspace" does not exist / module not found

- [ ] **Step 3: Write `backend/src/db/schema/enums.ts`**

```ts
import { pgEnum } from 'drizzle-orm/pg-core'

// Closed sets, per the schema spec: "an invalid status becomes impossible, not merely untested".
export const agentStatus = pgEnum('agent_status', ['active', 'on_leave', 'deactivated'])
export const workspaceRole = pgEnum('workspace_role', ['agent', 'team_lead', 'admin'])
export const sessionEndReason = pgEnum('session_end_reason', ['client', 'timeout'])
export const conversationStatus = pgEnum('conversation_status', [
  'new',
  'bot_active',
  'open',
  'awaiting_player',
  'escalated',
  'resolved',
  'closed',
])
export const conversationPriority = pgEnum('conversation_priority', ['p1', 'p2', 'p3', 'p4'])
export const classificationSource = pgEnum('classification_source', ['bot', 'agent'])
export const messageAuthorType = pgEnum('message_author_type', ['player', 'agent', 'bot', 'system'])
export const messageVisibility = pgEnum('message_visibility', ['public', 'internal'])
export const messageDeliveryState = pgEnum('message_delivery_state', [
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
])
export const eventActorType = pgEnum('event_actor_type', ['player', 'agent', 'bot', 'system'])
export const declaredFieldType = pgEnum('declared_field_type', ['string', 'number', 'boolean', 'timestamp'])
```

`event.type` stays `text`, not an enum. The schema spec lists enums for *"status, priority, delivery state, author type and visibility"* and pointedly not for event type — new event types arrive with every slice, and `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block.

`abandoned` is not in `conversationStatus`. It does not exist; the inactivity clock replaced it. Do not reintroduce the name.

- [ ] **Step 4: Write `backend/src/db/schema/identity.ts`**

```ts
import { sql } from 'drizzle-orm'
import { customType, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { agentStatus, workspaceRole } from './enums.ts'

/** Case-insensitive email, per the schema spec. Requires the citext extension. */
const citext = customType<{ data: string }>({ dataType: () => 'citext' })

const tz = { withTimezone: true, mode: 'date' } as const

/** One of only two unscoped tables. No RLS policy, no workspace_id. */
export const workspace = pgTable('workspace', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /** sha256 of the random half of the workspace secret. See auth/workspaceSecret.ts. */
  secretHash: text('secret_hash').notNull(),
  /** Set to refuse token minting without deleting anything. */
  disabledAt: timestamp('disabled_at', tz),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
})

/**
 * The other unscoped table: one login per person, global across workspaces, with
 * the ROLE held per workspace in workspace_member.
 *
 * Authentication is Google OAuth 2 restricted to the mindstormstudios.com org —
 * there are no passwords in this product, so there is no password_hash. See
 * docs/decisions/2026-08-04-agent-auth-google-oauth.md. The OAuth flow itself
 * belongs to the console slice; only the identity columns land here.
 */
export const agent = pgTable('agent', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The Google account address. citext because Google addresses are case-insensitive. */
  email: citext('email').notNull().unique(),
  /** The Google `sub` claim — stable per-account id. Null until a seeded row's first login. */
  googleSubject: text('google_subject').unique(),
  displayName: text('display_name').notNull(),
  status: agentStatus('status').notNull().default('active'),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
})

/** The hinge: a global agent holds a per-workspace role. */
export const workspaceMember = pgTable(
  'workspace_member',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'restrict' }),
    role: workspaceRole('role').notNull(),
    deactivatedAt: timestamp('deactivated_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workspace_member_workspace_agent_uk').on(t.workspaceId, t.agentId)],
)
```

- [ ] **Step 5: Write `backend/src/db/schema/players.ts`**

```ts
import { sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sessionEndReason } from './enums.ts'
import { workspace } from './identity.ts'

const tz = { withTimezone: true, mode: 'date' } as const

export const player = pgTable(
  'player',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    externalId: text('external_id').notNull(),
    firstSeenAt: timestamp('first_seen_at', tz).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', tz).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('player_workspace_external_uk').on(t.workspaceId, t.externalId)],
)

/**
 * The denominator for self-serve rate. `id` is generated by the SDK in Open(), so
 * there is deliberately NO defaultRandom() here — accepting the client's uuid as the
 * primary key is what makes POST /sdk/sessions/start idempotent with no dedupe store.
 *
 * `entry_point` is context only — where in the game the player tapped support.
 * NEVER classification.
 */
export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => player.id, { onDelete: 'restrict' }),
    entryPoint: text('entry_point').notNull(),
    startedAt: timestamp('started_at', tz).notNull(),
    endedAt: timestamp('ended_at', tz),
    /** 'client' when sessions/end arrived; 'timeout' when the worker closed it. */
    endedBy: sessionEndReason('ended_by'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    index('session_workspace_started_idx').on(t.workspaceId, t.startedAt),
    // The session-timeout worker's scan: unclosed sessions ordered by age.
    index('session_open_started_idx').on(t.startedAt).where(sql`ended_at is null`),
  ],
)
```

- [ ] **Step 6: Write `backend/src/db/schema/playerState.ts`**

```ts
import { sql } from 'drizzle-orm'
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { declaredFieldType } from './enums.ts'
import { agent, workspace } from './identity.ts'
import { session } from './players.ts'

const tz = { withTimezone: true, mode: 'date' } as const
const emptyJson = sql`'{}'::jsonb`

/**
 * The admin-promoted key set. The snapshot split reads this table at write time,
 * which is exactly what makes promotion non-retroactive: promote a field later and
 * old snapshots keep it in `raw`. There is no backfill, ever.
 *
 * `declared_at` is why a filter returning partial results is explainable rather
 * than mysterious.
 */
export const declaredField = pgTable(
  'declared_field',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: declaredFieldType('type').notNull(),
    declaredAt: timestamp('declared_at', tz).notNull().defaultNow(),
    /** Nullable: the eleven seeded rows have no human actor. */
    declaredBy: uuid('declared_by').references(() => agent.id, { onDelete: 'restrict' }),
  },
  (t) => [uniqueIndex('declared_field_workspace_key_uk').on(t.workspaceId, t.key)],
)

/**
 * Keyed to the session, not the conversation — the SDK delivers it before any
 * conversation exists, and a reopen never rewrites conversation.session_id, so
 * "a reopened cycle keeps the original snapshot" is structural rather than a rule.
 *
 * `raw` is PII by default: uncontrolled client input, handled as personal data for
 * access and retention purposes regardless of contents.
 */
export const playerStateSnapshot = pgTable(
  'player_state_snapshot',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'restrict' }),
    declared: jsonb('declared').$type<Record<string, unknown>>().notNull().default(emptyJson),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default(emptyJson),
    /** Delivered, but the game's provider returned nothing usable. A state, not an error. */
    isMissing: boolean('is_missing').notNull().default(false),
    /** Partial — device fields captured, some provider fields threw. */
    degradedReason: text('degraded_reason'),
    capturedAt: timestamp('captured_at', tz).notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('player_state_snapshot_session_uk').on(t.sessionId),
    // Filter on any promoted key without an index per field.
    index('player_state_snapshot_declared_gin').using('gin', sql`${t.declared} jsonb_path_ops`),
  ],
)
```

- [ ] **Step 7: Write `backend/src/db/schema/conversations.ts`**

```ts
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import {
  classificationSource,
  conversationPriority,
  conversationStatus,
  messageAuthorType,
  messageDeliveryState,
  messageVisibility,
} from './enums.ts'
import { agent, workspace } from './identity.ts'
import { player, session } from './players.ts'

const tz = { withTimezone: true, mode: 'date' } as const

/**
 * MINIMAL on purpose. These two tables exist in this slice only because
 * GET /sdk/unread joins them. `subintent_id`, `resolution_cycle`, labels, form
 * submissions and the real status machine arrive with the step-5 slice, once the
 * taxonomy tables exist.
 */
export const conversation = pgTable(
  'conversation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => player.id, { onDelete: 'restrict' }),
    /** How a conversation reaches its player-state snapshot. Never rewritten on reopen. */
    sessionId: uuid('session_id').references(() => session.id, { onDelete: 'restrict' }),
    status: conversationStatus('status').notNull().default('bot_active'),
    priority: conversationPriority('priority').notNull().default('p3'),
    /** NULL is the unassigned queue. There is no queue table. */
    assignedAgentId: uuid('assigned_agent_id').references(() => agent.id, { onDelete: 'restrict' }),
    /** NULL means unset — the bot never ran. Only 'bot' or 'agent' otherwise. */
    classificationSource: classificationSource('classification_source'),
    messageSeq: integer('message_seq').notNull().default(0),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [index('conversation_workspace_player_idx').on(t.workspaceId, t.playerId)],
)

export const message = pgTable(
  'message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'restrict' }),
    /** Server-assigned sequence, never a device clock. Gaps are fine; order is not. */
    seq: integer('seq').notNull(),
    authorType: messageAuthorType('author_type').notNull(),
    authorAgentId: uuid('author_agent_id').references(() => agent.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    /** Never filtered in a query — two serializers do that. Internal notes leaking is safety-critical. */
    visibility: messageVisibility('visibility').notNull().default('public'),
    deliveryState: messageDeliveryState('delivery_state').notNull().default('sent'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('message_conversation_seq_uk').on(t.conversationId, t.seq),
    // The GET /sdk/unread scan.
    index('message_unread_idx').on(t.conversationId, t.deliveryState, t.authorType),
  ],
)
```

- [ ] **Step 8: Write `backend/src/db/schema/events.ts`**

```ts
import { sql } from 'drizzle-orm'
import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { eventActorType } from './enums.ts'
import { workspace } from './identity.ts'
import { conversation } from './conversations.ts'
import { session } from './players.ts'

const tz = { withTimezone: true, mode: 'date' } as const

/**
 * The reporting spine, append-only. Enforcement is REVOKE UPDATE, DELETE in
 * 002_rls.sql — not a convention.
 *
 * Payload values are snapshotted, never live pointers: an event records what
 * happened, and a name resolved through a FK would silently rewrite history when
 * someone renames the thing.
 */
export const event = pgTable(
  'event',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    /** text, not an enum: new types arrive every slice. */
    type: text('type').notNull(),
    conversationId: uuid('conversation_id').references(() => conversation.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id').references(() => session.id, { onDelete: 'restrict' }),
    /** No FK: this holds an agent id or a player id depending on actor_type. */
    actorId: uuid('actor_id'),
    actorType: eventActorType('actor_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp('occurred_at', tz).notNull().defaultNow(),
  },
  (t) => [
    // The table only grows and is only queried by time range.
    index('event_occurred_brin').using('brin', t.occurredAt),
    index('event_conversation_occurred_idx').on(t.conversationId, t.occurredAt),
    index('event_session_type_idx').on(t.sessionId, t.type),
  ],
)
```

`backend/src/db/schema/index.ts`:

```ts
export * from './enums.ts'
export * from './identity.ts'
export * from './players.ts'
export * from './playerState.ts'
export * from './conversations.ts'
export * from './events.ts'
```

- [ ] **Step 9: Write `backend/src/db/client.ts`**

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { getEnv } from '../env.ts'
import * as schema from './schema/index.ts'

/** Connects as support_app: a non-owner role with no BYPASSRLS. */
export const pool = new Pool({ connectionString: getEnv().DATABASE_URL, max: 10 })

export const db = drizzle(pool, { schema })
export type Db = typeof db

export async function closeDb(): Promise<void> {
  await pool.end()
}
```

- [ ] **Step 10: Write the extensions SQL and the setup script**

`backend/src/db/sql/001_extensions.sql`:

```sql
-- citext backs agent.email. gen_random_uuid() is built in from Postgres 13, so
-- pgcrypto is not needed. pgvector arrives with the knowledge tables in migration 002.
CREATE EXTENSION IF NOT EXISTS citext;
```

`backend/src/db/setup.ts`:

```ts
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { Client } from 'pg'
import { getEnv } from '../env.ts'

const run = promisify(execFile)
const sqlDir = join(dirname(new URL(import.meta.url).pathname), 'sql')

async function runSqlFile(url: string, file: string): Promise<void> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(await readFile(join(sqlDir, file), 'utf8'))
  } finally {
    await client.end()
  }
}

/**
 * Idempotent and ordered: extensions must exist before push (citext is a column
 * type), and the RLS file must run after push so it can see the tables.
 */
export async function setupDatabase(url: string = getEnv().MIGRATION_DATABASE_URL): Promise<void> {
  await runSqlFile(url, '001_extensions.sql')
  await run('pnpm', ['exec', 'drizzle-kit', 'push', '--force'], {
    cwd: join(dirname(new URL(import.meta.url).pathname), '..', '..'),
    env: { ...process.env, MIGRATION_DATABASE_URL: url },
  })
  await runSqlFile(url, '002_rls.sql')
}

if (process.argv[1]?.endsWith('setup.ts')) {
  await setupDatabase()
  console.log('database ready')
}
```

`002_rls.sql` does not exist until Task 4. Create it now as a one-line comment file (`-- Task 4 fills this in.`) so `setupDatabase` does not throw, and replace it in Task 4.

`backend/drizzle.config.ts`:

```ts
import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  // DDL runs as the owner; the app never has DDL rights.
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL ?? '' },
  verbose: true,
  strict: false,
})
```

- [ ] **Step 11: Give `tests/globalSetup.ts` a body**

```ts
import { Client } from 'pg'
import { setupDatabase } from '../src/db/setup.ts'
import { getEnv } from '../src/env.ts'

/**
 * Creates the test database if it is absent, then runs the same setup pipeline the
 * dev database uses — so a schema mistake fails a test rather than surviving to
 * production.
 */
export default async function globalSetup(): Promise<void> {
  const migrationUrl = getEnv().MIGRATION_DATABASE_URL
  const dbName = migrationUrl.slice(migrationUrl.lastIndexOf('/') + 1).split('?')[0] ?? ''

  // truncateAll() wipes every table, so pointing the suite at a real database would
  // destroy it. The name is the guard.
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${dbName}" — the database name must end in _test`)
  }

  const adminUrl = migrationUrl.replace(/\/[^/]+$/, '/postgres')
  const client = new Client({ connectionString: adminUrl })
  await client.connect()
  try {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [dbName])
    // Identifiers cannot be parameterised, so the name is validated above and
    // double-quoted here.
    if (rowCount === 0) await client.query(`create database "${dbName}"`)
  } finally {
    await client.end()
  }

  await setupDatabase(migrationUrl)
}
```

Add to `.env.test.example` and to the local `.env.test`:

```bash
DATABASE_URL=postgres://support_app:support_app@localhost:5432/support_test
MIGRATION_DATABASE_URL=postgres://support_owner:support_owner@localhost:5432/support_test
```

- [ ] **Step 12: Push the schema and run the test**

```bash
pnpm --filter @support/api db:setup
pnpm --filter @support/api test schema
```

Expected: PASS — 8 tests. If the FK-restrict assertion fails, find the FK that was written without `{ onDelete: 'restrict' }`; the default is `NO ACTION` (`confdeltype = 'a'`), which is close but not what the spec asks for.

- [ ] **Step 13: Commit**

```bash
git add backend/drizzle.config.ts backend/src/db backend/tests/schema.test.ts \
        backend/tests/helpers/db.ts backend/tests/globalSetup.ts .env.test.example
git commit -m "feat(db): ten-table SDK-path schema, client-generated session PK, event spine"
```

---

### Task 4: Row-Level Security, grants and append-only enforcement

**Files:**
- Create: `backend/src/db/sql/002_rls.sql` (replaces the Task 3 placeholder)
- Test: `backend/tests/rls.test.ts`

**Interfaces:**
- Consumes: the ten tables from Task 3; `ownerPool` from `tests/helpers/db.ts`.
- Produces: a `support_app` login role with `SELECT, INSERT, UPDATE` on all tables, `UPDATE`/`DELETE` revoked on `event`, `DELETE` never granted anywhere, and a `tenant` policy on all eight scoped tables. No new TypeScript.

- [ ] **Step 1: Write the failing test**

`backend/tests/rls.test.ts`. It uses two raw `pg` clients — one owner, one `support_app` — because the point is to prove the *database* refuses, independently of any TypeScript:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { getEnv } from '../src/env.ts'
import { closeOwnerPool, ownerPool, truncateAll } from './helpers/db.ts'

let app: Client
const WS_A = '11111111-1111-1111-1111-111111111111'
const WS_B = '22222222-2222-2222-2222-222222222222'
const PLAYER_A = 'aaaaaaaa-1111-1111-1111-111111111111'
const PLAYER_B = 'bbbbbbbb-2222-2222-2222-222222222222'

beforeAll(async () => {
  app = new Client({ connectionString: getEnv().DATABASE_URL })
  await app.connect()
})

afterAll(async () => {
  await app.end()
  await closeOwnerPool()
})

beforeEach(async () => {
  await truncateAll()
  for (const [id, slug] of [[WS_A, 'game-a'], [WS_B, 'game-b']] as const) {
    await ownerPool.query(
      `insert into workspace (id, name, slug, secret_hash) values ($1, $2, $3, 'x')`,
      [id, slug, slug],
    )
  }
  for (const [player, ws, ext] of [[PLAYER_A, WS_A, 'p-a'], [PLAYER_B, WS_B, 'p-b']] as const) {
    await ownerPool.query(
      `insert into player (id, workspace_id, external_id) values ($1, $2, $3)`,
      [player, ws, ext],
    )
  }
})

async function asWorkspace<T>(id: string | null, fn: () => Promise<T>): Promise<T> {
  await app.query('begin')
  try {
    if (id !== null) await app.query(`select set_config('app.workspace_id', $1, true)`, [id])
    const result = await fn()
    await app.query('commit')
    return result
  } catch (error) {
    await app.query('rollback')
    throw error
  }
}

describe('row-level security', () => {
  it('hides another workspace rows entirely', async () => {
    const rows = await asWorkspace(WS_A, async () => (await app.query('select id from player')).rows)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(PLAYER_A)
  })

  it('returns zero rows when no workspace is set — there is no code path around it', async () => {
    const rows = await asWorkspace(null, async () => (await app.query('select id from player')).rows)
    expect(rows).toHaveLength(0)
  })

  it('refuses a write that claims another workspace', async () => {
    await expect(
      asWorkspace(WS_A, () =>
        app.query(`insert into player (workspace_id, external_id) values ($1, 'smuggled')`, [WS_B]),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('cannot update or delete an event — the spine is append-only', async () => {
    await ownerPool.query(
      `insert into event (workspace_id, type, actor_type) values ($1, 'session_start', 'player')`,
      [WS_A],
    )
    await expect(
      asWorkspace(WS_A, () => app.query(`update event set type = 'tampered'`)),
    ).rejects.toThrow(/permission denied/i)
    await expect(asWorkspace(WS_A, () => app.query('delete from event'))).rejects.toThrow(/permission denied/i)
  })

  it('grants DELETE on nothing at all — no hard deletes anywhere', async () => {
    for (const table of ['player', 'session', 'conversation', 'message', 'player_state_snapshot']) {
      await expect(
        asWorkspace(WS_A, () => app.query(`delete from ${table}`)),
        `delete from ${table}`,
      ).rejects.toThrow(/permission denied/i)
    }
  })

  it('has no DDL rights — the app role can never alter the schema', async () => {
    await expect(asWorkspace(WS_A, () => app.query('create table sneaky (id int)'))).rejects.toThrow(
      /permission denied/i,
    )
  })

  it('forces the policy even for the table owner', async () => {
    const { rows } = await ownerPool.query<{ relforcerowsecurity: boolean; relname: string }>(
      `select relname, relforcerowsecurity from pg_class
        where relname in ('player','session','player_state_snapshot','declared_field',
                          'conversation','message','event')`,
    )
    expect(rows).toHaveLength(7)
    for (const row of rows) expect(row.relforcerowsecurity, row.relname).toBe(true)
  })

  it('leaves workspace and agent unscoped — they are the only two', async () => {
    const { rows } = await ownerPool.query<{ relname: string }>(
      `select relname from pg_class where relrowsecurity = true and relkind = 'r'`,
    )
    const scoped = rows.map((r) => r.relname).sort()
    expect(scoped).not.toContain('workspace')
    expect(scoped).not.toContain('agent')
    expect(scoped).toHaveLength(8) // workspace_member + the 7 above
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api test rls`
Expected: FAIL — the `support_app` role does not exist, so the client cannot even connect

- [ ] **Step 3: Write `backend/src/db/sql/002_rls.sql`**

```sql
-- Tenancy is the highest-risk thing in the build, and it is enforced by the
-- database, not the ORM. Re-runnable: db:setup calls this after every push.

-- 1 - The application role. No BYPASSRLS, no ownership, no DDL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'support_app') THEN
    CREATE ROLE support_app LOGIN PASSWORD 'support_app';
  END IF;
END $$;

REVOKE ALL ON SCHEMA public FROM support_app;
GRANT USAGE ON SCHEMA public TO support_app;

-- DELETE is deliberately absent from every grant: "no hard deletes anywhere;
-- don't even write the route."
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO support_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO support_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO support_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO support_app;

-- 2 - The event spine is append-only. Enforced, not conventional.
REVOKE UPDATE, DELETE ON event FROM support_app;
REVOKE UPDATE, DELETE ON event FROM PUBLIC;

-- 3 - One identical policy per scoped table. Exactly two tables are unscoped:
--     workspace and agent.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_member', 'player', 'session', 'player_state_snapshot',
    'declared_field', 'conversation', 'message', 'event'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE so the policy binds the table owner too. Without this, RLS is
    -- silently inert for any owner connection, including psql.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant ON %I', t);
    EXECUTE format(
      $policy$
        CREATE POLICY tenant ON %I
          USING      (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
          WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      $policy$, t);
  END LOOP;
END $$;
```

Three details that are easy to get wrong:

- **`nullif(..., '')`** — an unset custom setting reads as `NULL` with `missing_ok = true`, but a setting explicitly set to the empty string would blow up the `::uuid` cast and turn a tenancy bug into a 500. `nullif` makes both cases behave identically: zero rows.
- **`WITH CHECK` as well as `USING`.** `USING` filters reads and the *old* row of an update; without `WITH CHECK`, an insert claiming another workspace succeeds. That is the whole attack.
- **`FORCE ROW LEVEL SECURITY`.** The seed script and the tests connect as the owner, so without this the isolation tests would pass while proving nothing.

- [ ] **Step 4: Re-run setup and the test**

```bash
pnpm --filter @support/api db:setup
pnpm --filter @support/api test rls
```

Expected: PASS — 8 tests. Then confirm the dev database has the same treatment:

```bash
NODE_ENV=development pnpm --filter @support/api db:setup
```

- [ ] **Step 5: Prove it by hand, once**

```bash
docker compose exec postgres psql -U support_app -d support \
  -c "select count(*) from player;"
```

Expected: `0`, even with rows present — no workspace is set. This is the property the whole tenancy story rests on; see it work once with your own eyes.

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/sql/002_rls.sql backend/tests/rls.test.ts
git commit -m "feat(db): RLS policies, non-owner app role, append-only event table"
```

---

### Task 5: The `withWorkspace` transaction helper, `appendEvent`, and the seed

**Files:**
- Create: `backend/src/db/withWorkspace.ts`, `backend/src/events/appendEvent.ts`, `backend/src/db/seed.ts`
- Modify: `backend/tests/helpers/db.ts` (add factories)
- Test: `backend/tests/withWorkspace.test.ts`

**Interfaces:**
- Consumes: `db` from `src/db/client.ts`; the schema barrel; `DECLARED_FIELD_SEED` from `@support/types`.
- Produces:
  - `withWorkspace<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T>` and `type Tx` from `src/db/withWorkspace.ts`. **Every handler in Tasks 9–14 uses this and nothing else.**
  - `withoutWorkspace<T>(fn: (tx: Tx) => Promise<T>): Promise<T>` — for `workspace` and `agent` only.
  - `appendEvent(tx: Tx, input: EventInput): Promise<void>` where `EventInput = { workspaceId: string; type: string; conversationId?: string | null; sessionId?: string | null; actorId?: string | null; actorType: 'player' | 'agent' | 'bot' | 'system'; payload?: Record<string, unknown>; occurredAt?: Date }`.
  - `tests/helpers/db.ts` additionally exports `seedWorkspace(overrides?)`, `seedPlayer(workspaceId, externalId?)`, `seedSession(...)`, `seedConversation(...)`, `seedMessage(...)` — all owner-connection inserts returning the created ids.

- [ ] **Step 1: Write the failing test**

`backend/tests/withWorkspace.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { closeDb } from '../src/db/client.ts'
import { withWorkspace, withoutWorkspace } from '../src/db/withWorkspace.ts'
import { appendEvent } from '../src/events/appendEvent.ts'
import { event, player, workspace } from '../src/db/schema/index.ts'
import { closeOwnerPool, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

describe('withWorkspace', () => {
  it('sets the tenant for the duration of the transaction', async () => {
    const a = await seedWorkspace({ slug: 'game-a' })
    const b = await seedWorkspace({ slug: 'game-b' })
    await seedPlayer(a, 'p-a')
    await seedPlayer(b, 'p-b')

    const seen = await withWorkspace(a, async (tx) => tx.select().from(player))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.externalId).toBe('p-a')
  })

  it('reverts the setting after the transaction so a pooled connection cannot leak it', async () => {
    const a = await seedWorkspace({ slug: 'game-a' })
    await seedPlayer(a, 'p-a')
    await withWorkspace(a, async (tx) => tx.select().from(player))

    const leaked = await withoutWorkspace(async (tx) =>
      tx.execute(sql`select nullif(current_setting('app.workspace_id', true), '') as ws`),
    )
    expect(leaked.rows[0]?.ws).toBeNull()
  })

  it('rolls back everything when the callback throws', async () => {
    const a = await seedWorkspace({ slug: 'game-a' })
    await expect(
      withWorkspace(a, async (tx) => {
        await tx.insert(player).values({ workspaceId: a, externalId: 'doomed' })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const rows = await withWorkspace(a, async (tx) => tx.select().from(player))
    expect(rows).toHaveLength(0)
  })

  it('reads the unscoped tables through withoutWorkspace', async () => {
    await seedWorkspace({ slug: 'game-a' })
    await seedWorkspace({ slug: 'game-b' })
    const rows = await withoutWorkspace(async (tx) => tx.select().from(workspace))
    expect(rows).toHaveLength(2)
  })
})

describe('appendEvent', () => {
  it('writes a row with the workspace, actor and snapshotted payload', async () => {
    const a = await seedWorkspace({ slug: 'game-a' })
    const p = await seedPlayer(a, 'p-a')
    const at = new Date('2026-08-04T09:12:00Z')

    await withWorkspace(a, (tx) =>
      appendEvent(tx, {
        workspaceId: a,
        type: 'session_start',
        actorType: 'player',
        actorId: p,
        occurredAt: at,
        payload: { entry_point: 'settings_menu' },
      }),
    )

    const rows = await withWorkspace(a, async (tx) => tx.select().from(event).where(eq(event.type, 'session_start')))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.actorType).toBe('player')
    expect(rows[0]?.actorId).toBe(p)
    expect(rows[0]?.occurredAt.toISOString()).toBe('2026-08-04T09:12:00.000Z')
    expect(rows[0]?.payload).toEqual({ entry_point: 'settings_menu' })
  })

  it('defaults the payload to an empty object rather than null', async () => {
    const a = await seedWorkspace({ slug: 'game-a' })
    await withWorkspace(a, (tx) => appendEvent(tx, { workspaceId: a, type: 'sdk_incident', actorType: 'system' }))
    const rows = await withWorkspace(a, async (tx) => tx.select().from(event))
    expect(rows[0]?.payload).toEqual({})
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api test withWorkspace`
Expected: FAIL — `Cannot find module '../src/db/withWorkspace.ts'`

- [ ] **Step 3: Write `backend/src/db/withWorkspace.ts`**

```ts
import { sql } from 'drizzle-orm'
import { db, type Db } from './client.ts'

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * The only way a handler touches a scoped table.
 *
 * `SET LOCAL app.workspace_id = $1` is a syntax error — SET does not take bind
 * parameters. set_config() is an ordinary function call, so it parameterises, and
 * its third argument (is_local = true) scopes the value to this transaction. That
 * matters with a connection pool: a session-level setting would leak to the next
 * request that borrowed the same connection.
 *
 * The workspace id must come from a verified JWT claim, never from a header or a
 * request body.
 */
export async function withWorkspace<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`)
    return fn(tx)
  })
}

/**
 * For `workspace` and `agent` — the only two unscoped tables. Reaching for this
 * anywhere else is a tenancy bug: RLS would return zero rows and the symptom would
 * look like missing data.
 */
export async function withoutWorkspace<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn)
}
```

- [ ] **Step 4: Write `backend/src/events/appendEvent.ts`**

```ts
import type { Tx } from '../db/withWorkspace.ts'
import { event } from '../db/schema/index.ts'

export type EventActorType = 'player' | 'agent' | 'bot' | 'system'

export type EventInput = {
  workspaceId: string
  type: string
  conversationId?: string | null
  sessionId?: string | null
  actorId?: string | null
  actorType: EventActorType
  payload?: Record<string, unknown>
  occurredAt?: Date
}

/**
 * Events are a projection, not the source of truth — every state change writes both
 * the mutable row and this append-only row, in one transaction, through one function.
 * Never insert into `event` directly.
 *
 * Payload values must be snapshotted literals, never ids that resolve to a live
 * name: an event records what happened, and a FK-resolved name would silently
 * rewrite history when someone renames the thing.
 *
 * Any client-supplied `sessionId` must already have been confirmed visible in this
 * workspace by the caller — FK checks bypass RLS, so an unverified id would be
 * accepted and would point across the tenant boundary.
 */
export async function appendEvent(tx: Tx, input: EventInput): Promise<void> {
  await tx.insert(event).values({
    workspaceId: input.workspaceId,
    type: input.type,
    conversationId: input.conversationId ?? null,
    sessionId: input.sessionId ?? null,
    actorId: input.actorId ?? null,
    actorType: input.actorType,
    payload: input.payload ?? {},
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  })
}
```

- [ ] **Step 5: Add the factories to `backend/tests/helpers/db.ts`**

Append to the existing file:

```ts
import { randomUUID } from 'node:crypto'

export async function seedWorkspace(
  overrides: { id?: string; slug?: string; name?: string; secretHash?: string; disabledAt?: Date | null } = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID()
  const slug = overrides.slug ?? `ws-${id.slice(0, 8)}`
  await ownerPool.query(
    `insert into workspace (id, name, slug, secret_hash, disabled_at) values ($1, $2, $3, $4, $5)`,
    [id, overrides.name ?? slug, slug, overrides.secretHash ?? 'unset', overrides.disabledAt ?? null],
  )
  return id
}

export async function seedAgent(email = `a-${randomUUID().slice(0, 8)}@example.test`): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(
    `insert into agent (id, email, display_name) values ($1, $2, 'Test Agent')`,
    [id, email],
  )
  return id
}

export async function seedPlayer(workspaceId: string, externalId = `p-${randomUUID().slice(0, 8)}`): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(
    `insert into player (id, workspace_id, external_id) values ($1, $2, $3)`,
    [id, workspaceId, externalId],
  )
  return id
}

export async function seedDeclaredFields(workspaceId: string, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await ownerPool.query(
      `insert into declared_field (workspace_id, key, label, type) values ($1, $2, $2, 'string')
         on conflict (workspace_id, key) do nothing`,
      [workspaceId, key],
    )
  }
}

export async function seedSession(args: {
  workspaceId: string
  playerId: string
  id?: string
  entryPoint?: string
  startedAt?: Date
  endedAt?: Date | null
}): Promise<string> {
  const id = args.id ?? randomUUID()
  await ownerPool.query(
    `insert into session (id, workspace_id, player_id, entry_point, started_at, ended_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      args.workspaceId,
      args.playerId,
      args.entryPoint ?? 'settings_menu',
      args.startedAt ?? new Date(),
      args.endedAt ?? null,
    ],
  )
  return id
}

export async function seedConversation(args: {
  workspaceId: string
  playerId: string
  sessionId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(
    `insert into conversation (id, workspace_id, player_id, session_id) values ($1, $2, $3, $4)`,
    [id, args.workspaceId, args.playerId, args.sessionId ?? null],
  )
  return id
}

export async function seedMessage(args: {
  workspaceId: string
  conversationId: string
  seq: number
  authorType: 'player' | 'agent' | 'bot' | 'system'
  visibility?: 'public' | 'internal'
  deliveryState?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
  body?: string
}): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(
    `insert into message (id, workspace_id, conversation_id, seq, author_type, visibility, delivery_state, body)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      args.workspaceId,
      args.conversationId,
      args.seq,
      args.authorType,
      args.visibility ?? 'public',
      args.deliveryState ?? 'sent',
      args.body ?? 'test message',
    ],
  )
  return id
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @support/api test withWorkspace`
Expected: PASS — 6 tests

- [ ] **Step 7: Write `backend/src/db/seed.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { DECLARED_FIELD_SEED } from '@support/types'
import { getEnv } from '../env.ts'
import { agent, declaredField, workspaceMember } from './schema/index.ts'
import { closeDb } from './client.ts'
import { withWorkspace, withoutWorkspace } from './withWorkspace.ts'
import { generateWorkspaceSecret } from '../auth/workspaceSecret.ts'

const SLUG = process.env.SEED_WORKSPACE_SLUG ?? 'demo-game'
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.test'

/**
 * Seeds one workspace, one admin, and the eleven declared fields.
 *
 * The `Other` intent and its catch-all subintent are NOT seeded here: the taxonomy
 * tables arrive in migration 002. Nothing in build-order steps 1-3 classifies
 * anything, so there is nothing yet that needs somewhere to land. Seeding them is
 * the first task of the step-5 slice.
 */
async function seed(): Promise<void> {
  const { secret, secretHash } = generateWorkspaceSecret(SLUG)

  // `workspace` is written on the OWNER connection, not the app pool: the app role
  // holds only SELECT there, so it cannot rewrite a workspace secret even if a
  // handler is compromised. Seeding is ops tooling, so the owner credential is
  // appropriate here and nowhere in the request path. See
  // docs/decisions/2026-08-04-unscoped-table-writes.md.
  const owner = new Client({ connectionString: getEnv().MIGRATION_DATABASE_URL })
  await owner.connect()
  let workspaceId: string
  try {
    const { rows } = await owner.query<{ id: string }>(
      `insert into workspace (id, name, slug, secret_hash) values ($1, 'Demo Game', $2, $3)
         on conflict (slug) do update set secret_hash = excluded.secret_hash
       returning id`,
      [randomUUID(), SLUG, secretHash],
    )
    if (!rows[0]) throw new Error('workspace upsert returned nothing')
    workspaceId = rows[0].id
  } finally {
    await owner.end()
  }

  // Everything below stays on the APP pool deliberately, so the seed exercises the
  // real RLS path rather than bypassing it.
  const { adminId } = await withoutWorkspace(async (tx) => {

    // No password: agent auth is Google OAuth restricted to the mindstormstudios.com
    // org. google_subject stays null until this person's first real login.
    const [admin] = await tx
      .insert(agent)
      .values({ email: ADMIN_EMAIL, displayName: 'Seed Admin' })
      .onConflictDoUpdate({ target: agent.email, set: { displayName: 'Seed Admin' } })
      .returning({ id: agent.id })
    if (!admin) throw new Error('agent upsert returned nothing')

    return { adminId: admin.id }
  })

  // workspace_member and declared_field are BOTH scoped, so they belong here rather
  // than in the withoutWorkspace block above — an insert there would be refused by
  // the tenant policy's WITH CHECK. Only `workspace` and `agent` are unscoped.
  await withWorkspace(workspaceId, async (tx) => {
    await tx
      .insert(workspaceMember)
      .values({ workspaceId, agentId: adminId, role: 'admin' })
      .onConflictDoNothing()

    for (const field of DECLARED_FIELD_SEED) {
      await tx
        .insert(declaredField)
        .values({ workspaceId, key: field.key, label: field.label, type: field.type })
        .onConflictDoNothing()
    }
  })

  console.log(`workspace   ${SLUG} (${workspaceId})`)
  console.log(`admin       ${ADMIN_EMAIL}`)
  console.log(`declared    ${DECLARED_FIELD_SEED.length} fields`)
  console.log('')
  console.log('Workspace secret — printed only here, and only the game backend should hold it:')
  console.log(`  ${secret}`)
  console.log('')
  console.log('Re-running this seed mints a NEW secret and invalidates the previous one.')
}

await seed()
await closeDb()
```

Re-running the seed rotates the secret (`onConflictDoUpdate` on `secretHash`), so the printed value is always the live one — at the cost of invalidating whatever a game backend already holds. The final console line says so.

- [ ] **Step 8: Run the seed**

`generateWorkspaceSecret` is written in Task 6 Step 3. Write that one file (`backend/src/auth/workspaceSecret.ts`) now — it has no dependencies of its own — then return here.

```bash
pnpm --filter @support/api db:seed
```

Expected: the workspace id, the admin email, `declared 11 fields`, and a secret of the form `sk_demo-game.<43 chars>`. Save the secret — Task 6's manual check needs it.

- [ ] **Step 9: Commit**

```bash
git add backend/src/db/withWorkspace.ts backend/src/events/appendEvent.ts backend/src/db/seed.ts \
        backend/tests/withWorkspace.test.ts backend/tests/helpers/db.ts
git commit -m "feat(db): tenant transaction helper, appendEvent, seed one workspace"
```

---

### Task 6: The Express app, error shape, and `POST /auth/player-token`

**Files:**
- Create: `backend/src/errors.ts`, `backend/src/app.ts`, `backend/src/server.ts`
- Create: `backend/src/auth/workspaceSecret.ts`, `backend/src/auth/jwt.ts`, `backend/src/auth/playerTokenRoute.ts`
- Test: `backend/tests/helpers/app.ts`, `backend/tests/auth.workspaceSecret.test.ts`, `backend/tests/auth.playerToken.test.ts`

**Interfaces:**
- Consumes: `getEnv()`, `withWorkspace`/`withoutWorkspace`, the schema barrel, `PlayerTokenRequest` from `@support/types`.
- Produces:
  - `createApp(): express.Express` from `src/app.ts` — mounts `/auth`, and in later tasks `/sdk` and `/surface`.
  - `sendError(res, status, code, message)` and `errorMiddleware` from `src/errors.ts`. Body shape: `{ "error": { "code": string, "message": string } }`.
  - `generateWorkspaceSecret(slug): { secret: string; secretHash: string }`, `parseWorkspaceSecret(secret): { slug: string; raw: string } | null`, `hashSecret(raw): string`, `secretMatches(raw, storedHash): boolean` from `src/auth/workspaceSecret.ts`.
  - `signPlayerToken(claims, ttlSeconds): Promise<string>`, `verifyPlayerToken(token): Promise<PlayerClaims>`, `type PlayerClaims = { workspace_id: string; player_id: string; external_player_id: string }` from `src/auth/jwt.ts`.
  - `tests/helpers/app.ts` exports `agentFor(app)` (a supertest agent) and `mintToken(claims, ttl?)`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/auth.workspaceSecret.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  generateWorkspaceSecret,
  hashSecret,
  parseWorkspaceSecret,
  secretMatches,
} from '../src/auth/workspaceSecret.ts'

describe('workspace secret', () => {
  it('mints a secret that carries the slug and hashes the random half only', () => {
    const { secret, secretHash } = generateWorkspaceSecret('demo-game')
    expect(secret.startsWith('sk_demo-game.')).toBe(true)
    const parsed = parseWorkspaceSecret(secret)
    expect(parsed?.slug).toBe('demo-game')
    expect(secretHash).toBe(hashSecret(parsed!.raw))
    expect(secretHash).not.toContain(parsed!.raw)
  })

  it('round-trips through comparison', () => {
    const { secret, secretHash } = generateWorkspaceSecret('demo-game')
    const { raw } = parseWorkspaceSecret(secret)!
    expect(secretMatches(raw, secretHash)).toBe(true)
    expect(secretMatches(`${raw}x`, secretHash)).toBe(false)
  })

  it('never mints the same secret twice', () => {
    const a = generateWorkspaceSecret('demo-game').secret
    const b = generateWorkspaceSecret('demo-game').secret
    expect(a).not.toBe(b)
  })

  it('returns null for anything that is not a workspace secret', () => {
    for (const bad of ['', 'demo-game.abc', 'sk_', 'sk_.abc', 'sk_demo-game', 'sk_demo-game.', 'Bearer sk_a.b']) {
      expect(parseWorkspaceSecret(bad), bad).toBeNull()
    }
  })

  it('does not throw on a hash of the wrong length', () => {
    expect(secretMatches('anything', 'deadbeef')).toBe(false)
  })
})
```

`backend/tests/auth.playerToken.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app.ts'
import { closeDb } from '../src/db/client.ts'
import { withWorkspace } from '../src/db/withWorkspace.ts'
import { player } from '../src/db/schema/index.ts'
import { generateWorkspaceSecret } from '../src/auth/workspaceSecret.ts'
import { verifyPlayerToken } from '../src/auth/jwt.ts'
import { closeOwnerPool, seedWorkspace, truncateAll } from './helpers/db.ts'

const app = createApp()

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function workspaceWithSecret(slug = 'demo-game', disabledAt: Date | null = null) {
  const { secret, secretHash } = generateWorkspaceSecret(slug)
  const id = await seedWorkspace({ slug, secretHash, disabledAt })
  return { id, secret }
}

describe('POST /auth/player-token', () => {
  it('mints a 15-minute token and upserts the player', async () => {
    const ws = await workspaceWithSecret()

    const res = await request(app)
      .post('/auth/player-token')
      .set('Authorization', `Bearer ${ws.secret}`)
      .send({ external_player_id: 'UserId7661' })

    expect(res.status).toBe(200)
    expect(res.body.expires_in).toBe(900)

    const claims = await verifyPlayerToken(res.body.token)
    expect(claims.workspace_id).toBe(ws.id)
    expect(claims.external_player_id).toBe('UserId7661')

    const players = await withWorkspace(ws.id, async (tx) =>
      tx.select().from(player).where(eq(player.externalId, 'UserId7661')),
    )
    expect(players).toHaveLength(1)
    expect(players[0]?.id).toBe(claims.player_id)
  })

  it('is idempotent on repeat calls and bumps last_seen_at', async () => {
    const ws = await workspaceWithSecret()
    const call = () =>
      request(app)
        .post('/auth/player-token')
        .set('Authorization', `Bearer ${ws.secret}`)
        .send({ external_player_id: 'UserId7661' })

    const first = await call()
    const before = (await withWorkspace(ws.id, async (tx) => tx.select().from(player)))[0]!
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await call()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const after = await withWorkspace(ws.id, async (tx) => tx.select().from(player))
    expect(after).toHaveLength(1)
    expect(after[0]!.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime())
    expect(after[0]!.firstSeenAt.getTime()).toBe(before.firstSeenAt.getTime())
  })

  it('keeps two workspaces players apart even for the same external id', async () => {
    const a = await workspaceWithSecret('game-a')
    const b = await workspaceWithSecret('game-b')
    for (const ws of [a, b]) {
      await request(app)
        .post('/auth/player-token')
        .set('Authorization', `Bearer ${ws.secret}`)
        .send({ external_player_id: 'SharedId' })
        .expect(200)
    }
    const inA = await withWorkspace(a.id, async (tx) => tx.select().from(player))
    const inB = await withWorkspace(b.id, async (tx) => tx.select().from(player))
    expect(inA).toHaveLength(1)
    expect(inB).toHaveLength(1)
    expect(inA[0]!.id).not.toBe(inB[0]!.id)
  })

  it('401s on a missing, malformed or wrong secret', async () => {
    const ws = await workspaceWithSecret()
    const body = { external_player_id: 'UserId7661' }

    await request(app).post('/auth/player-token').send(body).expect(401)
    await request(app).post('/auth/player-token').set('Authorization', 'Bearer nonsense').send(body).expect(401)
    await request(app).post('/auth/player-token').set('Authorization', ws.secret).send(body).expect(401)
    await request(app)
      .post('/auth/player-token')
      .set('Authorization', `Bearer sk_demo-game.${'w'.repeat(43)}`)
      .send(body)
      .expect(401)
  })

  it('404s for an unknown workspace and for a disabled one', async () => {
    const unknown = generateWorkspaceSecret('never-existed')
    await request(app)
      .post('/auth/player-token')
      .set('Authorization', `Bearer ${unknown.secret}`)
      .send({ external_player_id: 'UserId7661' })
      .expect(404)

    const disabled = await workspaceWithSecret('retired-game', new Date())
    await request(app)
      .post('/auth/player-token')
      .set('Authorization', `Bearer ${disabled.secret}`)
      .send({ external_player_id: 'UserId7661' })
      .expect(404)
  })

  it('422s on a malformed external_player_id', async () => {
    const ws = await workspaceWithSecret()
    for (const bad of [{}, { external_player_id: '' }, { external_player_id: 'has space' }, { external_player_id: 'a'.repeat(200) }]) {
      await request(app).post('/auth/player-token').set('Authorization', `Bearer ${ws.secret}`).send(bad).expect(422)
    }
  })

  it('400s on an unparseable body', async () => {
    const ws = await workspaceWithSecret()
    await request(app)
      .post('/auth/player-token')
      .set('Authorization', `Bearer ${ws.secret}`)
      .set('Content-Type', 'application/json')
      .send('{ not json')
      .expect(400)
  })

  it('never echoes the secret back', async () => {
    const ws = await workspaceWithSecret()
    const res = await request(app)
      .post('/auth/player-token')
      .set('Authorization', 'Bearer sk_demo-game.wrong')
      .send({ external_player_id: 'UserId7661' })
    expect(JSON.stringify(res.body)).not.toContain('wrong')
  })
})
```

Order matters in the handler and the tests encode it: **authentication before validation**. A wrong secret with a malformed player id is `401`, not `422` — otherwise the endpoint tells an unauthenticated caller whether their body was well-formed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @support/api test auth`
Expected: FAIL — `Cannot find module '../src/auth/workspaceSecret.ts'`

- [ ] **Step 3: Write `backend/src/auth/workspaceSecret.ts`**

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const PREFIX = 'sk_'

/**
 * Format: sk_<workspace-slug>.<43 base64url chars of 32 random bytes>
 *
 * The slug travels in the secret so verification is a single indexed lookup. The
 * alternative — a bare random string — would mean hashing the candidate against
 * every workspace row on every call.
 *
 * sha256, not bcrypt/argon2: the secret is 256 bits of CSPRNG output, so there is no
 * guessable password to slow an attacker down to. A slow KDF would buy nothing and
 * cost a native dependency. This reasoning does NOT transfer to agent passwords,
 * which are human-chosen and will need a real KDF when agent auth ships.
 */
export function generateWorkspaceSecret(slug: string): { secret: string; secretHash: string } {
  const raw = randomBytes(32).toString('base64url')
  return { secret: `${PREFIX}${slug}.${raw}`, secretHash: hashSecret(raw) }
}

export function hashSecret(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

export function parseWorkspaceSecret(secret: string): { slug: string; raw: string } | null {
  if (!secret.startsWith(PREFIX)) return null
  const rest = secret.slice(PREFIX.length)
  const dot = rest.indexOf('.')
  if (dot <= 0 || dot === rest.length - 1) return null
  return { slug: rest.slice(0, dot), raw: rest.slice(dot + 1) }
}

export function secretMatches(raw: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashSecret(raw), 'hex')
  let stored: Buffer
  try {
    stored = Buffer.from(storedHash, 'hex')
  } catch {
    return false
  }
  // timingSafeEqual throws on a length mismatch, which would leak through the
  // difference between a 500 and a 401.
  if (candidate.length !== stored.length) return false
  return timingSafeEqual(candidate, stored)
}
```

- [ ] **Step 4: Write `backend/src/auth/jwt.ts`**

```ts
import { SignJWT, jwtVerify } from 'jose'
import { getEnv } from '../env.ts'

const ISSUER = 'support-crm'
const AUDIENCE = 'support-player'

export type PlayerClaims = {
  workspace_id: string
  player_id: string
  external_player_id: string
}

function key(): Uint8Array {
  return new TextEncoder().encode(getEnv().PLAYER_JWT_SECRET)
}

/**
 * Short-lived because it travels in a URL fragment. The web app refreshes against
 * its own session rather than by re-reading the fragment, so 15 minutes is a ceiling
 * on the fragment's usefulness, not on the player's visit.
 */
export async function signPlayerToken(
  claims: PlayerClaims,
  ttlSeconds: number = getEnv().PLAYER_TOKEN_TTL_SECONDS,
): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key())
}

export class InvalidPlayerToken extends Error {}

export async function verifyPlayerToken(token: string): Promise<PlayerClaims> {
  let payload: Record<string, unknown>
  try {
    ;({ payload } = await jwtVerify(token, key(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    }))
  } catch (error) {
    throw new InvalidPlayerToken(error instanceof Error ? error.message : 'token rejected')
  }

  const { workspace_id, player_id, external_player_id } = payload
  if (
    typeof workspace_id !== 'string' ||
    typeof player_id !== 'string' ||
    typeof external_player_id !== 'string'
  ) {
    throw new InvalidPlayerToken('token is missing a required claim')
  }
  return { workspace_id, player_id, external_player_id }
}
```

`algorithms: ['HS256']` is not optional decoration — without it, `jwtVerify` would accept any algorithm the token's own header names.

- [ ] **Step 5: Write `backend/src/errors.ts`**

```ts
import type { ErrorRequestHandler, Response } from 'express'

export type ErrorCode =
  | 'unauthorized'
  | 'workspace_mismatch'
  | 'not_found'
  | 'unparseable_body'
  | 'invalid_request'
  | 'internal'

export function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } })
}

/**
 * Express 5 forwards a rejected promise from a handler here automatically, so no
 * asyncHandler wrapper is needed anywhere in this codebase.
 */
export const errorMiddleware: ErrorRequestHandler = (error, _req, res, _next) => {
  // express.json() throws this for malformed JSON and for a body over the limit.
  if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.parse.failed') {
    sendError(res, 400, 'unparseable_body', 'Request body is not valid JSON.')
    return
  }
  if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
    sendError(res, 413, 'unparseable_body', 'Request body is too large.')
    return
  }
  console.error('[error]', error)
  sendError(res, 500, 'internal', 'Something went wrong.')
}
```

- [ ] **Step 6: Write `backend/src/auth/playerTokenRoute.ts`**

```ts
import { Router } from 'express'
import { PlayerTokenRequest, type PlayerTokenResponse } from '@support/types'
import { and, eq, sql } from 'drizzle-orm'
import { getEnv } from '../env.ts'
import { sendError } from '../errors.ts'
import { player, workspace } from '../db/schema/index.ts'
import { withWorkspace, withoutWorkspace } from '../db/withWorkspace.ts'
import { signPlayerToken } from './jwt.ts'
import { parseWorkspaceSecret, secretMatches } from './workspaceSecret.ts'

export const playerTokenRouter = Router()

/**
 * Called server-to-server by the GAME's backend, which is the only place the
 * workspace secret ever lives. Never called by the SDK.
 *
 * Authentication is checked before the body is validated: a caller with a bad
 * secret must not learn whether their payload was well-formed.
 */
playerTokenRouter.post('/player-token', async (req, res) => {
  const header = req.header('authorization') ?? ''
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) {
    sendError(res, 401, 'unauthorized', 'Expected an Authorization: Bearer <workspace_secret> header.')
    return
  }

  const parsed = parseWorkspaceSecret(rest.join(' ').trim())
  if (!parsed) {
    sendError(res, 401, 'unauthorized', 'Workspace secret is malformed.')
    return
  }

  const [found] = await withoutWorkspace(async (tx) =>
    tx
      .select({ id: workspace.id, secretHash: workspace.secretHash, disabledAt: workspace.disabledAt })
      .from(workspace)
      .where(eq(workspace.slug, parsed.slug))
      .limit(1),
  )

  // Unknown and disabled are both 404, per the wire contract. Compare the secret
  // first so the response cannot be used to enumerate workspace slugs.
  if (!found || !secretMatches(parsed.raw, found.secretHash)) {
    sendError(
      res,
      found ? 401 : 404,
      found ? 'unauthorized' : 'not_found',
      found ? 'Workspace secret is not valid.' : 'Workspace not found.',
    )
    return
  }
  if (found.disabledAt) {
    sendError(res, 404, 'not_found', 'Workspace not found.')
    return
  }

  const body = PlayerTokenRequest.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'external_player_id is missing or malformed.')
    return
  }

  const externalPlayerId = body.data.external_player_id

  // Upsert so a player exists from their first support open.
  const playerId = await withWorkspace(found.id, async (tx) => {
    const [row] = await tx
      .insert(player)
      .values({ workspaceId: found.id, externalId: externalPlayerId })
      .onConflictDoUpdate({
        target: [player.workspaceId, player.externalId],
        set: { lastSeenAt: sql`now()` },
      })
      .returning({ id: player.id })
    if (row) return row.id

    // Defensive: an upsert that returns nothing means the conflict row is invisible,
    // which under RLS would mean a tenancy bug rather than a race.
    const [existing] = await tx
      .select({ id: player.id })
      .from(player)
      .where(and(eq(player.workspaceId, found.id), eq(player.externalId, externalPlayerId)))
      .limit(1)
    if (!existing) throw new Error('player upsert returned no row')
    return existing.id
  })

  const ttl = getEnv().PLAYER_TOKEN_TTL_SECONDS
  const token = await signPlayerToken(
    { workspace_id: found.id, player_id: playerId, external_player_id: externalPlayerId },
    ttl,
  )

  const payload: PlayerTokenResponse = { token, expires_in: ttl }
  res.status(200).json(payload)
})
```

One subtlety in the 401-vs-404 branch: the workspace lookup happens before the secret comparison, so a *correct-format but unknown* slug returns `404` while a *known* slug with a wrong secret returns `401`. That does let a caller distinguish an existing slug from a missing one. It is the shape the wire contract specifies (*"Workspace not found or disabled → 404"*), and slugs are not secrets — they travel in the `X-Support-Workspace` header of every SDK request. Do not "improve" this to a blanket 401; the game backend operator needs `404` to mean "you typed the slug wrong".

- [ ] **Step 7: Write `backend/src/app.ts` and `backend/src/server.ts`**

```ts
// src/app.ts
import cors from 'cors'
import express from 'express'
import { getEnv } from './env.ts'
import { errorMiddleware } from './errors.ts'
import { playerTokenRouter } from './auth/playerTokenRoute.ts'

export function createApp(): express.Express {
  const app = express()
  app.disable('x-powered-by')

  // 64 KB: generous for the largest plausible snapshot, small enough that an
  // oversized body is refused rather than truncated. Nothing inside an ACCEPTED
  // body is ever dropped — "nothing the game sends is ever dropped".
  app.use(express.json({ limit: '64kb' }))

  // The SDK is not a browser and needs no CORS. The web surface does: it is served
  // from webviewBaseUrl and calls apiBaseUrl.
  app.use(
    cors({
      origin: getEnv().SURFACE_ORIGINS,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  )

  app.get('/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.use('/auth', playerTokenRouter)
  // Task 7 mounts /sdk; Task 14 mounts /surface.

  app.use(errorMiddleware)
  return app
}
```

```ts
// src/server.ts
import 'dotenv/config'
import { createApp } from './app.ts'
import { getEnv } from './env.ts'

const port = getEnv().PORT
createApp().listen(port, () => {
  console.log(`api listening on http://localhost:${port}`)
})
// Task 13 adds registerJobs() here.
```

`backend/tests/helpers/app.ts`:

```ts
import { createApp } from '../../src/app.ts'
import { signPlayerToken, type PlayerClaims } from '../../src/auth/jwt.ts'

export const app = createApp()

export async function mintToken(claims: PlayerClaims, ttlSeconds = 900): Promise<string> {
  return signPlayerToken(claims, ttlSeconds)
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @support/api test auth`
Expected: PASS — 13 tests

- [ ] **Step 9: Mint a token by hand**

```bash
pnpm --filter @support/api dev &
curl -s -X POST http://localhost:4000/auth/player-token \
  -H "Authorization: Bearer $SEED_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"external_player_id":"UserId7661"}' | tee /tmp/token.json
```

Expected: `{"token":"eyJ...","expires_in":900}`. Decode the payload (`node -e "console.log(JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64url')))" <token>`) and confirm `workspace_id`, `player_id`, `external_player_id`, `iat`, `exp`, and that `exp - iat === 900`.

- [ ] **Step 10: Commit**

```bash
git add backend/src/app.ts backend/src/server.ts backend/src/errors.ts backend/src/auth \
        backend/tests/helpers/app.ts backend/tests/auth.workspaceSecret.test.ts \
        backend/tests/auth.playerToken.test.ts
git commit -m "feat(auth): workspace-secret verification and 15-minute player tokens"
```

---

### Task 7: Player-token middleware and the SDK header cross-check

**Files:**
- Create: `backend/src/auth/requirePlayerToken.ts`, `backend/src/auth/requireSdkHeaders.ts`, `backend/src/sdk/router.ts`
- Modify: `backend/src/app.ts` (mount `/sdk`)
- Test: `backend/tests/auth.middleware.test.ts`

**Interfaces:**
- Consumes: `verifyPlayerToken`, `InvalidPlayerToken`, `withoutWorkspace`, `workspace` table, `SDK_HEADERS` from `@support/types`.
- Produces:
  - `requirePlayerToken: RequestHandler` — sets `req.player`.
  - `requireSdkHeaders: RequestHandler` — cross-checks `X-Support-Workspace` and records the other three headers.
  - `type PlayerContext = { workspaceId: string; playerId: string; externalPlayerId: string; workspaceSlug: string; sdkVersion: string | null; clientVersion: string | null; idempotencyKey: string | null }`, reachable as `req.player` (declared through an Express module augmentation).
  - `sdkRouter` from `src/sdk/router.ts`, with both middlewares applied and a temporary `GET /sdk/_whoami` used only by this task's tests.
- Note for Tasks 9–12: every handler reads `req.player!` and never reads a workspace from the body or a header.

- [ ] **Step 1: Write the failing test**

`backend/tests/auth.middleware.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/db/client.ts'
import { app, mintToken } from './helpers/app.ts'
import { closeOwnerPool, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function setup(slug = 'demo-game') {
  const workspaceId = await seedWorkspace({ slug })
  const playerId = await seedPlayer(workspaceId, 'UserId7661')
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'UserId7661',
  })
  return { workspaceId, playerId, token, slug }
}

const call = (token: string | null, headers: Record<string, string> = {}) => {
  const req = request(app).get('/sdk/_whoami')
  if (token) req.set('Authorization', `Bearer ${token}`)
  for (const [key, value] of Object.entries(headers)) req.set(key, value)
  return req
}

describe('requirePlayerToken', () => {
  it('resolves the player from the token and the slug from the database', async () => {
    const { workspaceId, playerId, token } = await setup()
    const res = await call(token, {
      'X-Support-Workspace': 'demo-game',
      'X-Support-Sdk': '1.0.2',
      'X-Support-Client-Version': '6.2.01',
      'Idempotency-Key': 'idem-1',
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      workspaceId,
      playerId,
      externalPlayerId: 'UserId7661',
      workspaceSlug: 'demo-game',
      sdkVersion: '1.0.2',
      clientVersion: '6.2.01',
      idempotencyKey: 'idem-1',
    })
  })

  it('401s with no token, a malformed header, a bad signature or an expired token', async () => {
    const { token } = await setup()
    await call(null, { 'X-Support-Workspace': 'demo-game' }).expect(401)
    await request(app).get('/sdk/_whoami').set('Authorization', token).expect(401)
    await call(`${token}tampered`, { 'X-Support-Workspace': 'demo-game' }).expect(401)

    const expired = await mintToken(
      { workspace_id: 'x', player_id: 'y', external_player_id: 'z' },
      -10,
    )
    await call(expired, { 'X-Support-Workspace': 'demo-game' }).expect(401)
  })

  it('401s when the token names a workspace that no longer exists', async () => {
    const token = await mintToken({
      workspace_id: '00000000-0000-0000-0000-000000000000',
      player_id: '00000000-0000-0000-0000-000000000001',
      external_player_id: 'ghost',
    })
    await call(token, { 'X-Support-Workspace': 'demo-game' }).expect(401)
  })

  it('401s when the token names a disabled workspace', async () => {
    const workspaceId = await seedWorkspace({ slug: 'retired', disabledAt: new Date() })
    const playerId = await seedPlayer(workspaceId, 'UserId7661')
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'UserId7661',
    })
    await call(token, { 'X-Support-Workspace': 'retired' }).expect(401)
  })
})

describe('requireSdkHeaders', () => {
  it('403s when X-Support-Workspace disagrees with the token claim', async () => {
    const { token } = await setup()
    await seedWorkspace({ slug: 'other-game' })
    const res = await call(token, { 'X-Support-Workspace': 'other-game' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('workspace_mismatch')
  })

  it('403s when X-Support-Workspace is absent — a misconfigured build must fail loudly', async () => {
    const { token } = await setup()
    await call(token).expect(403)
  })

  it('compares the slug case-insensitively and ignores surrounding whitespace', async () => {
    const { token } = await setup()
    await call(token, { 'X-Support-Workspace': ' Demo-Game ' }).expect(200)
  })

  it('treats the three informational headers as optional', async () => {
    const { token } = await setup()
    const res = await call(token, { 'X-Support-Workspace': 'demo-game' })
    expect(res.status).toBe(200)
    expect(res.body.sdkVersion).toBeNull()
    expect(res.body.clientVersion).toBeNull()
    expect(res.body.idempotencyKey).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api test auth.middleware`
Expected: FAIL — 404 from Express, because `/sdk` is not mounted

- [ ] **Step 3: Write `backend/src/auth/requirePlayerToken.ts`**

```ts
import type { RequestHandler } from 'express'
import { eq } from 'drizzle-orm'
import { sendError } from '../errors.ts'
import { workspace } from '../db/schema/index.ts'
import { withoutWorkspace } from '../db/withWorkspace.ts'
import { InvalidPlayerToken, verifyPlayerToken } from './jwt.ts'

export type PlayerContext = {
  workspaceId: string
  playerId: string
  externalPlayerId: string
  workspaceSlug: string
  sdkVersion: string | null
  clientVersion: string | null
  idempotencyKey: string | null
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      player?: PlayerContext
    }
  }
}

/**
 * The workspace comes from the JWT claim and from nowhere else. The slug is looked
 * up here so requireSdkHeaders can cross-check the header against it.
 */
export const requirePlayerToken: RequestHandler = async (req, res, next) => {
  const header = req.header('authorization') ?? ''
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) {
    sendError(res, 401, 'unauthorized', 'Expected an Authorization: Bearer <player_token> header.')
    return
  }

  let claims
  try {
    claims = await verifyPlayerToken(rest.join(' ').trim())
  } catch (error) {
    if (error instanceof InvalidPlayerToken) {
      sendError(res, 401, 'unauthorized', 'Player token is not valid.')
      return
    }
    next(error)
    return
  }

  const [found] = await withoutWorkspace(async (tx) =>
    tx
      .select({ slug: workspace.slug, disabledAt: workspace.disabledAt })
      .from(workspace)
      .where(eq(workspace.id, claims.workspace_id))
      .limit(1),
  )

  // A token for a deleted or disabled workspace is dead immediately, without
  // waiting out its 15 minutes.
  if (!found || found.disabledAt) {
    sendError(res, 401, 'unauthorized', 'Player token is not valid.')
    return
  }

  req.player = {
    workspaceId: claims.workspace_id,
    playerId: claims.player_id,
    externalPlayerId: claims.external_player_id,
    workspaceSlug: found.slug,
    sdkVersion: null,
    clientVersion: null,
    idempotencyKey: null,
  }
  next()
}
```

- [ ] **Step 4: Write `backend/src/auth/requireSdkHeaders.ts`**

```ts
import type { RequestHandler } from 'express'
import { SDK_HEADERS } from '@support/types'
import { sendError } from '../errors.ts'

const normalise = (value: string | undefined): string | null => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

/**
 * `/sdk/*` only. The workspace slug in the header is NEVER used to scope a query —
 * it is cross-checked against the token claim so a build pointed at the wrong game
 * fails loudly instead of writing somewhere it shouldn't.
 *
 * 403 rather than 404 here: this is a header-versus-claim contradiction, not an
 * invisible row. The "expect 404, not 403" rule applies to RLS-hidden data.
 */
export const requireSdkHeaders: RequestHandler = (req, res, next) => {
  const player = req.player
  if (!player) {
    sendError(res, 401, 'unauthorized', 'Player token is required.')
    return
  }

  const claimed = normalise(req.header(SDK_HEADERS.workspace))
  if (!claimed) {
    sendError(res, 403, 'workspace_mismatch', `The ${SDK_HEADERS.workspace} header is required.`)
    return
  }
  if (claimed.toLowerCase() !== player.workspaceSlug.toLowerCase()) {
    sendError(res, 403, 'workspace_mismatch', 'Workspace header does not match the authenticated workspace.')
    return
  }

  // Logged, never load-bearing: the SDK's Outbox retries, so duplicate delivery is
  // expected and idempotency is handled by the client-generated primary key.
  player.idempotencyKey = normalise(req.header(SDK_HEADERS.idempotencyKey))
  player.sdkVersion = normalise(req.header(SDK_HEADERS.sdkVersion))
  player.clientVersion = normalise(req.header(SDK_HEADERS.clientVersion))
  next()
}
```

- [ ] **Step 5: Write `backend/src/sdk/router.ts`**

```ts
import { Router } from 'express'
import { requirePlayerToken } from '../auth/requirePlayerToken.ts'
import { requireSdkHeaders } from '../auth/requireSdkHeaders.ts'

export const sdkRouter = Router()

sdkRouter.use(requirePlayerToken, requireSdkHeaders)

/** Test-only introspection. Delete once Tasks 9-12 have populated this router. */
sdkRouter.get('/_whoami', (req, res) => {
  res.json(req.player)
})

// Task 9  → POST /sessions/start
// Task 10 → POST /sessions/end
// Task 11 → POST /incidents
// Task 12 → GET  /unread
```

Mount it in `src/app.ts`, above `errorMiddleware`:

```ts
import { sdkRouter } from './sdk/router.ts'
// ...
app.use('/sdk', sdkRouter)
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @support/api test auth.middleware`
Expected: PASS — 8 tests

- [ ] **Step 7: Add a header-payload helper for Tasks 9–11**

`backend/src/sdk/headers.ts`:

```ts
import type { PlayerContext } from '../auth/requirePlayerToken.ts'

/**
 * The four SDK headers, shaped for an event payload. Never include the token.
 */
export function headerPayload(player: PlayerContext): Record<string, unknown> {
  return {
    idempotency_key: player.idempotencyKey,
    sdk_version: player.sdkVersion,
    header_client_version: player.clientVersion,
  }
}
```

- [ ] **Step 8: Commit**

```bash
git add backend/src/auth/requirePlayerToken.ts backend/src/auth/requireSdkHeaders.ts \
        backend/src/sdk/router.ts backend/src/sdk/headers.ts backend/src/app.ts \
        backend/tests/auth.middleware.test.ts
git commit -m "feat(sdk): player-token middleware and X-Support-Workspace cross-check"
```

---

### Task 8: `splitSnapshot()` — the declared/raw split

**Files:**
- Create: `backend/src/playerState/split.ts`
- Test: `backend/tests/playerState.split.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_FIELD_KEYS` from `@support/types`.
- Produces: `splitSnapshot(input: unknown, declaredKeys: ReadonlySet<string>, authenticatedExternalPlayerId: string): SnapshotSplit`, where `SnapshotSplit = { declared: Record<string, unknown>; raw: Record<string, unknown>; isMissing: boolean; degradedReason: string | null }`. Pure — no database access, no clock.

The rules, in the order the function applies them. Each is asserted by a test below.

| # | Rule |
|---|---|
| 1 | A snapshot that is absent, `null`, not an object, an array, or `{}` yields `isMissing: true` and two empty objects. |
| 2 | `degraded_reason` is lifted to its own field (string, truncated to 500 chars) and removed from the candidates. A non-string becomes `null`. |
| 3 | `extra` is flattened into the candidate map **first**, so a top-level key of the same name wins. `extra` itself never appears in `raw` as a nested object. |
| 4 | Candidates are partitioned against `declaredKeys` **as passed** — the set current at this moment. Anything not in it goes to `raw`. This is what makes promotion non-retroactive. |
| 5 | Nothing is dropped. Every candidate key lands in exactly one of the two objects. |
| 6 | A `player_id` that disagrees with the authenticated player is recorded at `raw.__player_id_mismatch` and does not fail anything. The authoritative player is always the JWT's. Compared **stringified**, so a numeric id still trips the diagnostic. |
| 6b | An `extra` that is present but not a plain object is preserved at `raw.__extra_malformed` rather than discarded — it is still data the game sent. |
| 6c | `declared` and `raw` are built with `Object.create(null)`, so a game-supplied `__proto__` key lands as real data instead of invoking the prototype setter and vanishing. |
| 7 | `isMissing` is judged on the six **provider** keys alone: `true` when every one is absent or `null`. Device fields come from the SDK's own probe and are present even when the game's provider throws on everything, so including them would make `is_missing` unreachable. |

- [ ] **Step 1: Write the failing test**

`backend/tests/playerState.split.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DECLARED_FIELD_KEYS } from '@support/types'
import { splitSnapshot } from '../src/playerState/split.ts'

const ALL_DECLARED = new Set<string>(DECLARED_FIELD_KEYS)
const SPEC_SNAPSHOT = {
  player_id: 'UserId7661',
  client_version: '6.2.01',
  platform: 'ios',
  os_version: '26.5.2',
  device_model: 'iPhone 13 Pro Max',
  locale: 'en-GB',
  player_level: 34,
  total_spend: 0.0,
  spend_tier: 'non-payer',
  account_created_at: '2026-07-27T09:12:00Z',
  last_session_at: '2026-08-03T08:40:00Z',
  extra: { ab_bucket: 'B', collection_status: 'event_in_progress' },
  degraded_reason: null,
}

describe('splitSnapshot', () => {
  it('splits the spec example into eleven declared keys and the two extras', () => {
    const result = splitSnapshot(SPEC_SNAPSHOT, ALL_DECLARED, 'UserId7661')
    expect(Object.keys(result.declared).sort()).toEqual([...DECLARED_FIELD_KEYS].sort())
    expect(result.declared.player_level).toBe(34)
    expect(result.raw).toEqual({ ab_bucket: 'B', collection_status: 'event_in_progress' })
    expect(result.isMissing).toBe(false)
    expect(result.degradedReason).toBeNull()
  })

  it('never nests extra inside raw', () => {
    const result = splitSnapshot(SPEC_SNAPSHOT, ALL_DECLARED, 'UserId7661')
    expect(result.raw.extra).toBeUndefined()
  })

  it('is non-retroactive: an unpromoted key goes to raw even though a later set would claim it', () => {
    const before = splitSnapshot(SPEC_SNAPSHOT, ALL_DECLARED, 'UserId7661')
    expect(before.raw.ab_bucket).toBe('B')
    expect(before.declared.ab_bucket).toBeUndefined()

    const after = splitSnapshot(SPEC_SNAPSHOT, new Set([...ALL_DECLARED, 'ab_bucket']), 'UserId7661')
    expect(after.declared.ab_bucket).toBe('B')
    expect(after.raw.ab_bucket).toBeUndefined()
  })

  it('sends everything to raw when nothing has been declared yet', () => {
    const result = splitSnapshot(SPEC_SNAPSHOT, new Set(), 'UserId7661')
    expect(result.declared).toEqual({})
    expect(result.raw.platform).toBe('ios')
    expect(result.raw.ab_bucket).toBe('B')
  })

  it('lets a top-level key win a collision with extra', () => {
    const result = splitSnapshot(
      { ...SPEC_SNAPSHOT, extra: { platform: 'smuggled', ab_bucket: 'B' } },
      ALL_DECLARED,
      'UserId7661',
    )
    expect(result.declared.platform).toBe('ios')
    expect(result.raw.platform).toBeUndefined()
  })

  it('drops nothing — every candidate key lands somewhere exactly once', () => {
    const result = splitSnapshot(SPEC_SNAPSHOT, ALL_DECLARED, 'UserId7661')
    const landed = new Set([...Object.keys(result.declared), ...Object.keys(result.raw)])
    for (const key of ['player_id', 'platform', 'ab_bucket', 'collection_status']) {
      expect(landed.has(key), key).toBe(true)
    }
    const overlap = Object.keys(result.declared).filter((k) => k in result.raw)
    expect(overlap).toEqual([])
  })

  it('lifts and truncates degraded_reason', () => {
    const long = 'x'.repeat(900)
    expect(splitSnapshot({ ...SPEC_SNAPSHOT, degraded_reason: 'provider threw on total_spend' }, ALL_DECLARED, 'UserId7661').degradedReason)
      .toBe('provider threw on total_spend')
    expect(splitSnapshot({ ...SPEC_SNAPSHOT, degraded_reason: long }, ALL_DECLARED, 'UserId7661').degradedReason)
      .toHaveLength(500)
    expect(splitSnapshot({ ...SPEC_SNAPSHOT, degraded_reason: 12 }, ALL_DECLARED, 'UserId7661').degradedReason)
      .toBeNull()
    expect(splitSnapshot({ ...SPEC_SNAPSHOT, degraded_reason: 'x' }, ALL_DECLARED, 'UserId7661').raw.degraded_reason)
      .toBeUndefined()
  })

  it('treats an absent, null, non-object, array or empty snapshot as missing', () => {
    for (const input of [undefined, null, 'nope', 42, [], {}]) {
      const result = splitSnapshot(input, ALL_DECLARED, 'UserId7661')
      expect(result.isMissing, JSON.stringify(input) ?? 'undefined').toBe(true)
      expect(result.declared).toEqual({})
      expect(result.raw).toEqual({})
    }
  })

  it('judges is_missing on the provider fields alone, not the device fields', () => {
    // A provider that threw on all six. Device fields still arrive.
    const deviceOnly = {
      client_version: '6.2.01',
      platform: 'ios',
      os_version: '26.5.2',
      device_model: 'iPhone 13 Pro Max',
      locale: 'en-GB',
      degraded_reason: 'provider threw on every field',
    }
    const result = splitSnapshot(deviceOnly, ALL_DECLARED, 'UserId7661')
    expect(result.isMissing).toBe(true)
    expect(result.degradedReason).toBe('provider threw on every field')
    expect(result.declared.platform).toBe('ios')
  })

  it('is not missing when even one provider field arrived', () => {
    const result = splitSnapshot({ platform: 'ios', player_level: 34 }, ALL_DECLARED, 'UserId7661')
    expect(result.isMissing).toBe(false)
  })

  it('treats a null provider value as absent but keeps the key', () => {
    const result = splitSnapshot({ platform: 'ios', player_level: null }, ALL_DECLARED, 'UserId7661')
    expect(result.isMissing).toBe(true)
    expect('player_level' in result.declared).toBe(true)
    expect(result.declared.player_level).toBeNull()
  })

  it('records a player_id mismatch in raw without failing', () => {
    const result = splitSnapshot({ ...SPEC_SNAPSHOT, player_id: 'SomeoneElse' }, ALL_DECLARED, 'UserId7661')
    expect(result.declared.player_id).toBe('SomeoneElse')
    expect(result.raw.__player_id_mismatch).toEqual({ claimed: 'SomeoneElse', authenticated: 'UserId7661' })
  })

  it('records no mismatch when the ids agree or the snapshot omits player_id', () => {
    expect(splitSnapshot(SPEC_SNAPSHOT, ALL_DECLARED, 'UserId7661').raw.__player_id_mismatch).toBeUndefined()
    expect(splitSnapshot({ platform: 'ios' }, ALL_DECLARED, 'UserId7661').raw.__player_id_mismatch).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api test playerState.split`
Expected: FAIL — `Cannot find module '../src/playerState/split.ts'`

- [ ] **Step 3: Write `backend/src/playerState/split.ts`**

```ts
import { PROVIDER_FIELD_KEYS } from '@support/types'

export type SnapshotSplit = {
  declared: Record<string, unknown>
  raw: Record<string, unknown>
  isMissing: boolean
  degradedReason: string | null
}

const MAX_DEGRADED_REASON = 500
const EMPTY: SnapshotSplit = { declared: {}, raw: {}, isMissing: true, degradedReason: null }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Splits one SDK snapshot into the two jsonb columns of player_state_snapshot.
 *
 * `declaredKeys` must be the declared_field set read inside the SAME transaction as
 * the write. The split happens at write time and is permanent — promote a field
 * later and old snapshots keep it in `raw`. There is no backfill, ever. Passing a
 * cached or process-wide set would quietly break that.
 *
 * Nothing is ever dropped: every key the game sent lands in `declared` or `raw`.
 */
export function splitSnapshot(
  input: unknown,
  declaredKeys: ReadonlySet<string>,
  authenticatedExternalPlayerId: string,
): SnapshotSplit {
  if (!isPlainObject(input)) return { ...EMPTY, declared: {}, raw: {} }

  const { extra, degraded_reason: degradedRaw, ...topLevel } = input

  const degradedReason =
    typeof degradedRaw === 'string' && degradedRaw.length > 0
      ? degradedRaw.slice(0, MAX_DEGRADED_REASON)
      : null

  // `extra` first so a top-level key of the same name wins.
  const candidates: Record<string, unknown> = {
    ...(isPlainObject(extra) ? extra : {}),
    ...topLevel,
  }

  // An `extra` that arrived in the wrong shape (an array, a string, a number) is
  // still data the game sent, so it is preserved under a reserved key rather than
  // discarded. An agent seeing __extra_malformed knows something arrived broken;
  // dropping it silently would leave them wondering where it went.
  const extraMalformed = extra !== undefined && !isPlainObject(extra) ? extra : undefined

  if (Object.keys(candidates).length === 0) {
    return { declared: {}, raw: {}, isMissing: true, degradedReason }
  }

  // Object.create(null), NOT {}: a game can legitimately send a key named
  // `__proto__`, and `raw['__proto__'] = value` on an ordinary object invokes
  // Object.prototype's accessor instead of creating an own property — the value
  // silently vanishes before it reaches the jsonb column. That would break
  // "nothing the game sends is ever dropped" on untrusted input. Object.keys,
  // `in` and JSON.stringify all behave identically on a null-prototype object.
  const declared: Record<string, unknown> = Object.create(null)
  const raw: Record<string, unknown> = Object.create(null)
  for (const [key, value] of Object.entries(candidates)) {
    if (declaredKeys.has(key)) declared[key] = value
    else raw[key] = value
  }

  // snapshot.player_id is advisory only — the authoritative player comes from the
  // JWT. A mismatch is recorded and does not fail the request; the SDK cannot be
  // trusted to identify the player it is authenticated as.
  // Compare stringified, so a numeric player_id still trips the diagnostic — the
  // point is catching an SDK confused about who it is, and the wire contract's
  // "string" is a documented shape, not a guarantee. The ORIGINAL value is recorded,
  // not the stringified one, so the row shows what actually arrived.
  const claimed = candidates.player_id
  if (
    claimed !== undefined &&
    claimed !== null &&
    String(claimed) !== authenticatedExternalPlayerId
  ) {
    raw.__player_id_mismatch = { claimed, authenticated: authenticatedExternalPlayerId }
  }

  if (extraMalformed !== undefined) {
    raw.__extra_malformed = extraMalformed
  }

  // Judged on the provider fields only: the SDK's DeviceProbe fills the device
  // fields with no game involvement, so a provider that throws on all six still
  // yields five populated keys. Including them would make is_missing unreachable.
  const isMissing = PROVIDER_FIELD_KEYS.every(
    (key) => candidates[key] === undefined || candidates[key] === null,
  )

  return { declared, raw, isMissing, degradedReason }
}
```

Note that `__player_id_mismatch` is written *after* the partition, so it always lands in `raw` even if someone later declares a field with that name. Reserved keys in `raw` are prefixed `__`; document any future ones the same way.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @support/api test playerState.split`
Expected: PASS — 13 tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/playerState/split.ts backend/tests/playerState.split.test.ts
git commit -m "feat(sdk): declared/raw snapshot split, non-retroactive by construction"
```

---

### Task 9: `POST /sdk/sessions/start`

**Files:**
- Create: `backend/src/playerState/declaredKeys.ts`, `backend/src/sdk/sessionsStart.ts`
- Modify: `backend/src/sdk/router.ts`
- Test: `backend/tests/sdk.sessionsStart.test.ts`

**Interfaces:**
- Consumes: `SessionStartBody`, `coerceInstant` (`@support/types`); `withWorkspace`, `Tx`; `appendEvent`; `splitSnapshot`; `headerPayload`; tables `session`, `playerStateSnapshot`, `declaredField`.
- Produces: `sessionsStart: RequestHandler`; `loadDeclaredKeys(tx: Tx): Promise<ReadonlySet<string>>` from `src/playerState/declaredKeys.ts` (reused by nothing else in this slice, but the promotion UI will need it). Response body: `{ "ok": true }`.

Four behaviours that are easy to get subtly wrong, all asserted below:

1. **`session_start` is appended only when the `INSERT` actually inserted.** The Outbox retries, so a duplicate delivery must not append a second event — that would double-count the self-serve denominator, which is *the* metric this endpoint exists to feed.
2. **The snapshot upsert is `ON CONFLICT DO NOTHING`, not `DO UPDATE`.** A retry arriving after an admin promoted a field would otherwise re-split against the newer declared set and move a key from `raw` into `declared` — retroactive promotion through the back door. First write wins, permanently.
3. **A `session_id` that is not this player's is refused without a write.** `ON CONFLICT (id) DO NOTHING` sees the index regardless of RLS, so it silently no-ops, and the follow-up snapshot upsert would then target a row belonging to someone else. An explicit RLS-scoped ownership check is the only thing standing between a replayed uuid and a cross-tenant write.
4. **`captured_at` is the client's `started_at`**, coerced for sanity — not `now()`. The Game View must show what was true when the issue was raised, and an Outbox entry can be delivered hours late.

- [ ] **Step 1: Write the failing test**

`backend/tests/sdk.sessionsStart.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { eq } from 'drizzle-orm'
import { DECLARED_FIELD_KEYS } from '@support/types'
import { closeDb } from '../src/db/client.ts'
import { withWorkspace } from '../src/db/withWorkspace.ts'
import { event, playerStateSnapshot, session } from '../src/db/schema/index.ts'
import { app, mintToken } from './helpers/app.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedDeclaredFields,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

const SESSION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

const SNAPSHOT = {
  player_id: 'UserId7661',
  client_version: '6.2.01',
  platform: 'ios',
  os_version: '26.5.2',
  device_model: 'iPhone 13 Pro Max',
  locale: 'en-GB',
  player_level: 34,
  total_spend: 0.0,
  spend_tier: 'non-payer',
  account_created_at: '2026-07-27T09:12:00Z',
  last_session_at: '2026-08-03T08:40:00Z',
  extra: { ab_bucket: 'B', collection_status: 'event_in_progress' },
  degraded_reason: null,
}

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function fixture(slug = 'demo-game') {
  const workspaceId = await seedWorkspace({ slug })
  const playerId = await seedPlayer(workspaceId, 'UserId7661')
  await seedDeclaredFields(workspaceId, DECLARED_FIELD_KEYS)
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'UserId7661',
  })
  return { workspaceId, playerId, token, slug }
}

const post = (f: { token: string; slug: string }, body: unknown, headers: Record<string, string> = {}) => {
  const req = request(app)
    .post('/sdk/sessions/start')
    .set('Authorization', `Bearer ${f.token}`)
    .set('X-Support-Workspace', f.slug)
    .set('X-Support-Sdk', '1.0.2')
    .set('X-Support-Client-Version', '6.2.01')
    .set('Idempotency-Key', 'idem-1')
  for (const [k, v] of Object.entries(headers)) req.set(k, v)
  return req.send(body as object)
}

const body = (overrides: Record<string, unknown> = {}) => ({
  session_id: SESSION_ID,
  entry_point: 'settings_menu',
  started_at: '2026-08-04T09:12:00Z',
  snapshot: SNAPSHOT,
  ...overrides,
})

const rows = <T>(workspaceId: string, fn: (tx: Parameters<Parameters<typeof withWorkspace>[1]>[0]) => Promise<T>) =>
  withWorkspace(workspaceId, fn)

describe('POST /sdk/sessions/start', () => {
  it('writes the session, the split snapshot and one session_start event', async () => {
    const f = await fixture()
    const res = await post(f, body())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const sessions = await rows(f.workspaceId, async (tx) => tx.select().from(session))
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.id).toBe(SESSION_ID)
    expect(sessions[0]!.playerId).toBe(f.playerId)
    expect(sessions[0]!.entryPoint).toBe('settings_menu')
    expect(sessions[0]!.startedAt.toISOString()).toBe('2026-08-04T09:12:00.000Z')
    expect(sessions[0]!.endedAt).toBeNull()

    const snapshots = await rows(f.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))
    expect(snapshots).toHaveLength(1)
    expect(Object.keys(snapshots[0]!.declared).sort()).toEqual([...DECLARED_FIELD_KEYS].sort())
    expect(snapshots[0]!.raw).toEqual({ ab_bucket: 'B', collection_status: 'event_in_progress' })
    expect(snapshots[0]!.isMissing).toBe(false)
    expect(snapshots[0]!.degradedReason).toBeNull()
    // captured_at is the client's started_at, not now().
    expect(snapshots[0]!.capturedAt.toISOString()).toBe('2026-08-04T09:12:00.000Z')

    const events = await rows(f.workspaceId, async (tx) => tx.select().from(event))
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('session_start')
    expect(events[0]!.sessionId).toBe(SESSION_ID)
    expect(events[0]!.actorType).toBe('player')
    expect(events[0]!.actorId).toBe(f.playerId)
    expect(events[0]!.payload).toMatchObject({
      entry_point: 'settings_menu',
      idempotency_key: 'idem-1',
      sdk_version: '1.0.2',
    })
  })

  it('never logs the token in the event payload', async () => {
    const f = await fixture()
    await post(f, body()).expect(200)
    const events = await rows(f.workspaceId, async (tx) => tx.select().from(event))
    expect(JSON.stringify(events[0]!.payload)).not.toContain(f.token)
  })

  it('is idempotent: a duplicate delivery appends no second event', async () => {
    const f = await fixture()
    await post(f, body()).expect(200)
    await post(f, body()).expect(200)
    await post(f, body(), { 'Idempotency-Key': 'idem-2' }).expect(200)

    expect(await rows(f.workspaceId, async (tx) => tx.select().from(session))).toHaveLength(1)
    expect(await rows(f.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))).toHaveLength(1)
    const events = await rows(f.workspaceId, async (tx) => tx.select().from(event))
    expect(events.filter((e) => e.type === 'session_start')).toHaveLength(1)
  })

  it('does not re-split a snapshot on redelivery — promotion stays non-retroactive', async () => {
    const f = await fixture()
    await post(f, body()).expect(200)
    await seedDeclaredFields(f.workspaceId, ['ab_bucket'])
    await post(f, body()).expect(200)

    const snapshots = await rows(f.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.raw.ab_bucket).toBe('B')
    expect(snapshots[0]!.declared.ab_bucket).toBeUndefined()
  })

  it('splits against the declared set current at write time', async () => {
    const workspaceId = await seedWorkspace({ slug: 'sparse' })
    const playerId = await seedPlayer(workspaceId, 'UserId7661')
    await seedDeclaredFields(workspaceId, ['platform', 'client_version'])
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'UserId7661',
    })
    await post({ token, slug: 'sparse' }, body()).expect(200)

    const snapshots = await rows(workspaceId, async (tx) => tx.select().from(playerStateSnapshot))
    expect(Object.keys(snapshots[0]!.declared).sort()).toEqual(['client_version', 'platform'])
    expect(snapshots[0]!.raw.player_level).toBe(34)
  })

  // A malformed, empty or absent snapshot is a STATE, never a 4xx: rejecting it
  // would mean the conversations where something is broken are the ones that fail
  // to attach context.
  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty object', {}],
    ['a bare string', 'garbage'],
    ['a number', 42],
  ])('records a %s snapshot as is_missing and still returns 200', async (_label, snapshot) => {
    const f = await fixture()
    await post(f, body({ snapshot })).expect(200)

    const snapshots = await rows(f.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.isMissing).toBe(true)
    expect(snapshots[0]!.declared).toEqual({})
    expect(snapshots[0]!.raw).toEqual({})
    // The session still exists — a broken snapshot never costs us the visit.
    expect(await rows(f.workspaceId, async (tx) => tx.select().from(session))).toHaveLength(1)
  })

  it('records degraded_reason when the provider partially threw', async () => {
    const f = await fixture()
    await post(
      f,
      body({
        snapshot: {
          platform: 'ios',
          client_version: '6.2.01',
          player_level: 34,
          degraded_reason: 'total_spend threw',
        },
      }),
    ).expect(200)
    const snapshots = await rows(f.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))
    expect(snapshots[0]!.degradedReason).toBe('total_spend threw')
    expect(snapshots[0]!.isMissing).toBe(false)
  })

  it('accepts an unknown entry_point and unknown request fields', async () => {
    const f = await fixture()
    await post(f, body({ entry_point: 'brand_new_screen', invented_later: { nested: true } })).expect(200)
    const sessions = await rows(f.workspaceId, async (tx) => tx.select().from(session))
    expect(sessions[0]!.entryPoint).toBe('brand_new_screen')
  })

  it('falls back to now() for an absurd started_at rather than storing it', async () => {
    const f = await fixture()
    await post(f, body({ started_at: '2099-01-01T00:00:00Z' })).expect(200)
    const sessions = await rows(f.workspaceId, async (tx) => tx.select().from(session))
    expect(sessions[0]!.startedAt.getFullYear()).toBeLessThan(2030)
  })

  it('422s only when session_id is unusable', async () => {
    const f = await fixture()
    await post(f, body({ session_id: 'not-a-uuid' })).expect(422)
    await post(f, { entry_point: 'settings_menu' }).expect(422)
  })

  it('413s on a body over the limit', async () => {
    const f = await fixture()
    const huge = { ...body(), snapshot: { ...SNAPSHOT, extra: { blob: 'x'.repeat(70_000) } } }
    await post(f, huge).expect(413)
  })

  it('401s without a token and 403s on a workspace header mismatch', async () => {
    const f = await fixture()
    await seedWorkspace({ slug: 'other-game' })
    await request(app).post('/sdk/sessions/start').send(body()).expect(401)
    await post({ token: f.token, slug: 'other-game' }, body()).expect(403)
  })

  it('refuses a session_id belonging to another workspace, writing nothing there', async () => {
    const victim = await fixture('victim-game')
    await post(victim, body()).expect(200)

    const attacker = await fixture('attacker-game')
    const res = await post(attacker, body())
    expect(res.status).toBe(200) // still 200: the SDK must never be told anything useful

    // The victim's session and snapshot are untouched.
    const victimSessions = await rows(victim.workspaceId, async (tx) => tx.select().from(session))
    expect(victimSessions[0]!.playerId).toBe(victim.playerId)
    const victimSnapshots = await rows(victim.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))
    expect(victimSnapshots).toHaveLength(1)

    // Nothing was written into the attacker's workspace but an incident.
    const attackerSessions = await rows(attacker.workspaceId, async (tx) => tx.select().from(session))
    expect(attackerSessions).toHaveLength(0)
    const attackerSnapshots = await rows(attacker.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))
    expect(attackerSnapshots).toHaveLength(0)
    const attackerEvents = await rows(attacker.workspaceId, async (tx) => tx.select().from(event))
    expect(attackerEvents).toHaveLength(1)
    expect(attackerEvents[0]!.type).toBe('sdk_incident')
    expect(attackerEvents[0]!.payload).toMatchObject({ kind: 'session_id_not_ours' })

    // And the whole row count is still one session, globally.
    const { rows: all } = await ownerPool.query('select count(*)::int as n from session')
    expect(all[0]!.n).toBe(1)
  })

  it('refuses a session_id belonging to another player in the same workspace', async () => {
    const f = await fixture()
    const other = await seedPlayer(f.workspaceId, 'SomeoneElse')
    await ownerPool.query(
      `insert into session (id, workspace_id, player_id, entry_point, started_at)
       values ($1, $2, $3, 'settings_menu', now())`,
      [SESSION_ID, f.workspaceId, other],
    )

    await post(f, body()).expect(200)
    const sessions = await rows(f.workspaceId, async (tx) =>
      tx.select().from(session).where(eq(session.id, SESSION_ID)),
    )
    expect(sessions[0]!.playerId).toBe(other)
    expect(await rows(f.workspaceId, async (tx) => tx.select().from(playerStateSnapshot))).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api test sdk.sessionsStart`
Expected: FAIL — 404 from Express; the route is not mounted

- [ ] **Step 3: Write `backend/src/playerState/declaredKeys.ts`**

```ts
import { declaredField } from '../db/schema/index.ts'
import type { Tx } from '../db/withWorkspace.ts'

/**
 * Read inside the same transaction as the write it feeds. The split is made against
 * the set current at that moment, which is exactly what makes promotion
 * non-retroactive — so this must never be cached across requests.
 */
export async function loadDeclaredKeys(tx: Tx): Promise<ReadonlySet<string>> {
  const rows = await tx.select({ key: declaredField.key }).from(declaredField)
  return new Set(rows.map((row) => row.key))
}
```

- [ ] **Step 4: Write `backend/src/sdk/sessionsStart.ts`**

```ts
import type { RequestHandler } from 'express'
import { and, eq } from 'drizzle-orm'
import { SessionStartBody, coerceInstant } from '@support/types'
import { sendError } from '../errors.ts'
import { appendEvent } from '../events/appendEvent.ts'
import { playerStateSnapshot, session } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'
import { loadDeclaredKeys } from '../playerState/declaredKeys.ts'
import { splitSnapshot } from '../playerState/split.ts'
import { headerPayload } from './headers.ts'

/**
 * Non-blocking on the SDK side, so this can land after the web app has already
 * created a conversation. The snapshot is keyed to session_id and a conversation
 * reaches it through conversation.session_id, so a late arrival simply becomes
 * visible — no repair step, no ordering requirement.
 */
export const sessionsStart: RequestHandler = async (req, res) => {
  const player = req.player!

  const parsed = SessionStartBody.safeParse(req.body)
  if (!parsed.success) {
    // The only 4xx this endpoint has: without a usable session_id there is no
    // primary key to write against. Everything else about the body is recoverable.
    sendError(res, 422, 'invalid_request', 'session_id must be a uuid.')
    return
  }

  const body = parsed.data
  const now = new Date()
  const startedAt = coerceInstant(body.started_at, now)

  await withWorkspace(player.workspaceId, async (tx) => {
    const inserted = await tx
      .insert(session)
      .values({
        id: body.session_id,
        workspaceId: player.workspaceId,
        playerId: player.playerId,
        entryPoint: body.entry_point,
        startedAt,
      })
      .onConflictDoNothing({ target: session.id })
      .returning({ id: session.id })

    const isNewSession = inserted.length > 0

    if (!isNewSession) {
      // The uuid already exists. It is either a retry from this player's Outbox
      // (expected, not exceptional) or an id that is not theirs.
      //
      // ON CONFLICT (id) DO NOTHING consults the unique index, which RLS does not
      // filter, so it no-ops either way. Only an explicit scoped SELECT can tell the
      // two apart — and without it the snapshot upsert below would target a row
      // belonging to another workspace or another player.
      const [owned] = await tx
        .select({ id: session.id })
        .from(session)
        .where(and(eq(session.id, body.session_id), eq(session.playerId, player.playerId)))
        .limit(1)

      if (!owned) {
        await appendEvent(tx, {
          workspaceId: player.workspaceId,
          type: 'sdk_incident',
          actorType: 'system',
          occurredAt: now,
          payload: {
            kind: 'session_id_not_ours',
            session_id: body.session_id,
            ...headerPayload(player),
          },
        })
        return
      }
    }

    const declaredKeys = await loadDeclaredKeys(tx)
    const split = splitSnapshot(body.snapshot, declaredKeys, player.externalPlayerId)

    // DO NOTHING, not DO UPDATE. The split is permanent: re-splitting a redelivered
    // payload against a newer declared_field set would promote a key retroactively,
    // which the schema spec forbids outright ("no backfill, ever").
    await tx
      .insert(playerStateSnapshot)
      .values({
        workspaceId: player.workspaceId,
        sessionId: body.session_id,
        declared: split.declared,
        raw: split.raw,
        isMissing: split.isMissing,
        degradedReason: split.degradedReason,
        capturedAt: startedAt,
      })
      .onConflictDoNothing({ target: playerStateSnapshot.sessionId })

    // Only on a genuinely new session. A second session_start would double-count the
    // self-serve denominator, which is the whole reason this endpoint exists.
    if (isNewSession) {
      await appendEvent(tx, {
        workspaceId: player.workspaceId,
        type: 'session_start',
        sessionId: body.session_id,
        actorId: player.playerId,
        actorType: 'player',
        occurredAt: startedAt,
        payload: {
          entry_point: body.entry_point,
          snapshot_state: split.isMissing ? 'missing' : split.degradedReason ? 'degraded' : 'ok',
          ...headerPayload(player),
        },
      })
    }
  })

  res.status(200).json({ ok: true })
}
```

- [ ] **Step 5: Mount it in `backend/src/sdk/router.ts`**

```ts
import { sessionsStart } from './sessionsStart.ts'
// ...
sdkRouter.post('/sessions/start', sessionsStart)
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @support/api test sdk.sessionsStart`
Expected: PASS — 18 tests (14 `it()` blocks, one of which is an `it.each` with 5 cases)

- [ ] **Step 7: Commit**

```bash
git add backend/src/sdk/sessionsStart.ts backend/src/playerState/declaredKeys.ts \
        backend/src/sdk/router.ts backend/tests/sdk.sessionsStart.test.ts
git commit -m "feat(sdk): POST /sdk/sessions/start with idempotent writes and permanent split"
```

---

### Task 10: `POST /sdk/sessions/end`

**Files:**
- Create: `backend/src/sdk/sessionsEnd.ts`
- Modify: `backend/src/sdk/router.ts`
- Test: `backend/tests/sdk.sessionsEnd.test.ts`

**Interfaces:**
- Consumes: `SessionEndBody` (`@support/types`); `withWorkspace`; `appendEvent`; `headerPayload`; table `session`.
- Produces: `sessionsEnd: RequestHandler`. Response body: `{ "ok": true }`.

**The three client-reported values are recorded but not trusted.** All of `duration_ms`, `conversation_created` and `articles_read` are derivable server-side, so they land in the event payload under `*_reported` names and the derived duration lands beside them. Reporting reads the derived values and the `article_read` events; the reported ones exist only to cross-check a suspected bug. The naming is the enforcement — nobody aggregates a column called `duration_ms_reported` by accident.

- [ ] **Step 1: Write the failing test**

`backend/tests/sdk.sessionsEnd.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { eq } from 'drizzle-orm'
import { closeDb } from '../src/db/client.ts'
import { withWorkspace } from '../src/db/withWorkspace.ts'
import { event, session } from '../src/db/schema/index.ts'
import { app, mintToken } from './helpers/app.ts'
import { closeOwnerPool, seedPlayer, seedSession, seedWorkspace, truncateAll } from './helpers/db.ts'

const SESSION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const STARTED_AT = new Date('2026-08-04T09:12:00Z')

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function fixture(slug = 'demo-game') {
  const workspaceId = await seedWorkspace({ slug })
  const playerId = await seedPlayer(workspaceId, 'UserId7661')
  await seedSession({ workspaceId, playerId, id: SESSION_ID, startedAt: STARTED_AT })
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'UserId7661',
  })
  return { workspaceId, playerId, token, slug }
}

const post = (f: { token: string; slug: string }, body: unknown) =>
  request(app)
    .post('/sdk/sessions/end')
    .set('Authorization', `Bearer ${f.token}`)
    .set('X-Support-Workspace', f.slug)
    .send(body as object)

const body = (overrides: Record<string, unknown> = {}) => ({
  session_id: SESSION_ID,
  duration_ms: 184200,
  conversation_created: false,
  articles_read: ['a_123', 'a_456'],
  ...overrides,
})

describe('POST /sdk/sessions/end', () => {
  it('sets ended_at, marks it client-ended and appends one session_end event', async () => {
    const f = await fixture()
    const res = await post(f, body())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const sessions = await withWorkspace(f.workspaceId, async (tx) => tx.select().from(session))
    expect(sessions[0]!.endedAt).not.toBeNull()
    expect(sessions[0]!.endedBy).toBe('client')
    // started_at is never rewritten: the denominator counts by started_at.
    expect(sessions[0]!.startedAt.toISOString()).toBe(STARTED_AT.toISOString())

    const events = await withWorkspace(f.workspaceId, async (tx) =>
      tx.select().from(event).where(eq(event.type, 'session_end')),
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.sessionId).toBe(SESSION_ID)
    expect(events[0]!.actorType).toBe('player')
    expect(events[0]!.payload).toMatchObject({
      ended_by: 'client',
      duration_ms_reported: 184200,
      conversation_created_reported: false,
      articles_read_reported: ['a_123', 'a_456'],
    })
    expect(typeof events[0]!.payload.duration_ms_derived).toBe('number')
  })

  it('derives the duration from the timestamps rather than trusting the client', async () => {
    const f = await fixture()
    await post(f, body({ duration_ms: 1 })).expect(200)
    const events = await withWorkspace(f.workspaceId, async (tx) =>
      tx.select().from(event).where(eq(event.type, 'session_end')),
    )
    const derived = events[0]!.payload.duration_ms_derived as number
    expect(derived).toBeGreaterThan(1)
    expect(events[0]!.payload.duration_ms_reported).toBe(1)
  })

  it('is idempotent: a redelivered end does not move ended_at or append a second event', async () => {
    const f = await fixture()
    await post(f, body()).expect(200)
    const first = await withWorkspace(f.workspaceId, async (tx) => tx.select().from(session))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await post(f, body()).expect(200)

    const second = await withWorkspace(f.workspaceId, async (tx) => tx.select().from(session))
    expect(second[0]!.endedAt!.getTime()).toBe(first[0]!.endedAt!.getTime())
    const events = await withWorkspace(f.workspaceId, async (tx) =>
      tx.select().from(event).where(eq(event.type, 'session_end')),
    )
    expect(events).toHaveLength(1)
  })

  it('200s and writes nothing for a session that does not exist', async () => {
    const f = await fixture()
    await post(f, body({ session_id: '11111111-2222-3333-4444-555555555555' })).expect(200)
    const events = await withWorkspace(f.workspaceId, async (tx) => tx.select().from(event))
    expect(events).toHaveLength(0)
  })

  it('200s and writes nothing for another workspace session', async () => {
    const victim = await fixture('victim-game')
    const attacker = await seedWorkspace({ slug: 'attacker-game' })
    const attackerPlayer = await seedPlayer(attacker, 'UserId7661')
    const token = await mintToken({
      workspace_id: attacker,
      player_id: attackerPlayer,
      external_player_id: 'UserId7661',
    })

    await post({ token, slug: 'attacker-game' }, body()).expect(200)

    const victimSessions = await withWorkspace(victim.workspaceId, async (tx) => tx.select().from(session))
    expect(victimSessions[0]!.endedAt).toBeNull()
    expect(victimSessions[0]!.endedBy).toBeNull()
  })

  it('accepts an end with every untrusted field absent or wrong-typed', async () => {
    const f = await fixture()
    await post(f, { session_id: SESSION_ID }).expect(200)
    const events = await withWorkspace(f.workspaceId, async (tx) =>
      tx.select().from(event).where(eq(event.type, 'session_end')),
    )
    expect(events[0]!.payload).toMatchObject({
      duration_ms_reported: null,
      conversation_created_reported: null,
      articles_read_reported: [],
    })
  })

  it('422s only when session_id is unusable', async () => {
    const f = await fixture()
    await post(f, body({ session_id: 'nope' })).expect(422)
    await post(f, {}).expect(422)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api test sdk.sessionsEnd`
Expected: FAIL — 404, route not mounted

- [ ] **Step 3: Write `backend/src/sdk/sessionsEnd.ts`**

```ts
import type { RequestHandler } from 'express'
import { and, eq, isNull } from 'drizzle-orm'
import { SessionEndBody } from '@support/types'
import { sendError } from '../errors.ts'
import { appendEvent } from '../events/appendEvent.ts'
import { session } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'
import { headerPayload } from './headers.ts'

/**
 * If this never arrives the session simply has no ended_at. Two mitigations exist and
 * both are needed: the session-timeout worker closes it as `timeout`, and self-serve
 * rate counts sessions by started_at, never by ended_at — a missing end must never
 * silently shrink the denominator.
 */
export const sessionsEnd: RequestHandler = async (req, res) => {
  const player = req.player!

  const parsed = SessionEndBody.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, 422, 'invalid_request', 'session_id must be a uuid.')
    return
  }

  const body = parsed.data
  const now = new Date()

  await withWorkspace(player.workspaceId, async (tx) => {
    // The predicate carries the whole guard: RLS scopes it to the workspace,
    // player_id scopes it to this player, and `ended_at IS NULL` makes a redelivery
    // a no-op instead of moving the timestamp. Zero rows back means there is nothing
    // to do — unknown session, someone else's session, or already ended.
    const [ended] = await tx
      .update(session)
      .set({ endedAt: now, endedBy: 'client' })
      .where(
        and(
          eq(session.id, body.session_id),
          eq(session.playerId, player.playerId),
          isNull(session.endedAt),
        ),
      )
      .returning({ id: session.id, startedAt: session.startedAt })

    if (!ended) return

    await appendEvent(tx, {
      workspaceId: player.workspaceId,
      type: 'session_end',
      sessionId: ended.id,
      actorId: player.playerId,
      actorType: 'player',
      occurredAt: now,
      payload: {
        ended_by: 'client',
        // Derived is what reporting reads.
        duration_ms_derived: now.getTime() - ended.startedAt.getTime(),
        // Reported is recorded for cross-checking a suspected bug, never aggregated.
        // articles_read is a client-side echo of the article_read events the web
        // surface writes; having both is how a silently dead bridge is detected.
        duration_ms_reported: body.duration_ms,
        conversation_created_reported: body.conversation_created,
        articles_read_reported: body.articles_read,
        ...headerPayload(player),
      },
    })
  })

  res.status(200).json({ ok: true })
}
```

- [ ] **Step 4: Mount it and run the test**

```ts
import { sessionsEnd } from './sessionsEnd.ts'
sdkRouter.post('/sessions/end', sessionsEnd)
```

Run: `pnpm --filter @support/api test sdk.sessionsEnd`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/sdk/sessionsEnd.ts backend/src/sdk/router.ts backend/tests/sdk.sessionsEnd.test.ts
git commit -m "feat(sdk): POST /sdk/sessions/end, derived duration beside the reported one"
```

---

### Task 11: `POST /sdk/incidents`

**Files:**
- Create: `backend/src/sdk/incidents.ts`
- Modify: `backend/src/sdk/router.ts`
- Test: `backend/tests/sdk.incidents.test.ts`

**Interfaces:**
- Consumes: `IncidentBody` (`@support/types`); `withWorkspace`; `appendEvent`; `headerPayload`; table `session`.
- Produces: `incidents: RequestHandler`. Response body: `{ "ok": true }`. Writes one `sdk_incident` row to `event` with `actor_type = 'system'` — no dedicated table, because volume is low and it inherits workspace scoping, the BRIN index and append-only enforcement for free.

**Always `200` if the body parses.** An incident report that itself errors is worse than useless. There is no validation failure this endpoint can have except an unparseable body, which `express.json` turns into `400` before the handler runs.

**And something must watch this stream.** A rising incident count is how you learn a release broke support entry for an entire platform; an unwatched incident stream is the silent failure it was built to prevent. This task adds the write path. Task 17 adds the query that makes it watchable and a note in the README that alerting is still owed.

- [ ] **Step 1: Write the failing test**

`backend/tests/sdk.incidents.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/db/client.ts'
import { withWorkspace } from '../src/db/withWorkspace.ts'
import { event } from '../src/db/schema/index.ts'
import { app, mintToken } from './helpers/app.ts'
import { closeOwnerPool, seedPlayer, seedSession, seedWorkspace, truncateAll } from './helpers/db.ts'

const SESSION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function fixture(slug = 'demo-game') {
  const workspaceId = await seedWorkspace({ slug })
  const playerId = await seedPlayer(workspaceId, 'UserId7661')
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'UserId7661',
  })
  return { workspaceId, playerId, token, slug }
}

const post = (f: { token: string; slug: string }, body: unknown) =>
  request(app)
    .post('/sdk/incidents')
    .set('Authorization', `Bearer ${f.token}`)
    .set('X-Support-Workspace', f.slug)
    .set('X-Support-Sdk', '1.0.2')
    .send(body as object)

const events = (workspaceId: string) => withWorkspace(workspaceId, async (tx) => tx.select().from(event))

describe('POST /sdk/incidents', () => {
  it('appends one system-actor sdk_incident with the reported detail', async () => {
    const f = await fixture()
    await seedSession({ workspaceId: f.workspaceId, playerId: f.playerId, id: SESSION_ID })

    const res = await post(f, {
      incident_id: 'c7a2ffff-4f89-11d3-9a0c-0305e82c3301',
      session_id: SESSION_ID,
      kind: 'token_timeout',
      detail: '5s elapsed, no response',
      sdk_version: '1.0.2',
      client_version: '6.2.01',
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const rows = await events(f.workspaceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('sdk_incident')
    expect(rows[0]!.actorType).toBe('system')
    expect(rows[0]!.actorId).toBeNull()
    expect(rows[0]!.sessionId).toBe(SESSION_ID)
    expect(rows[0]!.payload).toMatchObject({
      kind: 'token_timeout',
      detail: '5s elapsed, no response',
      sdk_version: '1.0.2',
      client_version: '6.2.01',
      incident_id: 'c7a2ffff-4f89-11d3-9a0c-0305e82c3301',
    })
  })

  it('accepts a null session_id — the SDK may fail before a session exists', async () => {
    const f = await fixture()
    await post(f, { session_id: null, kind: 'webview_init_failed' }).expect(200)
    const rows = await events(f.workspaceId)
    expect(rows[0]!.sessionId).toBeNull()
    expect(rows[0]!.payload).toMatchObject({ kind: 'webview_init_failed' })
  })

  it('accepts an unknown kind and an absent everything-else', async () => {
    const f = await fixture()
    await post(f, { kind: 'something_the_server_has_never_heard_of' }).expect(200)
    await post(f, {}).expect(200)
    const rows = await events(f.workspaceId)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.payload.kind)).toContain('unknown')
  })

  it('does not point at a session it cannot see — FK checks bypass RLS', async () => {
    const victim = await fixture('victim-game')
    await seedSession({ workspaceId: victim.workspaceId, playerId: victim.playerId, id: SESSION_ID })

    const attacker = await fixture('attacker-game')
    await post(attacker, { session_id: SESSION_ID, kind: 'token_timeout' }).expect(200)

    const rows = await events(attacker.workspaceId)
    expect(rows).toHaveLength(1)
    // The column is null; the claimed id survives in the payload for triage.
    expect(rows[0]!.sessionId).toBeNull()
    expect(rows[0]!.payload).toMatchObject({ unresolved_session_id: SESSION_ID })
  })

  it('does not point at another player session in the same workspace', async () => {
    const f = await fixture()
    const other = await seedPlayer(f.workspaceId, 'SomeoneElse')
    await seedSession({ workspaceId: f.workspaceId, playerId: other, id: SESSION_ID })
    await post(f, { session_id: SESSION_ID, kind: 'token_timeout' }).expect(200)
    const rows = await events(f.workspaceId)
    expect(rows[0]!.sessionId).toBeNull()
  })

  it('truncates an abusive detail rather than rejecting the report', async () => {
    const f = await fixture()
    await post(f, { kind: 'stack_overflow', detail: 'x'.repeat(50_000) }).expect(200)
    const rows = await events(f.workspaceId)
    expect((rows[0]!.payload.detail as string).length).toBeLessThanOrEqual(2000)
  })

  it('400s on an unparseable body — the only 4xx it has', async () => {
    const f = await fixture()
    await request(app)
      .post('/sdk/incidents')
      .set('Authorization', `Bearer ${f.token}`)
      .set('X-Support-Workspace', f.slug)
      .set('Content-Type', 'application/json')
      .send('{ not json')
      .expect(400)
  })

  it('401s without a token', async () => {
    await request(app).post('/sdk/incidents').send({ kind: 'token_timeout' }).expect(401)
  })
})
```

Note the last test: an incident report still needs a valid token. The SDK queues incidents through the Outbox, so a token failure at `Open()` time is reported on a later drain once a token exists — which is why `POST /sdk/incidents` sits behind the same middleware as the rest.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api test sdk.incidents`
Expected: FAIL — 404, route not mounted

- [ ] **Step 3: Write `backend/src/sdk/incidents.ts`**

```ts
import type { RequestHandler } from 'express'
import { and, eq } from 'drizzle-orm'
import { IncidentBody } from '@support/types'
import { appendEvent } from '../events/appendEvent.ts'
import { session } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'
import { headerPayload } from './headers.ts'

/**
 * Always 200 if the body parses. An incident report that itself errors is worse than
 * useless, so every field has a fallback and none of them can fail the request.
 *
 * Lands in `event` rather than a table of its own: volume is low, and it inherits
 * workspace scoping, the BRIN index and append-only enforcement for free.
 */
export const incidents: RequestHandler = async (req, res) => {
  const player = req.player!

  // .catch() on every field means this cannot fail for a body that parsed as JSON.
  const body = IncidentBody.parse(req.body ?? {})

  await withWorkspace(player.workspaceId, async (tx) => {
    // A foreign-key check runs as the referenced table's owner and ignores RLS, so an
    // unverified session_id would be accepted and would point across the tenant
    // boundary. Confirm it is this player's, or keep it in the payload only.
    let sessionId: string | null = null
    if (body.session_id) {
      const [owned] = await tx
        .select({ id: session.id })
        .from(session)
        .where(and(eq(session.id, body.session_id), eq(session.playerId, player.playerId)))
        .limit(1)
      sessionId = owned?.id ?? null
    }

    await appendEvent(tx, {
      workspaceId: player.workspaceId,
      type: 'sdk_incident',
      sessionId,
      actorType: 'system',
      payload: {
        kind: body.kind,
        detail: body.detail,
        sdk_version: body.sdk_version,
        client_version: body.client_version,
        incident_id: body.incident_id,
        ...(body.session_id && !sessionId ? { unresolved_session_id: body.session_id } : {}),
        ...headerPayload(player),
      },
    })
  })

  res.status(200).json({ ok: true })
}
```

- [ ] **Step 4: Mount it and run the test**

```ts
import { incidents } from './incidents.ts'
sdkRouter.post('/incidents', incidents)
```

Run: `pnpm --filter @support/api test sdk.incidents`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/sdk/incidents.ts backend/src/sdk/router.ts backend/tests/sdk.incidents.test.ts
git commit -m "feat(sdk): POST /sdk/incidents, always 200, never a cross-tenant FK"
```

---

### Task 12: `GET /sdk/unread`

**Files:**
- Create: `backend/src/sdk/unread.ts`
- Modify: `backend/src/sdk/router.ts`
- Test: `backend/tests/sdk.unread.test.ts`

**Interfaces:**
- Consumes: `UnreadResponse` (`@support/types`); `withWorkspace`; tables `message`, `conversation`.
- Produces: `unread: RequestHandler`. Response body: `{ "unread_count": number }`.

Derived, never stored. The count is exactly the spec's query: public messages, in this player's conversations, not authored by the player, not yet `read`. **Push is best effort; this is the guaranteed path** — no requirement may depend on push alone, which is why a poll exists at all.

- [ ] **Step 1: Write the failing test**

`backend/tests/sdk.unread.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/db/client.ts'
import { app, mintToken } from './helpers/app.ts'
import {
  closeOwnerPool,
  seedConversation,
  seedMessage,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function fixture(slug = 'demo-game') {
  const workspaceId = await seedWorkspace({ slug })
  const playerId = await seedPlayer(workspaceId, 'UserId7661')
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'UserId7661',
  })
  return { workspaceId, playerId, token, slug }
}

const get = (f: { token: string; slug: string }) =>
  request(app).get('/sdk/unread').set('Authorization', `Bearer ${f.token}`).set('X-Support-Workspace', f.slug)

describe('GET /sdk/unread', () => {
  it('returns zero when the player has no conversations', async () => {
    const f = await fixture()
    const res = await get(f)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ unread_count: 0 })
  })

  it('counts public non-player messages that are not yet read', async () => {
    const f = await fixture()
    const conversationId = await seedConversation({ workspaceId: f.workspaceId, playerId: f.playerId })
    await seedMessage({ workspaceId: f.workspaceId, conversationId, seq: 1, authorType: 'agent', deliveryState: 'sent' })
    await seedMessage({ workspaceId: f.workspaceId, conversationId, seq: 2, authorType: 'bot', deliveryState: 'delivered' })

    const res = await get(f)
    expect(res.body).toEqual({ unread_count: 2 })
  })

  it('excludes the player own messages, read messages and internal notes', async () => {
    const f = await fixture()
    const conversationId = await seedConversation({ workspaceId: f.workspaceId, playerId: f.playerId })
    await seedMessage({ workspaceId: f.workspaceId, conversationId, seq: 1, authorType: 'player', deliveryState: 'sent' })
    await seedMessage({ workspaceId: f.workspaceId, conversationId, seq: 2, authorType: 'agent', deliveryState: 'read' })
    await seedMessage({
      workspaceId: f.workspaceId,
      conversationId,
      seq: 3,
      authorType: 'agent',
      visibility: 'internal',
      deliveryState: 'sent',
    })
    await seedMessage({ workspaceId: f.workspaceId, conversationId, seq: 4, authorType: 'system', deliveryState: 'sent' })

    const res = await get(f)
    // Only the system message counts: player-authored, read and internal are all out.
    expect(res.body).toEqual({ unread_count: 1 })
  })

  it('never counts another player messages, even in the same workspace', async () => {
    const f = await fixture()
    const other = await seedPlayer(f.workspaceId, 'SomeoneElse')
    const theirs = await seedConversation({ workspaceId: f.workspaceId, playerId: other })
    await seedMessage({ workspaceId: f.workspaceId, conversationId: theirs, seq: 1, authorType: 'agent' })

    const res = await get(f)
    expect(res.body).toEqual({ unread_count: 0 })
  })

  it('never counts another workspace messages', async () => {
    const a = await fixture('game-a')
    const b = await fixture('game-b')
    const theirs = await seedConversation({ workspaceId: b.workspaceId, playerId: b.playerId })
    await seedMessage({ workspaceId: b.workspaceId, conversationId: theirs, seq: 1, authorType: 'agent' })

    expect((await get(a)).body).toEqual({ unread_count: 0 })
    expect((await get(b)).body).toEqual({ unread_count: 1 })
  })

  it('counts across several conversations', async () => {
    const f = await fixture()
    for (const seq of [1, 2]) {
      const conversationId = await seedConversation({ workspaceId: f.workspaceId, playerId: f.playerId })
      await seedMessage({ workspaceId: f.workspaceId, conversationId, seq, authorType: 'agent' })
    }
    expect((await get(f)).body).toEqual({ unread_count: 2 })
  })

  it('401s without a token and 403s on a workspace mismatch', async () => {
    const f = await fixture()
    await seedWorkspace({ slug: 'other-game' })
    await request(app).get('/sdk/unread').expect(401)
    await request(app)
      .get('/sdk/unread')
      .set('Authorization', `Bearer ${f.token}`)
      .set('X-Support-Workspace', 'other-game')
      .expect(403)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api test sdk.unread`
Expected: FAIL — 404, route not mounted

- [ ] **Step 3: Write `backend/src/sdk/unread.ts`**

```ts
import type { RequestHandler } from 'express'
import { and, eq, ne, sql } from 'drizzle-orm'
import type { UnreadResponse } from '@support/types'
import { conversation, message } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'

/**
 * Derived, never stored. Polled coarsely by the SDK — on foreground/resume only,
 * never per frame.
 *
 * Push is best effort; this is the guaranteed path. No requirement may depend on
 * push alone, which is why the poll exists at all.
 */
export const unread: RequestHandler = async (req, res) => {
  const player = req.player!

  const count = await withWorkspace(player.workspaceId, async (tx) => {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(message)
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .where(
        and(
          eq(conversation.playerId, player.playerId),
          eq(message.visibility, 'public'),
          ne(message.authorType, 'player'),
          ne(message.deliveryState, 'read'),
        ),
      )
    return row?.count ?? 0
  })

  const payload: UnreadResponse = { unread_count: count }
  res.status(200).json(payload)
}
```

`visibility = 'public'` here is belt-and-braces, not the enforcement. Internal notes are kept from players by the two serializers and the separate socket rooms that arrive with the chat slice; this endpoint returns a number, so there is nothing to serialize — but an internal note must not even move the counter, or a player learns that *something* was written.

- [ ] **Step 4: Mount it and run the test**

```ts
import { unread } from './unread.ts'
sdkRouter.get('/unread', unread)
```

Then delete the temporary `GET /_whoami` route from `src/sdk/router.ts` and the `/sdk/_whoami` references in `tests/auth.middleware.test.ts` — point those tests at `GET /sdk/unread` instead, asserting `200` where they asserted `200` and the same `401`/`403` codes. The `resolves the player from the token` test needs the introspection route, so keep `_whoami` mounted **only** when `getEnv().NODE_ENV === 'test'`:

```ts
if (getEnv().NODE_ENV === 'test') {
  sdkRouter.get('/_whoami', (req, res) => {
    res.json(req.player)
  })
}
```

Run: `pnpm --filter @support/api test`
Expected: PASS — the whole backend suite, ~85 tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/sdk/unread.ts backend/src/sdk/router.ts backend/tests/sdk.unread.test.ts \
        backend/tests/auth.middleware.test.ts
git commit -m "feat(sdk): GET /sdk/unread, derived from messages and scoped to the player"
```

---

### Task 13: The session-timeout worker

**Files:**
- Create: `backend/src/jobs/sessionTimeout.ts`, `backend/src/jobs/queue.ts`
- Modify: `backend/src/server.ts`
- Test: `backend/tests/jobs.sessionTimeout.test.ts`

**Interfaces:**
- Consumes: `withWorkspace`, `withoutWorkspace`; `appendEvent`; tables `workspace`, `session`; `getEnv()`.
- Produces:
  - `closeStaleSessions(options?: { now?: Date; timeoutMinutes?: number }): Promise<number>` from `src/jobs/sessionTimeout.ts` — pure enough to test directly, returns the number of sessions closed.
  - `registerJobs(): Promise<{ close: () => Promise<void> }>` from `src/jobs/queue.ts`.

**Why this exists.** *"If `sessions/end` never arrives, the session has no `ended_at`."* This worker is the first of the two mitigations the wire contract requires. The second — counting the self-serve denominator by `started_at` — is a reporting rule and is already recorded in the Global Constraints; nothing in this slice may count by `ended_at`.

**Two traps:**

1. **The worker must respect RLS, not bypass it.** It runs across all workspaces, so it loops: read the workspace list through `withoutWorkspace` (that table is unscoped), then open one `withWorkspace` transaction per workspace. Granting the app role `BYPASSRLS` for the convenience of one job would put a hole in the only mechanism protecting the highest-risk requirement in the build.
2. **This is not the inactivity clock and not auto-close.** Those two are sequential clocks operating on `resolution_cycle`, they ship with the conversation slice, and confusing them with this one produces a worker that resolves tickets. This job closes *sessions* — the self-serve denominator — and touches nothing else.

- [ ] **Step 1: Write the failing test**

`backend/tests/jobs.sessionTimeout.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeDb } from '../src/db/client.ts'
import { withWorkspace } from '../src/db/withWorkspace.ts'
import { event, session } from '../src/db/schema/index.ts'
import { closeStaleSessions } from '../src/jobs/sessionTimeout.ts'
import { closeOwnerPool, seedPlayer, seedSession, seedWorkspace, truncateAll } from './helpers/db.ts'

const NOW = new Date('2026-08-04T12:00:00Z')
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

describe('closeStaleSessions', () => {
  it('closes a session older than the timeout and marks it ended_by timeout', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId7661')
    const stale = await seedSession({ workspaceId, playerId, startedAt: minutesAgo(45) })

    const closed = await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })
    expect(closed).toBe(1)

    const rows = await withWorkspace(workspaceId, async (tx) =>
      tx.select().from(session).where(eq(session.id, stale)),
    )
    expect(rows[0]!.endedAt!.toISOString()).toBe(NOW.toISOString())
    expect(rows[0]!.endedBy).toBe('timeout')
  })

  it('appends one session_end event with a system actor and the derived duration', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId7661')
    await seedSession({ workspaceId, playerId, startedAt: minutesAgo(45) })

    await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })

    const events = await withWorkspace(workspaceId, async (tx) =>
      tx.select().from(event).where(eq(event.type, 'session_end')),
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.actorType).toBe('system')
    expect(events[0]!.actorId).toBeNull()
    expect(events[0]!.payload).toMatchObject({ ended_by: 'timeout', duration_ms_derived: 45 * 60_000 })
  })

  it('leaves a recent session alone', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId7661')
    await seedSession({ workspaceId, playerId, startedAt: minutesAgo(10) })

    expect(await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })).toBe(0)
    const rows = await withWorkspace(workspaceId, async (tx) => tx.select().from(session))
    expect(rows[0]!.endedAt).toBeNull()
  })

  it('leaves an already-ended session alone and does not double-append', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId7661')
    await seedSession({
      workspaceId,
      playerId,
      startedAt: minutesAgo(45),
      endedAt: minutesAgo(40),
    })

    expect(await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })).toBe(0)
    const events = await withWorkspace(workspaceId, async (tx) => tx.select().from(event))
    expect(events).toHaveLength(0)
  })

  it('is idempotent across runs', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId7661')
    await seedSession({ workspaceId, playerId, startedAt: minutesAgo(45) })

    expect(await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })).toBe(1)
    expect(await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })).toBe(0)
    const events = await withWorkspace(workspaceId, async (tx) => tx.select().from(event))
    expect(events).toHaveLength(1)
  })

  it('sweeps every workspace, each in its own tenant scope', async () => {
    const ids: string[] = []
    for (const slug of ['game-a', 'game-b', 'game-c']) {
      const workspaceId = await seedWorkspace({ slug })
      const playerId = await seedPlayer(workspaceId, 'UserId7661')
      await seedSession({ workspaceId, playerId, startedAt: minutesAgo(45) })
      ids.push(workspaceId)
    }

    expect(await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })).toBe(3)
    for (const workspaceId of ids) {
      const events = await withWorkspace(workspaceId, async (tx) => tx.select().from(event))
      expect(events, workspaceId).toHaveLength(1)
      expect(events[0]!.workspaceId).toBe(workspaceId)
    }
  })

  it('skips a disabled workspace', async () => {
    const workspaceId = await seedWorkspace({ slug: 'retired', disabledAt: new Date('2026-07-01T00:00:00Z') })
    const playerId = await seedPlayer(workspaceId, 'UserId7661')
    await seedSession({ workspaceId, playerId, startedAt: minutesAgo(45) })

    expect(await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })).toBe(0)
  })

  it('closes many stale sessions in one pass', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId7661')
    for (let i = 0; i < 5; i += 1) {
      await seedSession({ workspaceId, playerId, startedAt: minutesAgo(31 + i) })
    }
    expect(await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })).toBe(5)
    const events = await withWorkspace(workspaceId, async (tx) => tx.select().from(event))
    expect(events).toHaveLength(5)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api test jobs.sessionTimeout`
Expected: FAIL — `Cannot find module '../src/jobs/sessionTimeout.ts'`

- [ ] **Step 3: Write `backend/src/jobs/sessionTimeout.ts`**

```ts
import { and, isNull, lt } from 'drizzle-orm'
import { getEnv } from '../env.ts'
import { appendEvent } from '../events/appendEvent.ts'
import { session, workspace } from '../db/schema/index.ts'
import { withWorkspace, withoutWorkspace } from '../db/withWorkspace.ts'

export type CloseStaleSessionsOptions = {
  now?: Date
  timeoutMinutes?: number
}

/**
 * Closes sessions with no ended_at older than the timeout, marking them
 * ended_by = 'timeout'. The first of the two mitigations the wire contract requires
 * for a `sessions/end` that never arrives; the second is that self-serve rate counts
 * by started_at, so an unclosed session still appears in the denominator.
 *
 * This is NOT the inactivity clock and NOT auto-close. Those operate on
 * resolution_cycle and ship with the conversation slice.
 *
 * It sweeps every workspace by looping one tenant-scoped transaction per workspace
 * rather than by bypassing RLS. Granting BYPASSRLS for the convenience of a job
 * would put a hole in the mechanism protecting the highest-risk requirement here.
 */
export async function closeStaleSessions(options: CloseStaleSessionsOptions = {}): Promise<number> {
  const now = options.now ?? new Date()
  const timeoutMinutes = options.timeoutMinutes ?? getEnv().SESSION_TIMEOUT_MINUTES
  const cutoff = new Date(now.getTime() - timeoutMinutes * 60_000)

  const workspaces = await withoutWorkspace(async (tx) =>
    tx.select({ id: workspace.id }).from(workspace).where(isNull(workspace.disabledAt)),
  )

  let closed = 0
  for (const ws of workspaces) {
    closed += await withWorkspace(ws.id, async (tx) => {
      const ended = await tx
        .update(session)
        .set({ endedAt: now, endedBy: 'timeout' })
        .where(and(isNull(session.endedAt), lt(session.startedAt, cutoff)))
        .returning({ id: session.id, playerId: session.playerId, startedAt: session.startedAt })

      for (const row of ended) {
        await appendEvent(tx, {
          workspaceId: ws.id,
          type: 'session_end',
          sessionId: row.id,
          actorType: 'system',
          occurredAt: now,
          payload: {
            ended_by: 'timeout',
            duration_ms_derived: now.getTime() - row.startedAt.getTime(),
            timeout_minutes: timeoutMinutes,
          },
        })
      }
      return ended.length
    })
  }

  return closed
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @support/api test jobs.sessionTimeout`
Expected: PASS — 8 tests

- [ ] **Step 5: Write `backend/src/jobs/queue.ts`**

```ts
import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'
import { getEnv } from '../env.ts'
import { closeStaleSessions } from './sessionTimeout.ts'

const QUEUE_NAME = 'support-jobs'
const SESSION_TIMEOUT_JOB = 'session-timeout'

/**
 * BullMQ requires maxRetriesPerRequest: null on the connection a Worker uses.
 */
function connection(): IORedis {
  return new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null })
}

/**
 * One repeatable job every five minutes. A stable jobId means restarting the process
 * re-uses the same schedule rather than stacking a second one.
 */
export async function registerJobs(): Promise<{ close: () => Promise<void> }> {
  const queueConnection = connection()
  const workerConnection = connection()

  const queue = new Queue(QUEUE_NAME, { connection: queueConnection })
  await queue.upsertJobScheduler(
    SESSION_TIMEOUT_JOB,
    { pattern: '*/5 * * * *' },
    { name: SESSION_TIMEOUT_JOB, opts: { removeOnComplete: 50, removeOnFail: 100 } },
  )

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name !== SESSION_TIMEOUT_JOB) return
      const closed = await closeStaleSessions()
      if (closed > 0) console.log(`[jobs] closed ${closed} stale session(s)`)
    },
    { connection: workerConnection, concurrency: 1 },
  )

  worker.on('failed', (job, error) => {
    // Failure is never silent. Until real alerting exists, this log is the alert.
    console.error(`[jobs] ${job?.name ?? 'unknown'} failed:`, error)
  })

  return {
    close: async () => {
      await worker.close()
      await queue.close()
      queueConnection.disconnect()
      workerConnection.disconnect()
    },
  }
}
```

If `upsertJobScheduler` is absent in the installed BullMQ, use `queue.add(SESSION_TIMEOUT_JOB, {}, { repeat: { pattern: '*/5 * * * *' }, jobId: SESSION_TIMEOUT_JOB })` instead — the older repeatable-job API with the same semantics. Check `node_modules/bullmq/dist/esm/classes/queue.d.ts` rather than guessing.

Wire it into `src/server.ts`:

```ts
import 'dotenv/config'
import { createApp } from './app.ts'
import { getEnv } from './env.ts'
import { registerJobs } from './jobs/queue.ts'

const port = getEnv().PORT
const server = createApp().listen(port, () => {
  console.log(`api listening on http://localhost:${port}`)
})

const jobs = await registerJobs()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      await jobs.close()
      server.close(() => process.exit(0))
    })()
  })
}
```

- [ ] **Step 6: Verify the schedule by hand**

The BullMQ wiring is deliberately not unit-tested: a test that asserts a cron pattern round-trips through Redis tests BullMQ, not this code, and it makes the suite need a second service. Verify it once, directly:

```bash
pnpm --filter @support/api dev
# In another shell, confirm the scheduler exists:
docker compose exec redis redis-cli --scan --pattern 'bull:support-jobs:*'
```

Expected: keys including `bull:support-jobs:repeat:session-timeout` (or `:scheduler:` on newer BullMQ). Then force a run without waiting five minutes:

```bash
docker compose exec postgres psql -U support_owner -d support \
  -c "update session set started_at = now() - interval '2 hours' where ended_at is null;"
node --experimental-strip-types -e "
  import('./backend/src/jobs/sessionTimeout.ts').then(async (m) => {
    console.log('closed', await m.closeStaleSessions())
    process.exit(0)
  })"
```

Expected: `closed 1` (or however many were open), and `select ended_by from session` shows `timeout`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/jobs backend/src/server.ts backend/tests/jobs.sessionTimeout.test.ts
git commit -m "feat(jobs): close stale sessions at 30 minutes, one tenant scope at a time"
```

---

### Task 14: The web-surface endpoints — `/surface/bootstrap` and `/surface/events/article_read`

**Files:**
- Create: `backend/src/surface/bootstrap.ts`, `backend/src/surface/articleRead.ts`, `backend/src/surface/router.ts`
- Modify: `backend/src/app.ts` (mount `/surface`)
- Test: `backend/tests/surface.test.ts`

**Interfaces:**
- Consumes: `BootstrapQuery`, `ArticleReadBody`, `type BootstrapResponse`, `type PlayerStateAvailability` (`@support/types`); `requirePlayerToken` **without** `requireSdkHeaders`; `withWorkspace`; `appendEvent`; tables `session`, `player`, `playerStateSnapshot`, `conversation`, `message`.
- Produces: `surfaceRouter`, mounted at `/surface`.

**These two are not part of the frozen contract.** The web surface ships with the server, so its endpoints change together. They are also the reason `requirePlayerToken` and `requireSdkHeaders` are separate middlewares: a browser page has no reason to know the workspace slug, so it sends the token and nothing else.

**Why `article_read` lives here.** *"`article_read` events are emitted by the web surface, not the SDK."* The player browses articles inside the webview, so the web app writes one event per article opened. The SDK's `articles_read` array is a client-side echo of the same thing, and reporting reads the events — never the array, because the array only arrives if `sessions/end` arrives.

`still_need_help_reached`, the funnel's third step, ships with the real article-list UI in the step-5 slice. The stub has no article list to reach the bottom of.

- [ ] **Step 1: Write the failing test**

`backend/tests/surface.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { eq } from 'drizzle-orm'
import { closeDb } from '../src/db/client.ts'
import { withWorkspace } from '../src/db/withWorkspace.ts'
import { event } from '../src/db/schema/index.ts'
import { app, mintToken } from './helpers/app.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedMessage,
  seedPlayer,
  seedSession,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

const SESSION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const STARTED_AT = new Date('2026-08-04T09:12:00Z')

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function fixture(slug = 'demo-game') {
  const workspaceId = await seedWorkspace({ slug })
  const playerId = await seedPlayer(workspaceId, 'UserId7661')
  await seedSession({ workspaceId, playerId, id: SESSION_ID, startedAt: STARTED_AT })
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'UserId7661',
  })
  return { workspaceId, playerId, token }
}

async function insertSnapshot(args: {
  workspaceId: string
  sessionId?: string
  declared?: Record<string, unknown>
  raw?: Record<string, unknown>
  isMissing?: boolean
  degradedReason?: string | null
}) {
  await ownerPool.query(
    `insert into player_state_snapshot
       (workspace_id, session_id, declared, raw, is_missing, degraded_reason, captured_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      args.workspaceId,
      args.sessionId ?? SESSION_ID,
      JSON.stringify(args.declared ?? {}),
      JSON.stringify(args.raw ?? {}),
      args.isMissing ?? false,
      args.degradedReason ?? null,
      STARTED_AT,
    ],
  )
}

const bootstrap = (token: string, sessionId = SESSION_ID) =>
  request(app).get('/surface/bootstrap').query({ session_id: sessionId }).set('Authorization', `Bearer ${token}`)

describe('GET /surface/bootstrap', () => {
  it('returns the session, the player and the declared state', async () => {
    const f = await fixture()
    await insertSnapshot({
      workspaceId: f.workspaceId,
      declared: { platform: 'ios', player_level: 34 },
      raw: { ab_bucket: 'B' },
    })

    const res = await bootstrap(f.token)
    expect(res.status).toBe(200)
    expect(res.body.session).toMatchObject({ id: SESSION_ID, entry_point: 'settings_menu', ended_at: null })
    expect(res.body.session.started_at).toBe(STARTED_AT.toISOString())
    expect(res.body.player).toEqual({ external_player_id: 'UserId7661' })
    expect(res.body.player_state.availability).toBe('ok')
    expect(res.body.player_state.declared).toEqual({ platform: 'ios', player_level: 34 })
    expect(res.body.player_state.captured_at).toBe(STARTED_AT.toISOString())
    expect(res.body.unread_count).toBe(0)
  })

  it('distinguishes the three no-data states', async () => {
    const absent = await fixture('absent-game')
    expect((await bootstrap(absent.token)).body.player_state).toMatchObject({
      availability: 'absent',
      captured_at: null,
      declared: {},
    })

    await truncateAll()
    const missing = await fixture('missing-game')
    await insertSnapshot({ workspaceId: missing.workspaceId, isMissing: true })
    expect((await bootstrap(missing.token)).body.player_state.availability).toBe('missing')

    await truncateAll()
    const degraded = await fixture('degraded-game')
    await insertSnapshot({
      workspaceId: degraded.workspaceId,
      declared: { platform: 'ios' },
      degradedReason: 'total_spend threw',
    })
    const res = await bootstrap(degraded.token)
    expect(res.body.player_state.availability).toBe('degraded')
    expect(res.body.player_state.degraded_reason).toBe('total_spend threw')
  })

  it('reports the unread count alongside', async () => {
    const f = await fixture()
    const conversationId = await seedConversation({
      workspaceId: f.workspaceId,
      playerId: f.playerId,
      sessionId: SESSION_ID,
    })
    await seedMessage({ workspaceId: f.workspaceId, conversationId, seq: 1, authorType: 'agent' })
    expect((await bootstrap(f.token)).body.unread_count).toBe(1)
  })

  it('404s for another workspace session — invisible, so indistinguishable from absent', async () => {
    // victim-game owns SESSION_ID and has a snapshot on it.
    const victim = await fixture('victim-game')
    await insertSnapshot({ workspaceId: victim.workspaceId, declared: { platform: 'ios' } })

    const attackerWs = await seedWorkspace({ slug: 'attacker-game' })
    const attackerPlayer = await seedPlayer(attackerWs, 'UserId7661')
    const attackerToken = await mintToken({
      workspace_id: attackerWs,
      player_id: attackerPlayer,
      external_player_id: 'UserId7661',
    })

    const res = await bootstrap(attackerToken)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    // Nothing about the victim's session leaked into the response.
    expect(JSON.stringify(res.body)).not.toContain('ios')
    // And the victim can still read their own.
    expect((await bootstrap(victim.token)).status).toBe(200)
  })

  it('404s for another player session in the same workspace', async () => {
    const f = await fixture()
    const other = await seedPlayer(f.workspaceId, 'SomeoneElse')
    const otherToken = await mintToken({
      workspace_id: f.workspaceId,
      player_id: other,
      external_player_id: 'SomeoneElse',
    })
    await bootstrap(otherToken).expect(404)
  })

  it('404s for an unknown session and 422s for a malformed one', async () => {
    const f = await fixture()
    await bootstrap(f.token, '11111111-2222-3333-4444-555555555555').expect(404)
    await bootstrap(f.token, 'not-a-uuid').expect(422)
  })

  it('401s without a token and needs no workspace header', async () => {
    const f = await fixture()
    await request(app).get('/surface/bootstrap').query({ session_id: SESSION_ID }).expect(401)
    await bootstrap(f.token).expect(200)
  })
})

describe('POST /surface/events/article_read', () => {
  const read = (token: string, body: unknown) =>
    request(app).post('/surface/events/article_read').set('Authorization', `Bearer ${token}`).send(body as object)

  it('appends one article_read event against the session', async () => {
    const f = await fixture()
    await read(f.token, { session_id: SESSION_ID, article_id: 'a_123' }).expect(200)

    const events = await withWorkspace(f.workspaceId, async (tx) =>
      tx.select().from(event).where(eq(event.type, 'article_read')),
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.sessionId).toBe(SESSION_ID)
    expect(events[0]!.actorType).toBe('player')
    expect(events[0]!.actorId).toBe(f.playerId)
    expect(events[0]!.payload).toMatchObject({ article_id: 'a_123' })
  })

  it('records each read separately — articles read per session is a count', async () => {
    const f = await fixture()
    await read(f.token, { session_id: SESSION_ID, article_id: 'a_123' }).expect(200)
    await read(f.token, { session_id: SESSION_ID, article_id: 'a_456' }).expect(200)
    await read(f.token, { session_id: SESSION_ID, article_id: 'a_123' }).expect(200)

    const events = await withWorkspace(f.workspaceId, async (tx) =>
      tx.select().from(event).where(eq(event.type, 'article_read')),
    )
    expect(events).toHaveLength(3)
  })

  it('404s for a session that is not this player', async () => {
    const f = await fixture()
    const other = await seedPlayer(f.workspaceId, 'SomeoneElse')
    const otherToken = await mintToken({
      workspace_id: f.workspaceId,
      player_id: other,
      external_player_id: 'SomeoneElse',
    })
    await read(otherToken, { session_id: SESSION_ID, article_id: 'a_123' }).expect(404)
    const events = await withWorkspace(f.workspaceId, async (tx) => tx.select().from(event))
    expect(events).toHaveLength(0)
  })

  it('422s on a malformed body', async () => {
    const f = await fixture()
    await read(f.token, { session_id: SESSION_ID }).expect(422)
    await read(f.token, { session_id: 'nope', article_id: 'a_1' }).expect(422)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api test surface`
Expected: FAIL — 404, `/surface` is not mounted

- [ ] **Step 3: Write `backend/src/surface/bootstrap.ts`**

```ts
import type { RequestHandler } from 'express'
import { and, eq, ne, sql } from 'drizzle-orm'
import {
  BootstrapQuery,
  type BootstrapResponse,
  type PlayerStateAvailability,
} from '@support/types'
import { getEnv } from '../env.ts'
import { sendError } from '../errors.ts'
import { conversation, message, player, playerStateSnapshot, session } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'

/**
 * What the web surface calls first. Not part of the frozen contract — it ships with
 * the page that consumes it.
 */
export const bootstrap: RequestHandler = async (req, res) => {
  const ctx = req.player!

  const query = BootstrapQuery.safeParse(req.query)
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'session_id must be a uuid.')
    return
  }

  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    // RLS hides another workspace's row and the player_id predicate excludes another
    // player's, so a miss here cannot be distinguished from "never existed" — which
    // is exactly why the response is 404 rather than 403.
    const [found] = await tx
      .select({
        id: session.id,
        entryPoint: session.entryPoint,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        externalPlayerId: player.externalId,
      })
      .from(session)
      .innerJoin(player, eq(player.id, session.playerId))
      .where(and(eq(session.id, query.data.session_id), eq(session.playerId, ctx.playerId)))
      .limit(1)

    if (!found) return null

    const [snapshot] = await tx
      .select()
      .from(playerStateSnapshot)
      .where(eq(playerStateSnapshot.sessionId, found.id))
      .limit(1)

    const [unread] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(message)
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .where(
        and(
          eq(conversation.playerId, ctx.playerId),
          eq(message.visibility, 'public'),
          ne(message.authorType, 'player'),
          ne(message.deliveryState, 'read'),
        ),
      )

    return { found, snapshot, unreadCount: unread?.count ?? 0 }
  })

  if (!result) {
    sendError(res, 404, 'not_found', 'Session not found.')
    return
  }

  const { found, snapshot, unreadCount } = result

  // Three distinct no-data states, all rendered "unavailable" but diagnosed
  // differently. All three are states, never errors.
  const availability: PlayerStateAvailability = !snapshot
    ? 'absent'
    : snapshot.isMissing
      ? 'missing'
      : snapshot.degradedReason
        ? 'degraded'
        : 'ok'

  const payload: BootstrapResponse = {
    session: {
      id: found.id,
      entry_point: found.entryPoint,
      started_at: found.startedAt.toISOString(),
      ended_at: found.endedAt?.toISOString() ?? null,
    },
    player: { external_player_id: found.externalPlayerId },
    player_state: {
      availability,
      captured_at: snapshot?.capturedAt.toISOString() ?? null,
      degraded_reason: snapshot?.degradedReason ?? null,
      declared: snapshot?.declared ?? {},
      // `raw` is the player's own data, but it is also PII by default and the real
      // surface has no use for it — the agent Game View is what reads it. It is
      // exposed outside production only, because proving the split is the whole
      // point of the stub. Remove this branch when the real chat UI lands.
      ...(getEnv().NODE_ENV === 'production' ? {} : { raw: snapshot?.raw ?? {} }),
    },
    unread_count: unreadCount,
  }

  res.status(200).json(payload)
}
```

- [ ] **Step 4: Write `backend/src/surface/articleRead.ts`**

```ts
import type { RequestHandler } from 'express'
import { and, eq } from 'drizzle-orm'
import { ArticleReadBody } from '@support/types'
import { sendError } from '../errors.ts'
import { appendEvent } from '../events/appendEvent.ts'
import { session } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'

/**
 * The player browses articles inside the webview, so the web app writes one
 * article_read event per article opened, against the authenticated session.
 *
 * This is what p40's funnel counts and what "articles read per session" divides by.
 * It is NOT article_feedback: reading an article and answering "did this help?" are
 * separate signals, and that second one arrives with the article UI.
 *
 * No dedupe: three reads of the same article are three events. The funnel counts
 * distinct sessions and the average counts events; collapsing them here would lose
 * the second.
 */
export const articleRead: RequestHandler = async (req, res) => {
  const ctx = req.player!

  const body = ArticleReadBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'session_id must be a uuid and article_id must be present.')
    return
  }

  const wrote = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [owned] = await tx
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.id, body.data.session_id), eq(session.playerId, ctx.playerId)))
      .limit(1)

    if (!owned) return false

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'article_read',
      sessionId: owned.id,
      actorId: ctx.playerId,
      actorType: 'player',
      // Snapshotted, not a FK: the article table does not exist yet, and once it
      // does, an event must record what happened rather than point at live content.
      payload: { article_id: body.data.article_id },
    })
    return true
  })

  if (!wrote) {
    sendError(res, 404, 'not_found', 'Session not found.')
    return
  }

  res.status(200).json({ ok: true })
}
```

- [ ] **Step 5: Write `backend/src/surface/router.ts` and mount it**

```ts
import { Router } from 'express'
import { requirePlayerToken } from '../auth/requirePlayerToken.ts'
import { articleRead } from './articleRead.ts'
import { bootstrap } from './bootstrap.ts'

export const surfaceRouter = Router()

// requirePlayerToken only. A browser page has no reason to know the workspace slug,
// so requireSdkHeaders is deliberately absent here.
surfaceRouter.use(requirePlayerToken)

surfaceRouter.get('/bootstrap', bootstrap)
surfaceRouter.post('/events/article_read', articleRead)
```

In `src/app.ts`, beside the `/sdk` mount:

```ts
import { surfaceRouter } from './surface/router.ts'
app.use('/surface', surfaceRouter)
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @support/api test surface`
Expected: PASS — 11 tests

- [ ] **Step 7: Commit**

```bash
git add backend/src/surface backend/src/app.ts backend/tests/surface.test.ts
git commit -m "feat(surface): bootstrap and article_read for the web support surface"
```

---

### Task 15: The cross-workspace isolation sweep

**Files:**
- Test: `backend/tests/isolation.test.ts`

**Interfaces:**
- Consumes: everything built so far. No new source files — this task adds only a test.

The schema spec asks for this by name and calls it a day-one obligation: *"Authenticate as workspace A and hit every endpoint with workspace B's IDs. The expected result is `404`, not `403` — under RLS the rows are invisible, so the handler genuinely cannot distinguish 'not yours' from 'not there.' Assert this rather than discovering it."*

Two reconciliations this task has to make explicit, because the two rules look like they contradict each other:

- **`/sdk/*` endpoints return `200`, not `404`.** They are writes, and *"every `/sdk/*` endpoint returns `200` for anything recoverable."* So for those, the isolation assertion is **`200` plus zero rows written into either workspace** — the response tells an attacker nothing and the database is untouched.
- **`/surface/*` reads return `404`.** That is where the `404`-not-`403` rule applies.

The per-endpoint tests in Tasks 9–14 each cover their own cross-workspace case. This file exists anyway, in one place, because it is the test someone will look for when they need to prove tenancy holds — and because a new endpoint added later should fail here if its author forgot.

- [ ] **Step 1: Write the test**

`backend/tests/isolation.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/db/client.ts'
import { verifyPlayerToken } from '../src/auth/jwt.ts'
import { generateWorkspaceSecret, parseWorkspaceSecret } from '../src/auth/workspaceSecret.ts'
import { app, mintToken } from './helpers/app.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedMessage,
  seedPlayer,
  seedSession,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

const B_SESSION = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

type Tenant = { workspaceId: string; playerId: string; token: string; slug: string }

async function tenant(slug: string): Promise<Tenant> {
  const workspaceId = await seedWorkspace({ slug })
  const playerId = await seedPlayer(workspaceId, 'UserId7661')
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'UserId7661',
  })
  return { workspaceId, playerId, token, slug }
}

async function rowCounts(): Promise<Record<string, number>> {
  const tables = ['session', 'player_state_snapshot', 'event', 'conversation', 'message']
  const counts: Record<string, number> = {}
  for (const table of tables) {
    const { rows } = await ownerPool.query<{ n: number }>(`select count(*)::int as n from ${table}`)
    counts[table] = rows[0]!.n
  }
  return counts
}

let a: Tenant
let b: Tenant

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(async () => {
  await truncateAll()
  a = await tenant('game-a')
  b = await tenant('game-b')
  // Workspace B owns a session, a conversation and an unread agent message.
  await seedSession({ workspaceId: b.workspaceId, playerId: b.playerId, id: B_SESSION })
  const conversationId = await seedConversation({
    workspaceId: b.workspaceId,
    playerId: b.playerId,
    sessionId: B_SESSION,
  })
  await seedMessage({ workspaceId: b.workspaceId, conversationId, seq: 1, authorType: 'agent' })
})

const withA = (req: request.Test) =>
  req.set('Authorization', `Bearer ${a.token}`).set('X-Support-Workspace', a.slug)

describe('workspace A cannot reach workspace B', () => {
  it('POST /sdk/sessions/start with B session id writes nothing anywhere but an incident', async () => {
    const before = await rowCounts()
    await withA(request(app).post('/sdk/sessions/start'))
      .send({ session_id: B_SESSION, entry_point: 'settings_menu', snapshot: { platform: 'ios' } })
      .expect(200)
    const after = await rowCounts()

    expect(after.session).toBe(before.session)
    expect(after.player_state_snapshot).toBe(before.player_state_snapshot)
    // The only new row is A's own sdk_incident.
    expect(after.event).toBe(before.event + 1)
  })

  it('POST /sdk/sessions/end with B session id does not end it', async () => {
    await withA(request(app).post('/sdk/sessions/end')).send({ session_id: B_SESSION }).expect(200)
    const { rows } = await ownerPool.query<{ ended_at: Date | null }>(
      `select ended_at from session where id = $1`,
      [B_SESSION],
    )
    expect(rows[0]!.ended_at).toBeNull()
  })

  it('POST /sdk/incidents with B session id stores no cross-tenant foreign key', async () => {
    await withA(request(app).post('/sdk/incidents'))
      .send({ session_id: B_SESSION, kind: 'token_timeout' })
      .expect(200)
    const { rows } = await ownerPool.query<{ workspace_id: string; session_id: string | null }>(
      `select workspace_id, session_id from event where type = 'sdk_incident'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.workspace_id).toBe(a.workspaceId)
    expect(rows[0]!.session_id).toBeNull()
  })

  it('GET /sdk/unread never counts B messages', async () => {
    const res = await withA(request(app).get('/sdk/unread')).expect(200)
    expect(res.body).toEqual({ unread_count: 0 })
  })

  it('GET /surface/bootstrap on a B session is 404, not 403', async () => {
    const res = await request(app)
      .get('/surface/bootstrap')
      .query({ session_id: B_SESSION })
      .set('Authorization', `Bearer ${a.token}`)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  it('POST /surface/events/article_read on a B session is 404 and writes nothing', async () => {
    const before = await rowCounts()
    await request(app)
      .post('/surface/events/article_read')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ session_id: B_SESSION, article_id: 'a_123' })
      .expect(404)
    expect((await rowCounts()).event).toBe(before.event)
  })

  it('cannot mint a B token with A real secret', async () => {
    // Give both workspaces genuine secrets, then present A's against B's slug.
    const aSecret = generateWorkspaceSecret('game-a')
    const bSecret = generateWorkspaceSecret('game-b')
    await ownerPool.query(`update workspace set secret_hash = $2 where id = $1`, [
      a.workspaceId,
      aSecret.secretHash,
    ])
    await ownerPool.query(`update workspace set secret_hash = $2 where id = $1`, [
      b.workspaceId,
      bSecret.secretHash,
    ])

    // A's random half under B's slug: the slug resolves, the hash does not match.
    const { raw } = parseWorkspaceSecret(aSecret.secret)!
    await request(app)
      .post('/auth/player-token')
      .set('Authorization', `Bearer sk_game-b.${raw}`)
      .send({ external_player_id: 'UserId7661' })
      .expect(401)

    // A's own secret still works, so the 401 above was the cross-check and not a
    // broken fixture.
    const ok = await request(app)
      .post('/auth/player-token')
      .set('Authorization', `Bearer ${aSecret.secret}`)
      .send({ external_player_id: 'UserId7661' })
      .expect(200)
    const claims = await verifyPlayerToken(ok.body.token)
    expect(claims.workspace_id).toBe(a.workspaceId)
  })

  it('every attempt above leaves B session count at one', async () => {
    // Guards against a handler that writes into B while still returning the right
    // status. beforeEach seeds exactly one B session; nothing in this file may add
    // or remove one.
    const { rows } = await ownerPool.query<{ n: number }>(
      `select count(*)::int as n from session where workspace_id = $1`,
      [b.workspaceId],
    )
    expect(rows[0]!.n).toBe(1)
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @support/api test isolation`
Expected: PASS — 8 tests. If any of them fails, **stop and fix the handler** rather than the test. This is the highest-risk requirement in the build and the one place where a passing suite is worth more than a shipped feature.

- [ ] **Step 3: Run the whole suite**

Run: `pnpm --filter @support/api test`
Expected: PASS — ~112 tests across 11 files

- [ ] **Step 4: Commit**

```bash
git add backend/tests/isolation.test.ts
git commit -m "test: cross-workspace isolation sweep across every endpoint"
```

---

### Task 16: The web surface stub

**Files:**
- Create: `frontend/package.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/index.html`
- Create: `frontend/src/main.tsx`, `frontend/src/boot.ts`, `frontend/src/bridge.ts`, `frontend/src/api.ts`, `frontend/src/SupportSurface.tsx`, `frontend/src/styles.css`
- Test: `frontend/src/boot.test.ts`

**Interfaces:**
- Consumes: `type BootstrapResponse` from `@support/types`; the running API at `VITE_API_BASE_URL`.
- Produces: a page served at `http://localhost:5173/` that the SDK's `webviewBaseUrl` points at. It reads `?session=&entry=` and `#t=`, calls `GET /surface/bootstrap`, renders the player state, posts `article_read` and `close` over `window.SupportBridge`.

**This is deliberately ugly.** Its whole job is to prove the seam: token in the fragment, the right player's state on screen, and `close` ending the session. The real chat UI, the bot conversation, the article list and the forms all arrive in the step-5 slice. Do not start styling it.

Three things it must get right, because they are properties of the seam rather than of the UI:

1. **The token is read from the fragment and then scrubbed from the address bar.** Fragments stay out of access logs and `Referer` headers, but they persist in browser history and in whatever the player might screenshot. `history.replaceState` removes it immediately after reading.
2. **Missing state is stated plainly.** Never a blank panel, never an error page. Each of the four availability values gets its own sentence.
3. **`close` goes through the bridge, not through the API.** The SDK owns `POST /sdk/sessions/end` — the page's only job is to say the visit is over. In a desktop browser with no bridge, it logs instead of throwing.

- [ ] **Step 1: Write the manifests**

`frontend/package.json`:

```json
{
  "name": "@support/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@support/types": "workspace:*",
    "react": "^19",
    "react-dom": "^19"
  },
  "devDependencies": {
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitejs/plugin-react": "latest",
    "typescript": "^5",
    "vite": "latest",
    "vitest": "latest"
  }
}
```

`frontend/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"],
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src", "vite.config.ts"]
}
```

`frontend/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  test: { environment: 'node' },
})
```

`frontend/index.html`:

```html
<!doctype html>
<html lang="en-GB">
  <head>
    <meta charset="utf-8" />
    <!-- viewport-fit=cover so the page can use env(safe-area-inset-*); the SDK sets
         SetMargins(0,0,0,0) and safe areas are the page's job. -->
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Support</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Add `frontend/.env.example`:

```bash
VITE_API_BASE_URL=http://localhost:4000
```

- [ ] **Step 2: Write the failing test**

`frontend/src/boot.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { readBoot, scrubToken } from './boot.ts'

describe('readBoot', () => {
  it('reads the session and entry point from the query and the token from the fragment', () => {
    const boot = readBoot({ search: '?session=abc-123&entry=settings_menu', hash: '#t=jwt.value.here' })
    expect(boot).toEqual({ sessionId: 'abc-123', entryPoint: 'settings_menu', token: 'jwt.value.here' })
  })

  it('defaults a missing entry point rather than failing', () => {
    expect(readBoot({ search: '?session=abc-123', hash: '#t=jwt' })?.entryPoint).toBe('unknown')
  })

  it('returns null when the token or the session is absent', () => {
    expect(readBoot({ search: '?session=abc-123', hash: '' })).toBeNull()
    expect(readBoot({ search: '', hash: '#t=jwt' })).toBeNull()
    expect(readBoot({ search: '?session=', hash: '#t=jwt' })).toBeNull()
    expect(readBoot({ search: '?session=abc', hash: '#t=' })).toBeNull()
  })

  it('tolerates extra fragment and query parameters', () => {
    const boot = readBoot({ search: '?session=abc&entry=shop&lang=en', hash: '#t=jwt&debug=1' })
    expect(boot?.token).toBe('jwt')
    expect(boot?.entryPoint).toBe('shop')
  })
})

describe('scrubToken', () => {
  it('removes the fragment while keeping the path and query', () => {
    const replaceState = vi.fn()
    scrubToken(
      { replaceState } as unknown as History,
      { pathname: '/support', search: '?session=abc&entry=shop' } as unknown as Location,
    )
    expect(replaceState).toHaveBeenCalledWith(null, '', '/support?session=abc&entry=shop')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @support/web test`
Expected: FAIL — `Cannot find module './boot.ts'`

- [ ] **Step 4: Write `frontend/src/boot.ts`**

```ts
export type SurfaceBoot = {
  token: string
  sessionId: string
  entryPoint: string
}

/**
 * The SDK builds: {webviewBaseUrl}?session={sessionId}&entry={entryPoint}#t={jwt}
 *
 * Only the token goes in the fragment: fragments never reach the server in a request
 * line, stay out of proxy and access logs, and are not forwarded in a Referer.
 */
export function readBoot(location: { search: string; hash: string }): SurfaceBoot | null {
  const query = new URLSearchParams(location.search)
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''))

  const token = fragment.get('t')
  const sessionId = query.get('session')
  if (!token || !sessionId) return null

  return { token, sessionId, entryPoint: query.get('entry') || 'unknown' }
}

/**
 * Called immediately after readBoot. The fragment is out of server logs by
 * construction, but it stays in browser history and in anything the player
 * screenshots, so it should not outlive the read.
 */
export function scrubToken(history: History, location: Location): void {
  history.replaceState(null, '', `${location.pathname}${location.search}`)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @support/web test`
Expected: PASS — 5 tests

- [ ] **Step 6: Write `frontend/src/bridge.ts`**

```ts
export type BridgeMessage =
  | { type: 'conversation_created' }
  | { type: 'article_read'; id: string }
  | { type: 'close' }

declare global {
  interface Window {
    SupportBridge?: { post(message: unknown): void }
  }
}

/**
 * The SDK injects window.SupportBridge on load and fires `supportbridgeready`.
 * Unknown message types are ignored by the SDK, never errored, so the page can add
 * new ones without every shipped Unity build needing an update.
 *
 * In a plain desktop browser there is no bridge. That is a supported development
 * mode, not an error — log and carry on.
 */
export function post(message: BridgeMessage): void {
  const bridge = window.SupportBridge
  if (!bridge) {
    console.warn('[surface] no SupportBridge on this platform; would have posted', message)
    return
  }
  try {
    bridge.post(message)
  } catch (error) {
    console.error('[surface] bridge post failed', error)
  }
}

export function onBridgeReady(callback: () => void): () => void {
  if (window.SupportBridge) {
    callback()
    return () => {}
  }
  window.addEventListener('supportbridgeready', callback, { once: true })
  return () => window.removeEventListener('supportbridgeready', callback)
}
```

- [ ] **Step 7: Write `frontend/src/api.ts`**

```ts
import type { BootstrapResponse } from '@support/types'

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'

async function call<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? `Request failed with ${res.status}`)
  }
  return (await res.json()) as T
}

export function fetchBootstrap(token: string, sessionId: string): Promise<BootstrapResponse> {
  return call<BootstrapResponse>(`/surface/bootstrap?session_id=${encodeURIComponent(sessionId)}`, token)
}

export function reportArticleRead(token: string, sessionId: string, articleId: string): Promise<{ ok: true }> {
  return call<{ ok: true }>('/surface/events/article_read', token, {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, article_id: articleId }),
  })
}
```

- [ ] **Step 8: Write `frontend/src/SupportSurface.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import type { BootstrapResponse, PlayerStateAvailability } from '@support/types'
import { fetchBootstrap, reportArticleRead } from './api.ts'
import { readBoot, scrubToken, type SurfaceBoot } from './boot.ts'
import { post } from './bridge.ts'

/** British spelling throughout, per the spec's own copy. */
const AVAILABILITY_COPY: Record<PlayerStateAvailability, string> = {
  ok: 'Player state received.',
  degraded: 'Player state is partial — the game could not read every field.',
  missing: 'Player state was delivered but the game returned nothing usable.',
  absent: 'Player state has not arrived yet. It may still be queued on the device.',
}

const FAKE_ARTICLES = [
  { id: 'a_123', title: 'My purchase did not arrive' },
  { id: 'a_456', title: 'I cannot log in' },
]

export function SupportSurface() {
  const [boot, setBoot] = useState<SurfaceBoot | null>(null)
  const [data, setData] = useState<BootstrapResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [read, setRead] = useState<string[]>([])

  // React double-invokes effects on mount under StrictMode in development. The
  // first pass scrubs the hash, so a second pass would read an empty fragment,
  // conclude there is no token, and set a permanent false error alongside the real
  // data. The sentinel makes the effect idempotent — do NOT solve this by removing
  // StrictMode; the double-invoke is a useful check and the effect should survive it.
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const parsed = readBoot(window.location)
    if (!parsed) {
      setError('This page must be opened by the game. No session token was supplied.')
      return
    }
    setBoot(parsed)
    scrubToken(window.history, window.location)

    fetchBootstrap(parsed.token, parsed.sessionId)
      .then(setData)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not load support.'))
  }, [])

  const onRead = (articleId: string) => {
    if (!boot) return
    // Both paths: the event the funnel counts, and the bridge message the SDK echoes
    // back in sessions/end. Having both is how a silently dead bridge is detected.
    void reportArticleRead(boot.token, boot.sessionId, articleId).catch(() => {})
    post({ type: 'article_read', id: articleId })
    setRead((current) => [...current, articleId])
  }

  return (
    <main className="surface">
      <h1>Support</h1>

      {error !== null && <p className="notice">{error}</p>}

      {data !== null && (
        <>
          <section>
            <h2>Session</h2>
            <dl>
              <dt>Session</dt>
              <dd>{data.session.id}</dd>
              <dt>Opened from</dt>
              <dd>{data.session.entry_point}</dd>
              <dt>Started</dt>
              <dd>{data.session.started_at}</dd>
              <dt>Player</dt>
              <dd>{data.player.external_player_id}</dd>
              <dt>Unread replies</dt>
              <dd>{data.unread_count}</dd>
            </dl>
          </section>

          <section>
            <h2>Player state</h2>
            {/* Missing data is a state, not an error: always a sentence, never a
                blank panel and never an error page. */}
            <p className="notice">{AVAILABILITY_COPY[data.player_state.availability]}</p>
            {data.player_state.degraded_reason !== null && (
              <p className="notice">Reason: {data.player_state.degraded_reason}</p>
            )}
            {/* captured_at is shown prominently on purpose: a reopened conversation
                keeps its original snapshot, so an agent could otherwise read a
                six-month-old client version as current. */}
            <p>Captured at: {data.player_state.captured_at ?? 'not captured'}</p>

            <h3>Declared</h3>
            <pre>{JSON.stringify(data.player_state.declared, null, 2)}</pre>

            {data.player_state.raw !== undefined && (
              <>
                <h3>Freeform</h3>
                <pre>{JSON.stringify(data.player_state.raw, null, 2)}</pre>
              </>
            )}
          </section>

          <section>
            <h2>Help articles</h2>
            <ul>
              {FAKE_ARTICLES.map((article) => (
                <li key={article.id}>
                  <button type="button" onClick={() => onRead(article.id)}>
                    {article.title}
                  </button>
                  {read.includes(article.id) && <span> — read</span>}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {/* Always on screen, whatever else happened — including when bootstrap failed.
          "Still need help?" and "Talk to a person" appear on every screen; there are
          no dead ends. Neither does anything yet: the chat UI arrives with the
          conversation slice. */}
      <section>
        <button type="button" onClick={() => post({ type: 'conversation_created' })}>
          Still need help?
        </button>
        {/* Both controls are required on EVERY screen, including a failed bootstrap.
            Their absence is the dead end the rule forbids, so the stub renders them
            even though the real handoff arrives with the chat slice. */}
        <button type="button" onClick={() => post({ type: 'conversation_created' })}>
          Talk to a person
        </button>
        <button type="button" onClick={() => post({ type: 'close' })}>
          Close
        </button>
      </section>
    </main>
  )
}
```

`frontend/src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SupportSurface } from './SupportSurface.tsx'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <SupportSurface />
  </StrictMode>,
)
```

`frontend/src/styles.css` — the bare minimum so it is readable on a phone, and nothing more:

```css
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
.surface {
  margin: 0 auto;
  max-width: 40rem;
  padding: max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom));
}
dl { display: grid; grid-template-columns: 10rem 1fr; gap: 0.25rem 1rem; }
dt { font-weight: 600; }
pre { overflow-x: auto; padding: 0.5rem; background: rgb(0 0 0 / 0.06); }
.notice { padding: 0.5rem; border-left: 3px solid currentColor; }
button { padding: 0.5rem 0.75rem; margin-right: 0.5rem; }
```

- [ ] **Step 9: Prove the whole handoff by hand**

This is the acceptance test for build-order step 3, and it is worth doing carefully — it is the first time both halves of the seam run together.

```bash
# Terminal 1
docker compose up -d
pnpm --filter @support/api dev

# Terminal 2
cp frontend/.env.example frontend/.env
pnpm --filter @support/web dev
```

Then, with the seed's workspace secret in `$SEED_SECRET`:

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/auth/player-token \
  -H "Authorization: Bearer $SEED_SECRET" -H 'Content-Type: application/json' \
  -d '{"external_player_id":"UserId7661"}' | node -e "
    let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")

SESSION=$(node -e "console.log(crypto.randomUUID())")

curl -s -X POST http://localhost:4000/sdk/sessions/start \
  -H "Authorization: Bearer $TOKEN" -H 'X-Support-Workspace: demo-game' \
  -H 'X-Support-Sdk: 1.0.2' -H 'X-Support-Client-Version: 6.2.01' \
  -H "Idempotency-Key: $(node -e 'console.log(crypto.randomUUID())')" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SESSION\",\"entry_point\":\"settings_menu\",
       \"started_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
       \"snapshot\":{\"player_id\":\"UserId7661\",\"platform\":\"ios\",\"client_version\":\"6.2.01\",
                     \"player_level\":34,\"spend_tier\":\"non-payer\",
                     \"extra\":{\"ab_bucket\":\"B\"}}}"

echo "http://localhost:5173/?session=$SESSION&entry=settings_menu#t=$TOKEN"
```

Open the printed URL. Confirm, in order:

1. The page shows `UserId7661`, `settings_menu`, and the declared fields — **the right player's state**.
2. `ab_bucket` appears under **Freeform**, not Declared.
3. The address bar no longer contains `#t=`.
4. Clicking an article title logs a bridge warning (no SDK present) and writes an event:
   `select type, payload from event where type = 'article_read';`
5. Clicking **Close** logs the `close` message. In a browser nothing else happens — the SDK is what turns that into `POST /sdk/sessions/end`, which is Task 17's script.

- [ ] **Step 10: Commit**

```bash
git add frontend pnpm-lock.yaml
git commit -m "feat(surface): web stub that reads the fragment and renders player state"
```

---

### Task 17: Seam verification script and documentation

**Files:**
- Create: `scripts/verify-seam.sh`
- Modify: `README.md`, `CLAUDE.md`, `docs/specs/2026-08-04-database-and-schema-design.md`
- Create: `docs/decisions/2026-08-04-sdk-path-schema-subset.md`
- Already written during execution (reference them, do not rewrite): `docs/decisions/2026-08-04-agent-auth-google-oauth.md`, `docs/decisions/2026-08-04-composite-foreign-keys-for-tenancy.md`, `docs/decisions/2026-08-04-unscoped-table-writes.md`, `docs/decisions/2026-08-04-three-audience-api-structure.md`
- Modify: `backend/tsconfig.json` — add `"declaration": false`. It inherits `declaration: true` from `tsconfig.base.json`, which forces TypeScript's nameability checks and makes every exported `Router` raise TS2742 unless hand-annotated with `RouterType`. `backend` sets `noEmit: true` and runs via Node's type stripping — it never emits a `.d.ts`, so the flag buys nothing there. Only `packages/types` needs it. Verified: with `declaration: false`, unannotated `export const r = Router()` compiles clean. Then drop the now-redundant `RouterType` annotations on `playerTokenRouter` and `sdkRouter` and confirm the suite still passes.
- Create: `backend/src/env/loadRootEnv.ts` — **factor out the repo-root `.env` loader.** Three files (`db/seed.ts`, `db/setup.ts`, `server.ts`) now hand-roll a root-relative `.env` path with a hardcoded number of `..` segments, each correct for its own depth. They work today and silently break the moment a file moves. Expose one helper that resolves the repo root once (walk up for `pnpm-workspace.yaml` rather than counting directories) and have all three call it. Keep the dynamic-import deferral where it is needed — that dodges ESM hoisting past the eager `getEnv()` in `db/client.ts` and is a separate concern from path resolution.
- Modify: `backend/src/auth/playerTokenRoute.ts` — one comment fix. It reads *"Compare the secret first so the response cannot be used to enumerate workspace slugs"*, but the code short-circuits on `!found` and never reaches `secretMatches` for an unknown slug. Replace it with the truth: the slug is not a secret (it travels in `X-Support-Workspace` on every SDK request), so enumeration via `404` is deliberately accepted because a game backend operator needs `404` to mean "you typed the slug wrong".
- Rename: `backend/src/auth/jwt.ts` → `backend/src/auth/playerToken.ts`, updating every import. Deferred here deliberately so it did not churn in-flight tasks. The file is player-specific (it sets `aud: 'support-player'`), and the generic name would attract agent-token code once the console's Google OAuth session lands — which is precisely the audience mixing `docs/decisions/2026-08-04-three-audience-api-structure.md` exists to prevent. Run the full suite after; it is a pure rename with no behaviour change.
- Modify: `packages/types/src/sdk-wire.ts` — fix `IncidentBody.detail`'s truncation. It is currently `z.string().max(2000).catch('')`, and `.catch()` fires on the *whole* parse failure, so an over-length `detail` becomes an **empty string**, not a 2000-char prefix — 100% of the diagnostic content is silently discarded rather than truncated. Change to a length check plus `.transform(s => s.slice(0, 2000))` (validate first, then truncate — do not truncate before validating other constraints). Then fix `backend/tests/sdk.incidents.test.ts`'s `"truncates an abusive detail rather than rejecting the report"` test, which currently only asserts `length <= 2000` — a check an empty string trivially satisfies and which caught nothing. Assert the result is non-empty and equals the exact 2000-character prefix of the input.

**Interfaces:**
- Consumes: everything. Produces no code — this task closes the loop so the next person is not guessing.

- [ ] **Step 1: Write `scripts/verify-seam.sh`**

The build order's *"done when"* for step 2 is *"curl mints a token, starts a session, and a `player_state_snapshot` row appears with the split correct."* This makes that repeatable.

```bash
#!/usr/bin/env bash
# Proves the SDK seam end to end against a running API.
#   SEED_SECRET=sk_demo-game.xxx ./scripts/verify-seam.sh
set -euo pipefail

API="${API_BASE_URL:-http://localhost:4000}"
SLUG="${WORKSPACE_SLUG:-demo-game}"
: "${SEED_SECRET:?Set SEED_SECRET to the workspace secret printed by db:seed}"

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log($1)})"; }
uuid() { node -e 'console.log(crypto.randomUUID())'; }

echo "1. minting a player token"
TOKEN=$(curl -sf -X POST "$API/auth/player-token" \
  -H "Authorization: Bearer $SEED_SECRET" -H 'Content-Type: application/json' \
  -d '{"external_player_id":"UserId7661"}' | json 'o.token')
[ -n "$TOKEN" ] || { echo "FAIL: no token"; exit 1; }

SESSION=$(uuid)
HDRS=(-H "Authorization: Bearer $TOKEN" -H "X-Support-Workspace: $SLUG"
      -H 'X-Support-Sdk: 1.0.2' -H 'X-Support-Client-Version: 6.2.01'
      -H 'Content-Type: application/json')

echo "2. starting session $SESSION"
curl -sf -X POST "$API/sdk/sessions/start" "${HDRS[@]}" -H "Idempotency-Key: $(uuid)" \
  -d "{\"session_id\":\"$SESSION\",\"entry_point\":\"settings_menu\",
       \"started_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
       \"snapshot\":{\"player_id\":\"UserId7661\",\"platform\":\"ios\",\"os_version\":\"26.5.2\",
                     \"device_model\":\"iPhone 13 Pro Max\",\"locale\":\"en-GB\",
                     \"client_version\":\"6.2.01\",\"player_level\":34,\"total_spend\":0,
                     \"spend_tier\":\"non-payer\",\"extra\":{\"ab_bucket\":\"B\"}}}" >/dev/null

echo "3. redelivering the same start (the Outbox does this)"
curl -sf -X POST "$API/sdk/sessions/start" "${HDRS[@]}" -H "Idempotency-Key: $(uuid)" \
  -d "{\"session_id\":\"$SESSION\",\"entry_point\":\"settings_menu\",\"snapshot\":{}}" >/dev/null

echo "4. bootstrap as the web surface would"
curl -sf "$API/surface/bootstrap?session_id=$SESSION" -H "Authorization: Bearer $TOKEN" \
  | json 'JSON.stringify({availability:o.player_state.availability,
                          declared:Object.keys(o.player_state.declared).length,
                          raw:o.player_state.raw},null,2)'

echo "5. article_read, unread, incident, end"
curl -sf -X POST "$API/surface/events/article_read" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"session_id\":\"$SESSION\",\"article_id\":\"a_123\"}" >/dev/null
curl -sf "$API/sdk/unread" "${HDRS[@]}" | json 'JSON.stringify(o)'
curl -sf -X POST "$API/sdk/incidents" "${HDRS[@]}" \
  -d "{\"incident_id\":\"$(uuid)\",\"session_id\":\"$SESSION\",\"kind\":\"token_timeout\",
       \"detail\":\"5s elapsed, no response\",\"sdk_version\":\"1.0.2\",\"client_version\":\"6.2.01\"}" >/dev/null
curl -sf -X POST "$API/sdk/sessions/end" "${HDRS[@]}" \
  -d "{\"session_id\":\"$SESSION\",\"duration_ms\":184200,\"conversation_created\":false,
       \"articles_read\":[\"a_123\"]}" >/dev/null

cat <<EOF

Now confirm in psql:
  docker compose exec postgres psql -U support_owner -d support -c "
    select type, count(*) from event where session_id = '$SESSION' group by type order by type;"

Expected exactly:
  article_read   1
  sdk_incident   1
  session_end    1
  session_start  1     <- one, not two: the redelivery appended no second event
EOF
```

Make it executable (`chmod +x scripts/verify-seam.sh`) and run it. If `session_start` shows `2`, the idempotency guard in Task 9 regressed.

- [ ] **Step 2: Append the schema addendum**

Add to the end of `docs/specs/2026-08-04-database-and-schema-design.md`, above `## Open`:

```markdown
## Addendum — 2026-08-04, the SDK-path slice

Three columns the wire contract requires that the table list above does not carry.
Added in the first migration; the reasoning belongs here rather than in a plan.

| Table | Column | Why |
|---|---|---|
| `workspace` | `secret_hash text NOT NULL` | `POST /auth/player-token` authenticates with `Authorization: Bearer <workspace_secret>`. Format `sk_<slug>.<32 random bytes base64url>`; the stored value is the sha256 of the random half. sha256 rather than a slow KDF because the secret is 256 bits of CSPRNG output — there is no guessable password to slow an attacker down to. (There is no agent password to contrast this with: agent auth is Google OAuth restricted to the mindstormstudios.com org — see `docs/decisions/2026-08-04-agent-auth-google-oauth.md`.) |
| `workspace` | `disabled_at timestamptz` | The wire contract requires `404` for a workspace that is *"not found **or disabled**"*, and a disabled workspace must also invalidate live player tokens rather than waiting out their 15 minutes. |
| `session` | `ended_by session_end_reason` (`client` \| `timeout`) | The wire contract's repeatable job marks sessions it closes `ended_by = 'timeout'`. Without the column, a timed-out session is indistinguishable from one the player closed — and *"a missing end must never silently shrink the denominator"* depends on being able to tell. |

**Also decided in that slice, and not stated anywhere above:**

- **`player_state_snapshot` is written `ON CONFLICT (session_id) DO NOTHING`, not `DO UPDATE`.** The wire contract says "upsert", but a redelivery arriving after a field was promoted would re-split against the newer `declared_field` set and move a key from `raw` into `declared` — retroactive promotion through the back door. First write wins, permanently.
- **`is_missing` is judged on the six *provider* fields alone** (`player_id`, `player_level`, `total_spend`, `spend_tier`, `account_created_at`, `last_session_at`), not on all eleven declared ones. The SDK's `DeviceProbe` fills the five device fields with no game involvement, so a provider that throws on everything still delivers five populated keys; including them would make `is_missing` unreachable.
- **`raw` reserves the `__` key prefix.** `raw.__player_id_mismatch` records a `snapshot.player_id` that disagrees with the JWT's `external_player_id`. Advisory only — the authoritative player is always the token's.
- **`event.type` is `text`, not an `ENUM`.** New types arrive with every slice and `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block. The enum list in *Postgres features this schema relies on* covers status, priority, delivery state, author type and visibility — deliberately not event type.
```

- [ ] **Step 3: Write the deferral decision record**

`docs/decisions/2026-08-04-sdk-path-schema-subset.md`:

```markdown
# Ten tables first, twenty-two later

**Date:** 2026-08-04
**Status:** Accepted
**Context:** the SDK-seam slice (build-order steps 1–3 of `2026-08-04-sdk-wire-contract.md`)

## Decision

Migration `001` creates ten of the thirty-two specced tables — the ones the SDK path
touches: `workspace`, `agent`, `workspace_member`, `player`, `session`,
`player_state_snapshot`, `declared_field`, `event`, and a minimal `conversation` and
`message`. The remaining twenty-two arrive in migration `002`, at the start of the
conversation slice.

## Consequences

- **`conversation` and `message` exist only because `GET /sdk/unread` joins them.**
  `conversation.subintent_id`, `resolution_cycle`, labels and form submissions are
  absent, and the status machine is a default rather than a machine. Nothing in this
  slice creates a conversation.
- **The `Other` intent and its catch-all subintent are not seeded**, because `intent`
  and `subintent` do not exist. The build order asks step 1 to seed *"one workspace and
  the `Other` taxonomy"*; the taxonomy half moves to migration `002` and is the first
  task of that slice. **This is the one deferral with a real risk of being forgotten** —
  conversations store a subintent, so without the catch-all there is nowhere for
  "anything it can't place" to land.
- **`event` ships now, in full**, as the schema spec demands ("build this on day two").
  Its data cannot be reconstructed later, and `session_start` / `session_end` /
  `article_read` / `sdk_incident` all flow through it from this slice onwards.
- Migration `002` will `ALTER TABLE conversation` rather than create it. That is a
  cheap, additive change and is the price of proving the seam first.

## Rejected

**All 33 tables in migration 001.** The schema is fully designed, so this was
defensible. Rejected because it puts several tasks of DDL — pgvector, HNSW, forms,
automation — ahead of the first endpoint, and the seam is what needs proving first:
it spans both repos and is where the surprises live.
```

- [ ] **Step 4: Update `README.md`**

Replace whatever the README says about commands with the real ones, and record the resolved dependency versions from `pnpm-lock.yaml`:

```markdown
## Running it

```bash
cp .env.example .env                 # then set PLAYER_JWT_SECRET
docker compose up -d                 # Postgres 17 (pgvector) + Redis 7
pnpm install
pnpm db:setup                        # extensions → drizzle-kit push → RLS
pnpm db:seed                         # prints the workspace secret ONCE
pnpm dev                             # api on :4000, web surface on :5173
```

| Command | What it does |
|---|---|
| `pnpm test` | every package's suite; the API's needs Postgres up |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm db:setup` | idempotent; re-run after any schema change |
| `SEED_SECRET=… ./scripts/verify-seam.sh` | proves the SDK seam end to end |

Tests run against `support_test`, created automatically. `globalSetup` refuses any
database whose name does not end in `_test`.

## What exists

Build-order steps 1–3 of `docs/specs/2026-08-04-sdk-wire-contract.md`:
`POST /auth/player-token`, the four `/sdk/*` endpoints, `GET /surface/bootstrap`,
`POST /surface/events/article_read`, the 30-minute session-timeout job, and a
deliberately-ugly web surface stub. Ten of the 33 tables — see
`docs/decisions/2026-08-04-sdk-path-schema-subset.md`.

**Not built:** conversations, messages, the bot, the taxonomy, forms, the agent
console, the admin console, reporting. Step 5 of the build order.

## Owed

- **Nothing watches `sdk_incident`.** The write path exists; alerting does not. A
  rising count is how you learn a release broke support entry for a whole platform,
  so an unwatched stream is the silent failure it was built to prevent. Until then,
  this query is the manual check:

  ```sql
  select date_trunc('hour', occurred_at) as hour,
         payload->>'kind' as kind, count(*)
    from event
   where type = 'sdk_incident' and occurred_at > now() - interval '24 hours'
   group by 1, 2 order by 1 desc;
  ```

- **`GET /surface/bootstrap` returns `raw` outside production.** Remove that branch
  when the real chat UI lands; the agent Game View is what reads freeform state.
- **Agent auth is not built.** `agent` carries a Google identity (`email`, `google_subject`)
  and no password, per `docs/decisions/2026-08-04-agent-auth-google-oauth.md`. The OAuth
  flow — client registration, callback, token verification, the
  **mindstormstudios.com org check**, session issuance and the Redis denylist — ships
  with the console slice and needs its own plan. The seeded admin row has a null
  `google_subject` until that person's first real login.
```

- [ ] **Step 5: Update `CLAUDE.md`**

Two edits, both in **Current state**:

1. Replace *"**Scaffold only.** `frontend/` and `backend/` contain nothing but a README… Do not invent commands for this repo — there are none yet"* with the real command table from the README and a one-line summary of what is built.
2. Replace *"**The database and schema are specced but not built.** 33 tables… No migration exists yet"* with: ten tables built in migration `001`, twenty-three deferred to `002`, pointing at the new decision record.

Then add to the **Source of truth** list, after item 5:

```markdown
7. `docs/plans/2026-08-04-app-side-sdk-seam.md` — the implementation plan for the SDK
   seam, and `docs/decisions/2026-08-04-sdk-path-schema-subset.md` for why ten tables
   rather than 32. Both are records of what was built, not requirements.
```

Also correct the **Traps** list, which is now missing three:

```markdown
- **`SET LOCAL app.workspace_id = $1` is a syntax error.** Use
  `select set_config('app.workspace_id', $1, true)`.
- **RLS does not bind the table owner** unless the table is `FORCE ROW LEVEL SECURITY`.
  The app connects as a non-owner role (`support_app`) as well, so a mistake in either
  mechanism is caught by the other.
- **Foreign-key checks bypass RLS.** Any client-supplied id used as a FK must first be
  confirmed visible with an explicit scoped `SELECT`, or a row can point across the
  tenant boundary while every policy is in place.
```

- [ ] **Step 6: Run everything one last time**

```bash
pnpm typecheck
pnpm test
SEED_SECRET=… ./scripts/verify-seam.sh
```

Expected: clean typecheck, ~117 tests passing across backend and the two front-end/types packages, and the verification script's event counts exactly as printed.

- [ ] **Step 7: Commit**

```bash
git add scripts/verify-seam.sh README.md CLAUDE.md \
        docs/specs/2026-08-04-database-and-schema-design.md \
        docs/decisions/2026-08-04-sdk-path-schema-subset.md
git commit -m "docs: seam verification script, schema addendum, subset decision record"
```

---

## What this plan does not build

Named so the next plan starts from a known edge, and so nobody reads a gap as an oversight.

| Not built | Where it belongs |
|---|---|
| `POST /conversations`, `POST /messages`, message `seq` assignment, the two serializers, socket rooms | Step 5 — the core loop |
| The 22 remaining tables, the `Other` intent + catch-all subintent | Migration `002`, first task of step 5 |
| The bot, article retrieval, pgvector, knowledge sync | Step 5 and the bot slice |
| Forms, rules, the taxonomy admin, `declared_field` promotion UI | Slice 2 |
| Agent auth, the agent console, the admin console, reporting | Slice 3 |
| The inactivity clock and auto-close workers | Conversation slice — **not** the session-timeout job built here |
| Uploads, presigned PUT/GET, attachment visibility checks | With messages |
| Alerting on `sdk_incident` | Owed; recorded in the README |
| The Unity SDK itself | The other repo, step 4, per `sdk-production-implementation.md` |
