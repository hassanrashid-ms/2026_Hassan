# Configurable Message Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CRM's hardcoded bot/system messages (no-agents-online, handoff variants, form summaries) per-workspace editable, and add a shared workspace-wide library of agent canned replies with a `{{agent_name}}` placeholder, all backed by a Redis cache-aside layer so the hot path never hits Postgres.

**Architecture:** One new table, `message_template` (workspace-scoped, RLS via the existing structural policy), holds both categories via a `kind` discriminator. Reads go through `loadTemplates(tx, workspaceId)`, which is Redis-cached (`templates:{workspaceId}`, invalidated on write) and falls back to today's hardcoded constants when a workspace has no active row for a key — mirroring `resolveBotConfig`'s established "absent row collapses to default" pattern, so nothing is seeded or backfilled and every existing test keeps passing unmodified. Admin CRUD runs through a new `/agent/templates` router (team_lead+admin read, admin write, same split as Bot Config/Workspace Settings).

**Tech Stack:** Express 5, Drizzle ORM + PostgreSQL (RLS), ioredis, Vitest + Supertest, React + TanStack Query + Tailwind (agent-console surface).

## Global Constraints

- No hard deletes anywhere — "removing" a template row is `is_active = false`, never a DELETE. (spec: Data model)
- Every scoped table needs a `workspace_id` column and nothing else — RLS is applied structurally by `002_rls.sql` to every table with that column; no manual policy SQL needed.
- Redis is a cache, never the system of record (`CLAUDE.md` Stack table) — every cached read must have a Postgres-backed fallback path.
- New API endpoints must be registered in `backend/src/docs/openapi.ts` (`CLAUDE.md` General rules).
- Canned replies support exactly one placeholder, `{{agent_name}}`, resolved client-side from the sending agent's session `displayName` — never stored resolved. (spec: Frontend)
- Handoff keeps its "pick one of N variants at random" behavior — admins manage the variant list, not a single string. (spec: Data model)
- No version-history/audit UI for template edits in this pass (spec: Non-goals) — `updated_at` is sufficient, do not add a `change_log` integration for this feature.

---

### Task 1: `message_template` schema + migration

**Files:**

- Create: `backend/src/shared/db/schema/templates.ts`
- Modify: `backend/src/shared/db/schema/index.ts` (add `export * from './templates.ts';`)
- Modify: `backend/tests/helpers/db.ts` (add `'message_template'` to `SCOPED_TABLES`)
- Modify: `backend/tests/rls.test.ts` (add `'message_template'` to its own `SCOPED_TABLES` list)
- Test: `backend/tests/rls.test.ts` (existing test, run as verification — no new test file needed, see Step 4)

**Interfaces:**

- Produces: `messageTemplate` Drizzle table, columns `id, workspaceId, kind ('system'|'canned'), key (text|null), label (text|null), body (text), sortOrder (integer), isActive (boolean), createdByAgentId (uuid|null), createdAt, updatedAt`. Later tasks import this from `../../shared/db/schema/index.ts`.

- [ ] **Step 1: Write the schema file**

```typescript
// backend/src/shared/db/schema/templates.ts
import { boolean, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agent, workspace } from './identity.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

export const templateKind = pgEnum('template_kind', ['system', 'canned']);

/**
 * Both the configurable system messages (no_agents_online, handoff,
 * form_summary_completed/partial/skipped) and the agent canned-reply library
 * live in one table, discriminated by `kind`. A genuinely absent row for a
 * `system` key is not an error — loadTemplates() in templateService.ts
 * collapses it to the hardcoded default, the same pattern resolveBotConfig
 * uses for bot_config. `handoff` is the only key with more than one active
 * row per workspace; the others are singletons enforced in templateService,
 * not by a DB constraint (an admin PATCHing two rows active in a race is a
 * cosmetic "which one wins" question, not a correctness one, and adding a
 * partial-unique-index for it is not worth it for this feature).
 */
export const messageTemplate = pgTable('message_template', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  kind: templateKind('kind').notNull(),
  /** 'no_agents_online' | 'handoff' | 'form_summary_completed' | 'form_summary_partial' | 'form_summary_skipped' for kind='system'; null for kind='canned'. */
  key: text('key'),
  /** Display name for a canned reply, e.g. "Intro". Null for kind='system'. */
  label: text('label'),
  body: text('body').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdByAgentId: uuid('created_by_agent_id').references(() => agent.id, {
    onDelete: 'restrict',
  }),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
});
```

- [ ] **Step 2: Export it from the schema barrel**

In `backend/src/shared/db/schema/index.ts`, add a line after the existing `export * from './tags.ts';`:

```typescript
export * from './templates.ts';
```

- [ ] **Step 3: Add the table to both test truncate/RLS lists**

In `backend/tests/helpers/db.ts`, add `'message_template'` to `SCOPED_TABLES` (anywhere in the array — order doesn't matter for `TRUNCATE ... CASCADE`, but keep it near `'change_log'` for readability):

```typescript
const SCOPED_TABLES = [
  'article_attachment',
  'attachment',
  'resolution_cycle',
  'form_answer',
  'form_submission',
  'form_version',
  'form',
  'message_template',
  'change_log',
  // ...unchanged rest
```

In `backend/tests/rls.test.ts`, add `'message_template'` to its own `SCOPED_TABLES` array the same way (this list exists only for readable per-table failure messages — the SQL itself derives "scoped" structurally, see Global Constraints).

- [ ] **Step 4: Generate and apply the migration**

Run: `pnpm db:generate` (from `backend/`)
Expected: a new file appears under `backend/drizzle/`, e.g. `00XX_<name>.sql`, containing `CREATE TYPE "template_kind" ...` and `CREATE TABLE "message_template" (...)`.

Run: `pnpm db:setup`
Expected: exits 0 — this runs the new migration, then re-runs `002_rls.sql`, which structurally picks up `message_template` (it has a `workspace_id` column) and applies the tenant policy to it automatically.

- [ ] **Step 5: Verify RLS coverage**

Run: `pnpm test rls.test.ts`
Expected: PASS — the structural drift guard in that file confirms `message_template` is both present in Postgres with `workspace_id` and has RLS enabled, using the `SCOPED_TABLES` list you extended in Step 3.

- [ ] **Step 6: Commit**

```bash
git add backend/src/shared/db/schema/templates.ts backend/src/shared/db/schema/index.ts backend/tests/helpers/db.ts backend/tests/rls.test.ts backend/drizzle/
git commit -m "feat: add message_template table"
```

---

### Task 2: Redis cache-aside module

**Files:**

- Create: `backend/src/domain/templates/templateCache.ts`
- Test: `backend/tests/templateCache.test.ts`

**Interfaces:**

- Consumes: `getEnv().REDIS_URL` from `backend/src/env.ts` (same as `wsAuthCache.ts`).
- Produces: `TemplatesCachePayload` type, `getCachedTemplates(workspaceId): Promise<TemplatesCachePayload | null>`, `setCachedTemplates(workspaceId, payload): Promise<void>`, `invalidateCachedTemplates(workspaceId): Promise<void>`, `closeTemplateCacheRedis(): Promise<void>` (test teardown). Task 3 imports all four.

- [ ] **Step 1: Write the failing test**

```typescript
// backend/tests/templateCache.test.ts
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  closeTemplateCacheRedis,
  getCachedTemplates,
  invalidateCachedTemplates,
  setCachedTemplates,
  type TemplatesCachePayload,
} from '../src/domain/templates/templateCache.ts';

afterAll(async () => {
  await closeTemplateCacheRedis();
});

const samplePayload = (): TemplatesCachePayload => ({
  system: {
    no_agents_online: ['Custom no-agents line.'],
    handoff: ['Custom handoff one.', 'Custom handoff two.'],
    form_summary_completed: ['Custom completed line.'],
    form_summary_partial: ['Custom partial line.'],
    form_summary_skipped: ['Custom skipped line.'],
  },
  canned: [{ id: randomUUID(), label: 'Intro', body: 'Hi, this is {{agent_name}}.' }],
});

describe('templateCache', () => {
  it('returns null on a cache miss', async () => {
    expect(await getCachedTemplates(randomUUID())).toBeNull();
  });

  it('round-trips a cached payload', async () => {
    const workspaceId = randomUUID();
    const payload = samplePayload();
    await setCachedTemplates(workspaceId, payload);
    expect(await getCachedTemplates(workspaceId)).toEqual(payload);
  });

  it('invalidation clears a cached entry immediately', async () => {
    const workspaceId = randomUUID();
    await setCachedTemplates(workspaceId, samplePayload());
    await invalidateCachedTemplates(workspaceId);
    expect(await getCachedTemplates(workspaceId)).toBeNull();
  });

  it('keys are scoped per workspace — no cross-talk', async () => {
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    await setCachedTemplates(workspaceA, samplePayload());
    expect(await getCachedTemplates(workspaceB)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test templateCache.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/templates/templateCache.ts'`

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/domain/templates/templateCache.ts
import IORedis from 'ioredis';
import { getEnv } from '../../env.ts';

export type SystemMessageKey =
  | 'no_agents_online'
  | 'handoff'
  | 'form_summary_completed'
  | 'form_summary_partial'
  | 'form_summary_skipped';

export type CannedReplyEntry = { id: string; label: string; body: string };

/**
 * One key per workspace, not per-message: the full active-template set per
 * workspace is small, and reads vastly outnumber writes, so grouping avoids
 * N Redis round-trips per bot turn.
 */
export type TemplatesCachePayload = {
  system: Record<SystemMessageKey, string[]>;
  canned: CannedReplyEntry[];
};

const PREFIX = 'templates:';
// A safety net, not the primary invalidation path — every write path in
// templateService.ts calls invalidateCachedTemplates in the same request, so
// this TTL exists only in case an invalidation is ever missed. Redis is a
// cache here, never the system of record (see CLAUDE.md Stack table).
const TTL_SECONDS = 60 * 60 * 24;

let redisClient: IORedis | undefined;

function client(): IORedis {
  if (!redisClient) {
    redisClient = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  }
  return redisClient;
}

const cacheKey = (workspaceId: string): string => `${PREFIX}${workspaceId}`;

export async function getCachedTemplates(
  workspaceId: string,
): Promise<TemplatesCachePayload | null> {
  const raw = await client().get(cacheKey(workspaceId));
  if (raw === null) return null;
  return JSON.parse(raw) as TemplatesCachePayload;
}

export async function setCachedTemplates(
  workspaceId: string,
  payload: TemplatesCachePayload,
): Promise<void> {
  await client().set(cacheKey(workspaceId), JSON.stringify(payload), 'EX', TTL_SECONDS);
}

export async function invalidateCachedTemplates(workspaceId: string): Promise<void> {
  await client().del(cacheKey(workspaceId));
}

/** Test-only teardown, mirrors wsAuthCache.ts's closeWsAuthRedis. */
export async function closeTemplateCacheRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit().catch(() => redisClient!.disconnect());
    redisClient = undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test templateCache.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/templates/templateCache.ts backend/tests/templateCache.test.ts
git commit -m "feat: add Redis cache-aside layer for message templates"
```

---

### Task 3: `templateService.ts` read path (`loadTemplates`, `getSystemMessage`, `getHandoffMessage`, `listCannedReplies`)

**Files:**

- Create: `backend/src/domain/templates/templateService.ts`
- Test: `backend/tests/templateService.test.ts`

**Interfaces:**

- Consumes: `messageTemplate` table (Task 1), `getCachedTemplates`/`setCachedTemplates` (Task 2), `Tx` type from `backend/src/shared/db/withWorkspace.ts`, `HANDOFF_PLAYER_MESSAGES`/`NO_AGENTS_ONLINE_MESSAGE` from `../bot/messages.ts`, `FORM_SUMMARY_MESSAGES`-equivalent from `../forms/messages.ts` (that file currently exports only `formSummaryMessage`, not the map itself — Step 1 below adds `FORM_SUMMARY_MESSAGES` to its exports since this module needs the raw map, not the picker function).
- Produces: `getSystemMessage(tx: Tx, workspaceId: string, key: Exclude<SystemMessageKey, 'handoff'>): Promise<string>`, `getHandoffMessage(tx: Tx, workspaceId: string): Promise<string>`, `listCannedReplies(tx: Tx, workspaceId: string): Promise<CannedReplyEntry[]>`. Task 6 (call-site migration) and Task 7 (API) both import these.

- [ ] **Step 1: Export `FORM_SUMMARY_MESSAGES` from `forms/messages.ts`**

In `backend/src/domain/forms/messages.ts`, change `const FORM_SUMMARY_MESSAGES` to `export const FORM_SUMMARY_MESSAGES` (the existing `formSummaryMessage` function and its callers are untouched).

- [ ] **Step 2: Write the failing test**

```typescript
// backend/tests/templateService.test.ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { messageTemplate } from '../src/shared/db/schema/index.ts';
import { closeTemplateCacheRedis } from '../src/domain/templates/templateCache.ts';
import {
  getHandoffMessage,
  getSystemMessage,
  listCannedReplies,
} from '../src/domain/templates/templateService.ts';
import { HANDOFF_PLAYER_MESSAGES, NO_AGENTS_ONLINE_MESSAGE } from '../src/domain/bot/messages.ts';
import { closeOwnerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

afterAll(async () => {
  await closeTemplateCacheRedis();
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('templateService read path', () => {
  it('falls back to the hardcoded default when no row exists', async () => {
    const workspaceId = await seedWorkspace();
    const message = await withWorkspace(workspaceId, (tx) =>
      getSystemMessage(tx, workspaceId, 'no_agents_online'),
    );
    expect(message).toBe(NO_AGENTS_ONLINE_MESSAGE);
  });

  it('falls back to the hardcoded handoff list when no rows exist', async () => {
    const workspaceId = await seedWorkspace();
    const message = await withWorkspace(workspaceId, (tx) => getHandoffMessage(tx, workspaceId));
    expect(HANDOFF_PLAYER_MESSAGES as readonly string[]).toContain(message);
  });

  it('prefers an active DB row over the default', async () => {
    const workspaceId = await seedWorkspace();
    await withWorkspace(workspaceId, (tx) =>
      tx.insert(messageTemplate).values({
        workspaceId,
        kind: 'system',
        key: 'no_agents_online',
        body: 'Custom no-agents line.',
        sortOrder: 0,
      }),
    );
    const message = await withWorkspace(workspaceId, (tx) =>
      getSystemMessage(tx, workspaceId, 'no_agents_online'),
    );
    expect(message).toBe('Custom no-agents line.');
  });

  it('ignores a deactivated row and falls back to the default', async () => {
    const workspaceId = await seedWorkspace();
    await withWorkspace(workspaceId, (tx) =>
      tx.insert(messageTemplate).values({
        workspaceId,
        kind: 'system',
        key: 'no_agents_online',
        body: 'Retired line.',
        sortOrder: 0,
        isActive: false,
      }),
    );
    const message = await withWorkspace(workspaceId, (tx) =>
      getSystemMessage(tx, workspaceId, 'no_agents_online'),
    );
    expect(message).toBe(NO_AGENTS_ONLINE_MESSAGE);
  });

  it('lists active canned replies ordered by sort_order, excludes inactive ones', async () => {
    const workspaceId = await seedWorkspace();
    await withWorkspace(workspaceId, (tx) =>
      tx.insert(messageTemplate).values([
        {
          workspaceId,
          kind: 'canned',
          label: 'Closing',
          body: 'Thanks for reaching out!',
          sortOrder: 1,
        },
        {
          workspaceId,
          kind: 'canned',
          label: 'Intro',
          body: 'Hi, this is {{agent_name}}.',
          sortOrder: 0,
        },
        {
          workspaceId,
          kind: 'canned',
          label: 'Retired',
          body: 'no longer used',
          sortOrder: 2,
          isActive: false,
        },
      ]),
    );
    const replies = await withWorkspace(workspaceId, (tx) => listCannedReplies(tx, workspaceId));
    expect(replies.map((r) => r.label)).toEqual(['Intro', 'Closing']);
  });

  it('scopes rows per workspace — no cross-talk', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    await withWorkspace(workspaceA, (tx) =>
      tx.insert(messageTemplate).values({
        workspaceId: workspaceA,
        kind: 'system',
        key: 'no_agents_online',
        body: 'Workspace A only.',
        sortOrder: 0,
      }),
    );
    const messageB = await withWorkspace(workspaceB, (tx) =>
      getSystemMessage(tx, workspaceB, 'no_agents_online'),
    );
    expect(messageB).toBe(NO_AGENTS_ONLINE_MESSAGE);
  });

  it('caches the DB result so a second read within the same test does not need a fresh row', async () => {
    const workspaceId = await seedWorkspace();
    const first = await withWorkspace(workspaceId, (tx) =>
      getSystemMessage(tx, workspaceId, 'no_agents_online'),
    );
    // Row untouched — second read must still agree, proving the cache path
    // (or a repeat DB read) returns the same value, not a fluke.
    const second = await withWorkspace(workspaceId, (tx) =>
      getSystemMessage(tx, workspaceId, 'no_agents_online'),
    );
    expect(second).toBe(first);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test templateService.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/templates/templateService.ts'`

- [ ] **Step 4: Write the implementation**

```typescript
// backend/src/domain/templates/templateService.ts
import { and, asc, eq } from 'drizzle-orm';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { messageTemplate } from '../../shared/db/schema/index.ts';
import {
  getCachedTemplates,
  setCachedTemplates,
  type CannedReplyEntry,
  type SystemMessageKey,
  type TemplatesCachePayload,
} from './templateCache.ts';
import { HANDOFF_PLAYER_MESSAGES, NO_AGENTS_ONLINE_MESSAGE } from '../bot/messages.ts';
import { FORM_SUMMARY_MESSAGES } from '../forms/messages.ts';

export type { CannedReplyEntry, SystemMessageKey } from './templateCache.ts';

/**
 * The pre-feature behaviour, keyed the same way system rows are — read only
 * by loadTemplates() below when a workspace has zero active rows for a key.
 * Mirrors resolveBotConfig's "genuinely absent row collapses to the catalog
 * baseline" pattern: nothing is seeded or backfilled, so every workspace that
 * predates this feature (and every test that seeds a workspace via raw SQL,
 * bypassing any app-level provisioning) keeps behaving exactly as before.
 */
const DEFAULT_SYSTEM_MESSAGES: Record<SystemMessageKey, string[]> = {
  no_agents_online: [NO_AGENTS_ONLINE_MESSAGE],
  handoff: [...HANDOFF_PLAYER_MESSAGES],
  form_summary_completed: [FORM_SUMMARY_MESSAGES.completed],
  form_summary_partial: [FORM_SUMMARY_MESSAGES.partial],
  form_summary_skipped: [FORM_SUMMARY_MESSAGES.skipped],
};

/**
 * Cache-aside read of a workspace's full active template set. Takes the
 * caller's own transaction rather than opening one itself — every call site
 * (applyBotTurn, completeFormAndHandoff, messagesService's reopen branch)
 * already owns a single transaction for the whole request, per this repo's
 * "one transaction per call" convention, and nesting a second withWorkspace
 * here would open a second connection with its own RLS setting for no reason.
 */
export async function loadTemplates(tx: Tx, workspaceId: string): Promise<TemplatesCachePayload> {
  const cached = await getCachedTemplates(workspaceId);
  if (cached) return cached;

  const rows = await tx
    .select({
      kind: messageTemplate.kind,
      key: messageTemplate.key,
      id: messageTemplate.id,
      label: messageTemplate.label,
      body: messageTemplate.body,
    })
    .from(messageTemplate)
    .where(and(eq(messageTemplate.workspaceId, workspaceId), eq(messageTemplate.isActive, true)))
    .orderBy(asc(messageTemplate.sortOrder));

  const system: Record<SystemMessageKey, string[]> = {
    no_agents_online: [],
    handoff: [],
    form_summary_completed: [],
    form_summary_partial: [],
    form_summary_skipped: [],
  };
  const canned: CannedReplyEntry[] = [];

  for (const row of rows) {
    if (row.kind === 'system' && row.key) {
      system[row.key as SystemMessageKey].push(row.body);
    } else if (row.kind === 'canned') {
      canned.push({ id: row.id, label: row.label ?? '', body: row.body });
    }
  }

  const payload: TemplatesCachePayload = { system, canned };
  await setCachedTemplates(workspaceId, payload);
  return payload;
}

/** For the four singleton system keys. Use getHandoffMessage for 'handoff'. */
export async function getSystemMessage(
  tx: Tx,
  workspaceId: string,
  key: Exclude<SystemMessageKey, 'handoff'>,
): Promise<string> {
  const { system } = await loadTemplates(tx, workspaceId);
  const active = system[key];
  return active.length > 0 ? active[0]! : DEFAULT_SYSTEM_MESSAGES[key][0]!;
}

/**
 * Random rather than round-robin — same reasoning as the pre-feature
 * pickHandoffMessage() in bot/messages.ts, now over a workspace-configurable
 * list instead of the hardcoded one. Callers must not cache the result across
 * messages, same caveat as before.
 */
export async function getHandoffMessage(tx: Tx, workspaceId: string): Promise<string> {
  const { system } = await loadTemplates(tx, workspaceId);
  const variants = system.handoff.length > 0 ? system.handoff : DEFAULT_SYSTEM_MESSAGES.handoff;
  return variants[Math.floor(Math.random() * variants.length)]!;
}

export async function listCannedReplies(tx: Tx, workspaceId: string): Promise<CannedReplyEntry[]> {
  const { canned } = await loadTemplates(tx, workspaceId);
  return canned;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test templateService.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain/forms/messages.ts backend/src/domain/templates/templateService.ts backend/tests/templateService.test.ts
git commit -m "feat: add template service read path with default fallback"
```

---

### Task 4: `templateService.ts` write path (create / update / deactivate)

**Files:**

- Modify: `backend/src/domain/templates/templateService.ts`
- Test: `backend/tests/templateService.test.ts` (extend)

**Interfaces:**

- Consumes: `withWorkspace` from `backend/src/shared/db/withWorkspace.ts`, `invalidateCachedTemplates` from `templateCache.ts`, `AgentContext` type from `backend/src/shared/middleware/requireAgentSession.ts`.
- Produces: `TemplateRowView` type (`{id, kind, key, label, body, sort_order, is_active}`), `createSystemTemplate(ctx, args: {key: Exclude<SystemMessageKey,'handoff'>, body: string}): Promise<TemplateRowView>`, `addHandoffVariant(ctx, body: string): Promise<TemplateRowView>`, `createCannedReply(ctx, args: {label: string, body: string}): Promise<TemplateRowView>`, `updateTemplate(ctx, id: string, patch: {body?: string, label?: string, isActive?: boolean}): Promise<TemplateRowView>`. Task 5 (controller) imports all four writers plus `TemplateRowView`.

- [ ] **Step 1: Write the failing tests (append to `templateService.test.ts`)**

```typescript
// add to the top imports of backend/tests/templateService.test.ts
import {
  addHandoffVariant,
  createCannedReply,
  createSystemTemplate,
  getHandoffMessage,
  getSystemMessage,
  listCannedReplies,
  updateTemplate,
} from '../src/domain/templates/templateService.ts';
import { getCachedTemplates } from '../src/domain/templates/templateCache.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
```

```typescript
// append inside a new describe block at the bottom of the file
describe('templateService write path', () => {
  async function ctxFor(workspaceId: string) {
    const { rows } = await (
      await import('./helpers/db.ts')
    ).ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name, is_admin) values ($1, 'Test Admin', true) returning id`,
      [`admin-${randomUUID()}@example.test`],
    );
    return { agentId: rows[0]!.id, workspaceId };
  }

  it('createSystemTemplate replaces the prior active row for a singleton key', async () => {
    const workspaceId = await seedWorkspace();
    const ctx = await ctxFor(workspaceId);

    const first = await createSystemTemplate(ctx, {
      key: 'no_agents_online',
      body: 'First custom line.',
    });
    const second = await createSystemTemplate(ctx, {
      key: 'no_agents_online',
      body: 'Second custom line.',
    });

    expect(first.id).not.toBe(second.id);
    const resolved = await withWorkspace(workspaceId, (tx) =>
      getSystemMessage(tx, workspaceId, 'no_agents_online'),
    );
    expect(resolved).toBe('Second custom line.');
  });

  it('addHandoffVariant appends rather than replacing', async () => {
    const workspaceId = await seedWorkspace();
    const ctx = await ctxFor(workspaceId);

    await addHandoffVariant(ctx, 'Variant one.');
    await addHandoffVariant(ctx, 'Variant two.');

    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const message = await withWorkspace(workspaceId, (tx) => getHandoffMessage(tx, workspaceId));
      seen.add(message);
    }
    expect(seen).toEqual(new Set(['Variant one.', 'Variant two.']));
  });

  it('createCannedReply then updateTemplate edits its body', async () => {
    const workspaceId = await seedWorkspace();
    const ctx = await ctxFor(workspaceId);

    const created = await createCannedReply(ctx, { label: 'Intro', body: 'Hi there.' });
    await updateTemplate(ctx, created.id, { body: 'Hi, {{agent_name}} here.' });

    const replies = await withWorkspace(workspaceId, (tx) => listCannedReplies(tx, workspaceId));
    expect(replies).toEqual([{ id: created.id, label: 'Intro', body: 'Hi, {{agent_name}} here.' }]);
  });

  it('updateTemplate with isActive:false removes it from the active list', async () => {
    const workspaceId = await seedWorkspace();
    const ctx = await ctxFor(workspaceId);

    const created = await createCannedReply(ctx, { label: 'Intro', body: 'Hi there.' });
    await updateTemplate(ctx, created.id, { isActive: false });

    const replies = await withWorkspace(workspaceId, (tx) => listCannedReplies(tx, workspaceId));
    expect(replies).toEqual([]);
  });

  it('any write invalidates the Redis cache for that workspace', async () => {
    const workspaceId = await seedWorkspace();
    const ctx = await ctxFor(workspaceId);

    // Warm the cache
    await withWorkspace(workspaceId, (tx) => getSystemMessage(tx, workspaceId, 'no_agents_online'));
    expect(await getCachedTemplates(workspaceId)).not.toBeNull();

    await createSystemTemplate(ctx, { key: 'no_agents_online', body: 'New line.' });
    expect(await getCachedTemplates(workspaceId)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test templateService.test.ts`
Expected: FAIL — `createSystemTemplate`/`addHandoffVariant`/`createCannedReply`/`updateTemplate` are not exported.

- [ ] **Step 3: Write the implementation**

Append to `backend/src/domain/templates/templateService.ts`:

```typescript
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import { invalidateCachedTemplates } from './templateCache.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';

export type TemplateRowView = {
  id: string;
  kind: 'system' | 'canned';
  key: string | null;
  label: string | null;
  body: string;
  sort_order: number;
  is_active: boolean;
};

function toView(row: typeof messageTemplate.$inferSelect): TemplateRowView {
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    label: row.label,
    body: row.body,
    sort_order: row.sortOrder,
    is_active: row.isActive,
  };
}

/**
 * Singleton system keys (everything except 'handoff'): a new row replaces
 * the prior active one rather than adding a second, so getSystemMessage's
 * "first active row wins" never has to arbitrate between two live rows for
 * the same key.
 */
export async function createSystemTemplate(
  ctx: Pick<AgentContext, 'agentId' | 'workspaceId'>,
  args: { key: Exclude<SystemMessageKey, 'handoff'>; body: string },
): Promise<TemplateRowView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    await tx
      .update(messageTemplate)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(messageTemplate.workspaceId, ctx.workspaceId),
          eq(messageTemplate.kind, 'system'),
          eq(messageTemplate.key, args.key),
          eq(messageTemplate.isActive, true),
        ),
      );
    const [created] = await tx
      .insert(messageTemplate)
      .values({
        workspaceId: ctx.workspaceId,
        kind: 'system',
        key: args.key,
        body: args.body,
        sortOrder: 0,
        createdByAgentId: ctx.agentId,
      })
      .returning();
    await invalidateCachedTemplates(ctx.workspaceId);
    return toView(created!);
  });
}

export async function addHandoffVariant(
  ctx: Pick<AgentContext, 'agentId' | 'workspaceId'>,
  body: string,
): Promise<TemplateRowView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [maxRow] = await tx
      .select({ sortOrder: messageTemplate.sortOrder })
      .from(messageTemplate)
      .where(
        and(
          eq(messageTemplate.workspaceId, ctx.workspaceId),
          eq(messageTemplate.kind, 'system'),
          eq(messageTemplate.key, 'handoff'),
        ),
      )
      .orderBy(asc(messageTemplate.sortOrder))
      .limit(1);
    const [created] = await tx
      .insert(messageTemplate)
      .values({
        workspaceId: ctx.workspaceId,
        kind: 'system',
        key: 'handoff',
        body,
        sortOrder: (maxRow?.sortOrder ?? -1) + 1,
        createdByAgentId: ctx.agentId,
      })
      .returning();
    await invalidateCachedTemplates(ctx.workspaceId);
    return toView(created!);
  });
}

export async function createCannedReply(
  ctx: Pick<AgentContext, 'agentId' | 'workspaceId'>,
  args: { label: string; body: string },
): Promise<TemplateRowView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [maxRow] = await tx
      .select({ sortOrder: messageTemplate.sortOrder })
      .from(messageTemplate)
      .where(
        and(eq(messageTemplate.workspaceId, ctx.workspaceId), eq(messageTemplate.kind, 'canned')),
      )
      .orderBy(asc(messageTemplate.sortOrder))
      .limit(1);
    const [created] = await tx
      .insert(messageTemplate)
      .values({
        workspaceId: ctx.workspaceId,
        kind: 'canned',
        label: args.label,
        body: args.body,
        sortOrder: (maxRow?.sortOrder ?? -1) + 1,
        createdByAgentId: ctx.agentId,
      })
      .returning();
    await invalidateCachedTemplates(ctx.workspaceId);
    return toView(created!);
  });
}

export async function updateTemplate(
  ctx: Pick<AgentContext, 'workspaceId'>,
  id: string,
  patch: { body?: string; label?: string; isActive?: boolean },
): Promise<TemplateRowView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [updated] = await tx
      .update(messageTemplate)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(messageTemplate.id, id), eq(messageTemplate.workspaceId, ctx.workspaceId)))
      .returning();
    if (!updated) throw new Error('Template not found in this workspace');
    await invalidateCachedTemplates(ctx.workspaceId);
    return toView(updated);
  });
}
```

Note: this appended block introduces a second `import { withWorkspace } ...` etc. — when editing the real file, merge these into the single import block at the top rather than leaving two import statements.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test templateService.test.ts`
Expected: PASS (12 tests total)

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/templates/templateService.ts backend/tests/templateService.test.ts
git commit -m "feat: add template service write path with cache invalidation"
```

---

### Task 5: `/agent/templates` API router

**Files:**

- Create: `backend/src/agent/services/templatesAdminService.ts`
- Create: `backend/src/agent/controllers/templatesController.ts`
- Create: `backend/src/agent/routers/templatesRouter.ts`
- Modify: `backend/src/agent/router.ts` (register the router)
- Modify: `backend/src/docs/openapi.ts` (register the paths)
- Test: `backend/tests/agent.templates.test.ts`

**Interfaces:**

- Consumes: `createSystemTemplate`, `addHandoffVariant`, `createCannedReply`, `updateTemplate`, `loadTemplates`, `TemplateRowView` from `templateService.ts` (Tasks 3–4); `requireTeamLeadOrAdmin`, `requireAdminRole` middleware; `withWorkspace`.
- Produces: `GET /agent/templates`, `POST /agent/templates`, `PATCH /agent/templates/:id` — consumed by the frontend in Task 8.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/tests/agent.templates.test.ts
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
import { closeTemplateCacheRedis } from '../src/domain/templates/templateCache.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { templatesRouter } from '../src/agent/routers/templatesRouter.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, templatesRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeWsAuthRedis();
  await closeTemplateCacheRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function seedAgentWithRole(
  workspaceId: string,
  role: 'agent' | 'team_lead' | 'admin',
): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name, is_admin) values ($1, 'Test Agent', $2) returning id`,
    [`${role}-${Math.random().toString(36).slice(2)}@example.test`, role === 'admin'],
  );
  const agentId = rows[0]!.id;
  if (role !== 'admin') {
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, $3)`,
      [workspaceId, agentId, role],
    );
  }
  const token = await signAgentSession({ agent_id: agentId, is_admin: role === 'admin' });
  return { agentId, token };
}

describe('GET /templates', () => {
  it('returns default-backed system messages and an empty canned list for a fresh workspace', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');

    const res = await request(app)
      .get('/templates')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.system.no_agents_online.id).toBeNull();
    expect(typeof res.body.system.no_agents_online.body).toBe('string');
    expect(res.body.canned).toEqual([]);
  });

  it('forbids a plain agent', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .get('/templates')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(403);
  });
});

describe('POST /templates', () => {
  it('creates a canned reply for an admin', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post('/templates')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ kind: 'canned', label: 'Intro', body: 'Hi, this is {{agent_name}}.' })
      .expect(201);

    expect(res.body).toMatchObject({ kind: 'canned', label: 'Intro' });
  });

  it('forbids a team lead from writing', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');

    await request(app)
      .post('/templates')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ kind: 'canned', label: 'Intro', body: 'Hi.' })
      .expect(403);
  });

  it('rejects an unknown system key', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/templates')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ kind: 'system', key: 'not_a_real_key', body: 'x' })
      .expect(422);
  });
});

describe('PATCH /templates/:id', () => {
  it('edits a canned reply body for an admin', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const created = await request(app)
      .post('/templates')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ kind: 'canned', label: 'Intro', body: 'Hi.' })
      .expect(201);

    const res = await request(app)
      .patch(`/templates/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ body: 'Hello there.' })
      .expect(200);

    expect(res.body.body).toBe('Hello there.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test agent.templates.test.ts`
Expected: FAIL — `Cannot find module '../src/agent/routers/templatesRouter.ts'`

- [ ] **Step 3: Write the service, controller, and router**

```typescript
// backend/src/agent/services/templatesAdminService.ts
import { and, asc, eq } from 'drizzle-orm';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import { messageTemplate } from '../../shared/db/schema/index.ts';
import {
  addHandoffVariant,
  createCannedReply,
  createSystemTemplate,
  loadTemplates,
  updateTemplate,
  type SystemMessageKey,
  type TemplateRowView,
} from '../../domain/templates/templateService.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';

const SINGLETON_SYSTEM_KEYS = [
  'no_agents_online',
  'form_summary_completed',
  'form_summary_partial',
  'form_summary_skipped',
] as const;

export type TemplatesAdminView = {
  system: Record<
    SystemMessageKey,
    { id: string | null; body: string } | { id: string; body: string }[]
  >;
  canned: { id: string; label: string; body: string }[];
};

/**
 * Admin-facing view: singleton keys resolve to one {id, body} pair (id: null
 * means "still on the default, no row exists yet — POST to create the first
 * one"); handoff resolves to an array of real rows only (an admin adds a
 * first custom variant with POST rather than editing a synthetic default).
 *
 * loadTemplates() (Task 3) only returns bodies, shaped for the Redis cache —
 * the admin view additionally needs each row's real id to PATCH, so this
 * re-selects the raw rows directly rather than widening the cache payload's
 * shape for every hot-path reader just to serve this one admin screen.
 */
export async function getTemplatesForAdmin(ctx: AgentContext): Promise<TemplatesAdminView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const { system, canned } = await loadTemplates(tx, ctx.workspaceId);
    const dbRows = await tx
      .select()
      .from(messageTemplate)
      .where(
        and(eq(messageTemplate.workspaceId, ctx.workspaceId), eq(messageTemplate.isActive, true)),
      )
      .orderBy(asc(messageTemplate.sortOrder));

    const view: TemplatesAdminView = {
      system: {
        no_agents_online: { id: null, body: system.no_agents_online[0]! },
        form_summary_completed: { id: null, body: system.form_summary_completed[0]! },
        form_summary_partial: { id: null, body: system.form_summary_partial[0]! },
        form_summary_skipped: { id: null, body: system.form_summary_skipped[0]! },
        handoff: [],
      },
      canned,
    };
    for (const row of dbRows) {
      if (row.kind === 'system' && row.key && SINGLETON_SYSTEM_KEYS.includes(row.key as any)) {
        view.system[row.key as SystemMessageKey] = { id: row.id, body: row.body };
      } else if (row.kind === 'system' && row.key === 'handoff') {
        (view.system.handoff as { id: string; body: string }[]).push({
          id: row.id,
          body: row.body,
        });
      }
    }
    return view;
  });
}

export async function createTemplate(
  ctx: AgentContext,
  args:
    | { kind: 'system'; key: (typeof SINGLETON_SYSTEM_KEYS)[number]; body: string }
    | { kind: 'system'; key: 'handoff'; body: string }
    | { kind: 'canned'; label: string; body: string },
): Promise<TemplateRowView> {
  if (args.kind === 'canned') return createCannedReply(ctx, { label: args.label, body: args.body });
  if (args.key === 'handoff') return addHandoffVariant(ctx, args.body);
  return createSystemTemplate(ctx, { key: args.key, body: args.body });
}

export { updateTemplate as updateTemplateForAdmin, SINGLETON_SYSTEM_KEYS };
```

```typescript
// backend/src/agent/controllers/templatesController.ts
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import {
  createTemplate,
  getTemplatesForAdmin,
  updateTemplateForAdmin,
  SINGLETON_SYSTEM_KEYS,
} from '../services/templatesAdminService.ts';

export const getTemplatesHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await getTemplatesForAdmin(req.agent!));
};

const SYSTEM_KEYS = [...SINGLETON_SYSTEM_KEYS, 'handoff'] as const;

const CreateTemplateBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('system'), key: z.enum(SYSTEM_KEYS), body: z.string().min(1) }),
  z.object({ kind: z.literal('canned'), label: z.string().min(1), body: z.string().min(1) }),
]);

export const createTemplateHandler: RequestHandler = async (req, res) => {
  const body = CreateTemplateBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'kind, key/label, and a non-empty body are required.');
    return;
  }
  const created = await createTemplate(req.agent!, body.data as any);
  res.status(201).json(created);
};

const UpdateTemplateBody = z.object({
  body: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

export const updateTemplateHandler: RequestHandler = async (req, res) => {
  const body = UpdateTemplateBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'At least one of body, label, or isActive is required.');
    return;
  }
  const updated = await updateTemplateForAdmin(req.agent!, req.params.id!, body.data);
  res.status(200).json(updated);
};
```

```typescript
// backend/src/agent/routers/templatesRouter.ts
import { Router } from 'express';
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts';
import { requireTeamLeadOrAdmin } from '../../shared/middleware/requireTeamLeadOrAdmin.ts';
import {
  createTemplateHandler,
  getTemplatesHandler,
  updateTemplateHandler,
} from '../controllers/templatesController.ts';

/** Same read/write role split as botConfigRouter and workspaceSettingsRouter: Team Lead + Admin read, Admin only writes. */
export const templatesRouter = Router();
templatesRouter.get('/templates', requireTeamLeadOrAdmin, getTemplatesHandler);
templatesRouter.post('/templates', requireAdminRole, createTemplateHandler);
templatesRouter.patch('/templates/:id', requireAdminRole, updateTemplateHandler);
```

Register in `backend/src/agent/router.ts` — add the import near the other router imports and `agentRouter.use(templatesRouter);` next to `agentRouter.use(workspaceSettingsRouter);`.

- [ ] **Step 4: Register OpenAPI paths**

In `backend/src/docs/openapi.ts`, add after the `POST /agent/workspace-settings` registration (~line 2091):

```typescript
const TemplateRowSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['system', 'canned']),
  key: z.string().nullable(),
  label: z.string().nullable(),
  body: z.string(),
  sort_order: z.number().int(),
  is_active: z.boolean(),
});

registry.registerPath({
  method: 'get',
  path: '/agent/templates',
  summary: 'Agent List Message Templates',
  description:
    'Configurable system messages (no_agents_online, handoff variants, form summaries) and the workspace canned-reply library. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: {
    200: { description: 'Current templates, system messages default-backed when unset' },
    403: { description: 'Forbidden — Team Lead or Admin role required' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/templates',
  summary: 'Agent Create Message Template',
  description:
    'Creates a canned reply, adds a handoff variant, or replaces a singleton system message. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.union([
            z.object({
              kind: z.literal('system'),
              key: z.enum([
                'no_agents_online',
                'form_summary_completed',
                'form_summary_partial',
                'form_summary_skipped',
                'handoff',
              ]),
              body: z.string().min(1),
            }),
            z.object({
              kind: z.literal('canned'),
              label: z.string().min(1),
              body: z.string().min(1),
            }),
          ]),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'The created template row',
      content: { 'application/json': { schema: TemplateRowSchema } },
    },
    403: { description: 'Forbidden — admin role required' },
    422: { description: 'Missing or invalid kind/key/label/body' },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/templates/{id}',
  summary: 'Agent Update Message Template',
  description: 'Edits body/label, or deactivates a template (is_active:false). Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            body: z.string().min(1).optional(),
            label: z.string().min(1).optional(),
            isActive: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'The updated template row',
      content: { 'application/json': { schema: TemplateRowSchema } },
    },
    403: { description: 'Forbidden — admin role required' },
    422: { description: 'No recognised field to update' },
  },
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test agent.templates.test.ts`
Expected: PASS (6 tests)

Run: `pnpm typecheck`
Expected: exits 0

- [ ] **Step 6: Commit**

```bash
git add backend/src/agent/services/templatesAdminService.ts backend/src/agent/controllers/templatesController.ts backend/src/agent/routers/templatesRouter.ts backend/src/agent/router.ts backend/src/docs/openapi.ts backend/tests/agent.templates.test.ts
git commit -m "feat: add /agent/templates admin API"
```

---

### Task 6: Switch bot/forms call sites to the workspace-aware templates

**Files:**

- Modify: `backend/src/domain/bot/applyBotTurn.ts:4,144,243,258,294`
- Modify: `backend/src/domain/forms/completeFormAndHandoff.ts:15-16,131,177`
- Modify: `backend/src/surface/services/messagesService.ts:26,418`
- Modify: `backend/src/domain/bot/index.ts` (export the new service)

**Interfaces:**

- Consumes: `getSystemMessage`, `getHandoffMessage` from `backend/src/domain/templates/templateService.ts` (Task 3).
- Produces: no new exports — this task only rewires existing callers. `botFailureNote` stays untouched (it's not a template, it's an internal-only note built from `decision.reason`).

- [ ] **Step 1: Update `applyBotTurn.ts`**

Change the import on line 4 from:

```typescript
import { botFailureNote, pickHandoffMessage, NO_AGENTS_ONLINE_MESSAGE } from './messages.ts';
```

to:

```typescript
import { botFailureNote } from './messages.ts';
import { getHandoffMessage, getSystemMessage } from '../templates/templateService.ts';
```

Then, at each call site, thread `tx` and `ctx.workspaceId` through and await the result:

- Line 144: `body: pickHandoffMessage(),` → `body: await getHandoffMessage(tx, ctx.workspaceId),`
- Line 243: `body: NO_AGENTS_ONLINE_MESSAGE,` → `body: await getSystemMessage(tx, ctx.workspaceId, 'no_agents_online'),`
- Line 258: `body: pickHandoffMessage(),` → `body: await getHandoffMessage(tx, ctx.workspaceId),`
- Line 294: `body: NO_AGENTS_ONLINE_MESSAGE,` → `body: await getSystemMessage(tx, ctx.workspaceId, 'no_agents_online'),`

(Each of these sits inside an already-`async` function that's already being `await`-ed by its caller — `applyBotTurn` itself is `async`, and every branch already awaits `postMessage`, so no new `async` markers are needed.)

- [ ] **Step 2: Update `completeFormAndHandoff.ts`**

Change the imports on lines 15-16 from:

```typescript
import { formSummaryMessage } from './messages.ts';
import { NO_AGENTS_ONLINE_MESSAGE } from '../bot/messages.ts';
```

to:

```typescript
import { formSummaryMessage } from './messages.ts';
import { getSystemMessage } from '../templates/templateService.ts';
```

(`formSummaryMessage` stays a plain sync default-lookup, since form-summary messages are also configurable and go through the templates layer — see the next sub-step.)

Then:

- Line 131: `body: NO_AGENTS_ONLINE_MESSAGE,` → `body: await getSystemMessage(tx, ctx.workspaceId, 'no_agents_online'),`
- Line 177: `body: formSummaryMessage(formStatus),` → `body: await getSystemMessage(tx, ctx.workspaceId, \`form_summary_${formStatus}\` as const),`

Remove the now-unused `formSummaryMessage` import from line 15 (it's fully replaced by the templated call above).

- [ ] **Step 3: Update `messagesService.ts`**

Change the import on line 26 from `pickHandoffMessage,` to remove it from that `import { ... } from '../../domain/bot/index.ts'` list, and add:

```typescript
import { getHandoffMessage } from '../../domain/templates/templateService.ts';
```

Then at line 418: `body: pickHandoffMessage(),` → `body: await getHandoffMessage(tx, ctx.workspaceId),` (confirm the enclosing function is `async` and has `tx`/`ctx.workspaceId` in scope — it does, per the surrounding code already using `tx.select` and `ctx.workspaceId` throughout this file).

- [ ] **Step 4: Export the templates service from the bot domain barrel**

`messagesService.ts` currently imports `pickHandoffMessage` via `../../domain/bot/index.ts`. Since `getHandoffMessage` now lives in `domain/templates`, not `domain/bot`, this barrel re-export is unnecessary for this symbol — the Step 3 import already points directly at `domain/templates/templateService.ts`. No change needed to `backend/src/domain/bot/index.ts` for this task; skip this file.

- [ ] **Step 5: Run the full backend test suite**

Run: `pnpm test`
Expected: PASS — including `bot.messages.test.ts`, `bot.reopen.test.ts`, `resolution.crossPath.test.ts`, `surface.messages.test.ts`, `domain.resolutionAnswer.test.ts`, and `bot.turnSeam.test.ts`, all unmodified, because every workspace those tests seed has zero `message_template` rows and `getHandoffMessage`/`getSystemMessage` fall back to exactly `HANDOFF_PLAYER_MESSAGES`/`NO_AGENTS_ONLINE_MESSAGE` (see Task 3's `DEFAULT_SYSTEM_MESSAGES`).

If any of those six files fail, the likely cause is a missed `await` at one of the four call sites above — re-check each one compiles to `await getHandoffMessage(...)` / `await getSystemMessage(...)`, not a bare (unawaited) call.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: exits 0

- [ ] **Step 7: Commit**

```bash
git add backend/src/domain/bot/applyBotTurn.ts backend/src/domain/forms/completeFormAndHandoff.ts backend/src/surface/services/messagesService.ts
git commit -m "feat: route bot/form system messages through per-workspace templates"
```

---

### Task 7: Frontend API client — `agentApi.ts` additions

**Files:**

- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`

**Interfaces:**

- Consumes: the `call()` helper already defined in this file (same one `fetchWorkspaceSettings` uses).
- Produces: `TemplatesAdminView`, `TemplateRowView` types, `fetchTemplates(token)`, `createTemplate(token, args)`, `updateTemplate(token, id, patch)`. Task 8 (Templates page) and Task 9 (Composer) import these.

- [ ] **Step 1: Add the types and functions**

Append to `frontend/src/surfaces/agent-console/api/agentApi.ts`, after the `saveWorkspaceSettings` function:

```typescript
/**
 * Mirrors backend/src/agent/services/templatesAdminService.ts's TemplatesAdminView
 * and TemplateRowView. Local frontend-side contract, same convention as
 * WorkspaceSettingsView above — not sourced from @support/types.
 */
export type SystemMessageKey =
  'no_agents_online' | 'form_summary_completed' | 'form_summary_partial' | 'form_summary_skipped';

export type TemplateRowView = {
  id: string;
  kind: 'system' | 'canned';
  key: string | null;
  label: string | null;
  body: string;
  sort_order: number;
  is_active: boolean;
};

export type TemplatesAdminView = {
  system: {
    no_agents_online: { id: string | null; body: string };
    form_summary_completed: { id: string | null; body: string };
    form_summary_partial: { id: string | null; body: string };
    form_summary_skipped: { id: string | null; body: string };
    handoff: { id: string; body: string }[];
  };
  canned: { id: string; label: string; body: string }[];
};

export function fetchTemplates(token: string): Promise<TemplatesAdminView> {
  return call('/agent/templates', token);
}

export function createTemplate(
  token: string,
  args:
    | { kind: 'system'; key: SystemMessageKey | 'handoff'; body: string }
    | { kind: 'canned'; label: string; body: string },
): Promise<TemplateRowView> {
  return call('/agent/templates', token, { method: 'POST', body: JSON.stringify(args) });
}

export function updateTemplate(
  token: string,
  id: string,
  patch: { body?: string; label?: string; isActive?: boolean },
): Promise<TemplateRowView> {
  return call(`/agent/templates/${id}`, token, { method: 'PATCH', body: JSON.stringify(patch) });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter frontend typecheck` (or `pnpm typecheck` from repo root if that's the convention — check `package.json` scripts; `CLAUDE.md` lists `pnpm typecheck` as workspace-wide)
Expected: exits 0

- [ ] **Step 3: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts
git commit -m "feat: add templates API client functions"
```

---

### Task 8: Templates admin page + nav entry

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/Templates/Templates.tsx`
- Modify: `frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx`
- Modify: `frontend/src/surfaces/agent-console/lib/routePreload.ts`
- Modify: `frontend/src/routes/AppRoutes.tsx`

**Interfaces:**

- Consumes: `fetchTemplates`, `createTemplate`, `updateTemplate`, `TemplatesAdminView` from `agentApi.ts` (Task 7); `loadAgentSession`, `isAdmin` from `agentSession.ts`; `Button`, `Input` UI components (same as `WorkspaceSettings.tsx`).
- Produces: the `Templates` page component, `/templates` route, `Manage`-group nav entry.

- [ ] **Step 1: Write the page**

```tsx
// frontend/src/surfaces/agent-console/pages/Templates/Templates.tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createTemplate,
  fetchTemplates,
  updateTemplate,
  type SystemMessageKey,
  type TemplatesAdminView,
} from '../../api/agentApi.ts';
import { isAdmin, loadAgentSession } from '../../lib/agentSession.ts';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';

const SYSTEM_LABELS: Record<SystemMessageKey, string> = {
  no_agents_online: 'No agents online',
  form_summary_completed: 'Form completed',
  form_summary_partial: 'Form partially answered',
  form_summary_skipped: 'Form skipped',
};

export function Templates() {
  const session = loadAgentSession();
  const queryClient = useQueryClient();
  const readOnly = !isAdmin(session);

  const templatesQuery = useQuery({
    queryKey: ['templates'],
    queryFn: () => fetchTemplates(session!.token),
    enabled: session !== null,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['templates'] });

  const saveSystem = useMutation({
    mutationFn: ({ id, key, body }: { id: string | null; key: SystemMessageKey; body: string }) =>
      id
        ? updateTemplate(session!.token, id, { body })
        : createTemplate(session!.token, { kind: 'system', key, body }),
    onSuccess: invalidate,
  });

  const addHandoffVariant = useMutation({
    mutationFn: (body: string) =>
      createTemplate(session!.token, { kind: 'system', key: 'handoff', body }),
    onSuccess: invalidate,
  });

  const updateHandoffVariant = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      updateTemplate(session!.token, id, { body }),
    onSuccess: invalidate,
  });

  const removeHandoffVariant = useMutation({
    mutationFn: (id: string) => updateTemplate(session!.token, id, { isActive: false }),
    onSuccess: invalidate,
  });

  const addCannedReply = useMutation({
    mutationFn: ({ label, body }: { label: string; body: string }) =>
      createTemplate(session!.token, { kind: 'canned', label, body }),
    onSuccess: invalidate,
  });

  const updateCannedReply = useMutation({
    mutationFn: ({ id, label, body }: { id: string; label: string; body: string }) =>
      updateTemplate(session!.token, id, { label, body }),
    onSuccess: invalidate,
  });

  const removeCannedReply = useMutation({
    mutationFn: (id: string) => updateTemplate(session!.token, id, { isActive: false }),
    onSuccess: invalidate,
  });

  if (!session) return null;
  if (!templatesQuery.data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        {templatesQuery.isError ? 'Could not load templates.' : 'Loading…'}
      </div>
    );
  }

  const data: TemplatesAdminView = templatesQuery.data;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Templates</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-3">
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
            System Messages
          </h3>
          {(Object.keys(SYSTEM_LABELS) as SystemMessageKey[]).map((key) => (
            <SystemMessageEditor
              key={key}
              label={SYSTEM_LABELS[key]}
              row={data.system[key]}
              readOnly={readOnly}
              onSave={(body) => saveSystem.mutate({ id: data.system[key].id, key, body })}
            />
          ))}
          <HandoffEditor
            variants={data.system.handoff}
            readOnly={readOnly}
            onAdd={(body) => addHandoffVariant.mutate(body)}
            onUpdate={(id, body) => updateHandoffVariant.mutate({ id, body })}
            onRemove={(id) => removeHandoffVariant.mutate(id)}
          />
        </section>
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
            Canned Replies
          </h3>
          {data.canned.map((reply) => (
            <CannedReplyEditor
              key={reply.id}
              reply={reply}
              readOnly={readOnly}
              onUpdate={(label, body) => updateCannedReply.mutate({ id: reply.id, label, body })}
              onRemove={() => removeCannedReply.mutate(reply.id)}
            />
          ))}
          {!readOnly && (
            <NewCannedReplyForm onAdd={(label, body) => addCannedReply.mutate({ label, body })} />
          )}
        </section>
      </div>
    </div>
  );
}

function SystemMessageEditor({
  label,
  row,
  readOnly,
  onSave,
}: {
  label: string;
  row: { id: string | null; body: string };
  readOnly: boolean;
  onSave: (body: string) => void;
}) {
  const [value, setValue] = useState(row.body);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted">{label}</label>
      <div className="flex gap-2">
        <Input value={value} disabled={readOnly} onChange={(e) => setValue(e.target.value)} />
        <Button
          type="button"
          size="sm"
          disabled={readOnly || value === row.body}
          onClick={() => onSave(value)}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function HandoffEditor({
  variants,
  readOnly,
  onAdd,
  onUpdate,
  onRemove,
}: {
  variants: { id: string; body: string }[];
  readOnly: boolean;
  onAdd: (body: string) => void;
  onUpdate: (id: string, body: string) => void;
  onRemove: (id: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newVariant, setNewVariant] = useState('');
  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium text-muted">
        Handoff (picked at random — leave empty to use the built-in defaults)
      </label>
      {variants.map((variant) => (
        <div key={variant.id} className="flex gap-2">
          <Input
            value={drafts[variant.id] ?? variant.body}
            disabled={readOnly}
            onChange={(e) => setDrafts({ ...drafts, [variant.id]: e.target.value })}
          />
          <Button
            type="button"
            size="sm"
            disabled={readOnly || (drafts[variant.id] ?? variant.body) === variant.body}
            onClick={() => onUpdate(variant.id, drafts[variant.id] ?? variant.body)}
          >
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={readOnly}
            onClick={() => onRemove(variant.id)}
          >
            Remove
          </Button>
        </div>
      ))}
      {!readOnly && (
        <div className="flex gap-2">
          <Input
            placeholder="Add a variant…"
            value={newVariant}
            onChange={(e) => setNewVariant(e.target.value)}
          />
          <Button
            type="button"
            size="sm"
            disabled={newVariant.trim().length === 0}
            onClick={() => {
              onAdd(newVariant.trim());
              setNewVariant('');
            }}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

function CannedReplyEditor({
  reply,
  readOnly,
  onUpdate,
  onRemove,
}: {
  reply: { id: string; label: string; body: string };
  readOnly: boolean;
  onUpdate: (label: string, body: string) => void;
  onRemove: () => void;
}) {
  const [label, setLabel] = useState(reply.label);
  const [body, setBody] = useState(reply.body);
  const dirty = label !== reply.label || body !== reply.body;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-muted/20 p-2">
      <div className="flex gap-2">
        <Input
          className="max-w-48"
          value={label}
          disabled={readOnly}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Input value={body} disabled={readOnly} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={readOnly || !dirty}
          onClick={() => onUpdate(label, body)}
        >
          Save
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={readOnly} onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}

function NewCannedReplyForm({ onAdd }: { onAdd: (label: string, body: string) => void }) {
  const [label, setLabel] = useState('');
  const [body, setBody] = useState('');
  return (
    <div className="flex flex-col gap-1 rounded-md border border-dashed border-muted/40 p-2">
      <div className="flex gap-2">
        <Input
          className="max-w-48"
          placeholder="Label, e.g. Intro"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Input
          placeholder="Body — use {{agent_name}} for the agent's name"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      <Button
        type="button"
        size="sm"
        disabled={label.trim().length === 0 || body.trim().length === 0}
        onClick={() => {
          onAdd(label.trim(), body.trim());
          setLabel('');
          setBody('');
        }}
      >
        Add canned reply
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Add the nav entry**

In `AgentConsoleShell.tsx`, add near `WORKSPACE_SETTINGS_NAV_ITEM` (after its declaration, ~line 100):

```typescript
// Team Lead + Admin can read, same gate as Bot Config/Workspace Settings —
// only Admin can write, enforced client-side inside the page itself and again
// by the API on POST/PATCH.
const TEMPLATES_NAV_ITEM = {
  to: '/templates',
  label: 'Templates',
  icon: MessageSquare,
  group: 'Manage',
};
```

Add `MessageSquare` to the `lucide-react` import at the top of the file (it's already imported in `ThreadPanel.tsx` for a different purpose — just add it here too).

In the `navItems` array (~line 225-233), add `TEMPLATES_NAV_ITEM` after `WORKSPACE_SETTINGS_NAV_ITEM`:

```typescript
const navItems = canBuildForms(session)
  ? [
      ...NAV_ITEMS,
      FORMS_NAV_ITEM,
      WORKLOAD_NAV_ITEM,
      BOT_CONFIG_NAV_ITEM,
      WORKSPACE_SETTINGS_NAV_ITEM,
      TEMPLATES_NAV_ITEM,
    ]
  : NAV_ITEMS;
```

- [ ] **Step 3: Register the route**

In `frontend/src/surfaces/agent-console/lib/routePreload.ts`, add:

```typescript
export const importTemplates = () => import('../pages/Templates/Templates.tsx');
```

and in its `'/bot-config': importBotConfig,` map, add:

```typescript
'/templates': importTemplates,
```

In `frontend/src/routes/AppRoutes.tsx`:

- Add `importTemplates` to the destructured import from `routePreload.ts` (~line 15).
- Add `const TemplatesPage = lazy(async () => ({ default: (await importTemplates()).Templates }));` after the `WorkspaceSettingsPage` declaration (~line 45).
- Add the route after `workspace-settings` (~line 138):

```tsx
<Route
  path="templates"
  element={
    <RequireRole allow={canBuildForms}>
      <TemplatesPage />
    </RequireRole>
  }
/>
```

- [ ] **Step 4: Manual verification**

Run: `pnpm dev` (from repo root)
Then in a browser: log in as an admin, navigate to `/templates`, confirm the four system messages show their default text, add a handoff variant, add a canned reply, edit and remove it. Log in as a team lead (or use `isAdmin`-forcing test data) and confirm the fields are read-only. Log in as a plain agent and confirm the nav item is hidden and `/templates` redirects away.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Templates/Templates.tsx frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx frontend/src/surfaces/agent-console/lib/routePreload.ts frontend/src/routes/AppRoutes.tsx
git commit -m "feat: add Templates admin page and nav entry"
```

---

### Task 9: Composer — canned-reply picker with `{{agent_name}}` resolution

**Files:**

- Create: `frontend/src/features/chat/lib/resolveTemplateBody.ts`
- Create: `frontend/src/features/chat/lib/resolveTemplateBody.test.ts`
- Modify: `frontend/src/features/chat/components/Composer.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx`

**Interfaces:**

- Consumes: `fetchTemplates` from `agentApi.ts` (Task 7); `loadAgentSession` (already imported in `ThreadPanel.tsx`).
- Produces: `resolveTemplateBody(body: string, agentName: string): string`; a new optional `cannedReplies?: {id: string; label: string; body: string}[]` prop on `Composer`.

- [ ] **Step 1: Write the failing test for the resolver**

```typescript
// frontend/src/features/chat/lib/resolveTemplateBody.test.ts
import { describe, expect, it } from 'vitest';
import { resolveTemplateBody } from './resolveTemplateBody.ts';

describe('resolveTemplateBody', () => {
  it('replaces {{agent_name}} with the given name', () => {
    expect(resolveTemplateBody('Hi, this is {{agent_name}}.', 'Sam')).toBe('Hi, this is Sam.');
  });

  it('replaces every occurrence', () => {
    expect(resolveTemplateBody('{{agent_name}} here. — {{agent_name}}', 'Sam')).toBe(
      'Sam here. — Sam',
    );
  });

  it('leaves text with no placeholder untouched', () => {
    expect(resolveTemplateBody('Thanks for reaching out!', 'Sam')).toBe('Thanks for reaching out!');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter frontend test resolveTemplateBody`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// frontend/src/features/chat/lib/resolveTemplateBody.ts
/**
 * The only placeholder canned replies support today, matching the {{...}}
 * syntax backend/src/domain/bot/defaultPrompt.ts already uses for bot-prompt
 * placeholders ({{subintents}}, {{articles}}, etc.) — kept consistent rather
 * than introducing a second syntax. Resolved client-side, never stored
 * resolved: the stored template body always keeps the literal placeholder.
 */
export function resolveTemplateBody(body: string, agentName: string): string {
  return body.replaceAll('{{agent_name}}', agentName);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter frontend test resolveTemplateBody`
Expected: PASS (3 tests)

- [ ] **Step 5: Add the picker to `Composer`**

In `frontend/src/features/chat/components/Composer.tsx`, add to `ComposerProps` (after `onCancelUpload`):

```typescript
  /** Only the agent console passes this — the player surface's usage omits it. Bodies are already {{agent_name}}-resolved by the caller. */
  cannedReplies?: { id: string; label: string; body: string }[];
```

Destructure it in the function signature: add `cannedReplies,` after `onCancelUpload,`.

Add a `NotebookText` (or similar) icon import from `lucide-react` at the top, next to `Paperclip, X`.

Add the picker button in the toolbar row, right before the `allowAttachments && (...)` block (~line 189):

```tsx
{
  cannedReplies && cannedReplies.length > 0 && (
    <div className="relative">
      <button
        type="button"
        onClick={() => setTemplatesOpen((open) => !open)}
        className="flex size-9 shrink-0 items-center justify-center rounded-md border border-muted/20 text-muted"
        aria-label="Insert template"
        aria-expanded={templatesOpen}
      >
        <NotebookText className="size-4" />
      </button>
      {templatesOpen && (
        <div className="absolute bottom-full left-0 mb-1 w-64 rounded-md border border-muted/20 bg-bg p-1 shadow-md">
          {cannedReplies.map((reply) => (
            <button
              key={reply.id}
              type="button"
              onClick={() => {
                setValue(reply.body);
                setTemplatesOpen(false);
              }}
              className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent-soft"
            >
              {reply.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

Add the state hook near the other `useState` calls at the top of the component: `const [templatesOpen, setTemplatesOpen] = useState(false);`.

Note: clicking a template **replaces** the composer's current draft (`setValue(reply.body)`), matching "click it and the intro message drops in" — it does not append to existing text.

- [ ] **Step 6: Wire it up in `ThreadPanel.tsx`**

Add the fetch (near the other `useQuery` calls in the file — find where `session` and `token` are already in scope):

```typescript
import { fetchTemplates } from '../../../api/agentApi.ts';
import { resolveTemplateBody } from '../../../../../features/chat/lib/resolveTemplateBody.ts';
```

```typescript
const templatesQuery = useQuery({
  queryKey: ['canned-replies'],
  queryFn: () => fetchTemplates(token),
  enabled: session !== null,
  select: (data) =>
    data.canned.map((reply) => ({
      id: reply.id,
      label: reply.label,
      body: resolveTemplateBody(reply.body, session!.displayName),
    })),
});
```

Pass it to `<Composer ... cannedReplies={templatesQuery.data ?? []} ... />` alongside the existing `allowVisibilityToggle`/`allowAttachments` props (~line 611-613).

- [ ] **Step 7: Manual verification**

Run: `pnpm dev`, open an active conversation as an agent with at least one canned reply configured (added in Task 8's manual check), click the new template-picker button in the composer, confirm the label list appears, click one, confirm the composer text box now shows the body with `{{agent_name}}` replaced by the logged-in agent's display name, and that clicking Send still requires an explicit click (no auto-send).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/features/chat/lib/resolveTemplateBody.ts frontend/src/features/chat/lib/resolveTemplateBody.test.ts frontend/src/features/chat/components/Composer.tsx frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx
git commit -m "feat: add canned-reply picker to the chat composer"
```

---

### Task 10: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full backend suite**

Run: `pnpm test` (from repo root, requires Postgres + Redis up per `pnpm dev`/`docker-compose.yml`)
Expected: all suites PASS, including every file touched or added in Tasks 1–6.

- [ ] **Step 2: Full typecheck**

Run: `pnpm typecheck`
Expected: exits 0

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: exits 0 (or only pre-existing warnings unrelated to this feature — do not silence a real new lint error with a disable comment; fix it)

- [ ] **Step 4: Frontend test suite**

Run: `pnpm --filter frontend test`
Expected: PASS, including `resolveTemplateBody.test.ts`

- [ ] **Step 5: OpenAPI sanity check**

Run: `pnpm dev` (or start just the backend), then open `http://localhost:4000/docs`
Expected: `GET/POST /agent/templates` and `PATCH /agent/templates/{id}` appear with the descriptions and schemas from Task 5.

No commit for this task — it's verification of everything already committed in Tasks 1–9.
