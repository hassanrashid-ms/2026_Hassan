# Bot Config Routes and Change-Log Read API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the already-built `bot_config` domain functions and `change_log` audit writer behind three role-gated HTTP endpoints — read the resolved config, save it, and read its audit trail newest-first — so the admin console has an API to build against.

**Architecture:** A thin agent-surface module in the established four-layer shape: `routers/` (paths + middleware) → `controllers/` (Zod parse, HTTP status mapping) → `services/` (one `withWorkspace` transaction each, calling the existing `resolveBotConfig` / `saveBotConfig`) plus one generic read helper next to the existing writer (`shared/changeLog/readChangeLog.ts`) and a keyset-cursor util. **No new business rules and no new tables.** The domain layer (`backend/src/domain/bot/`, `backend/src/shared/changeLog/appendChangeLog.ts`) already owns prompt/rules resolution, empty-value rejection, the upsert, the one-transaction audit guarantee and no-op dropping; this slice must not reimplement or bypass any of it.

**Tech Stack:** Express 5 + TypeScript (native `.ts` ESM imports, extensions included), Zod 4, Drizzle ORM, PostgreSQL 17 with RLS, Vitest + supertest, `@asteasolutions/zod-to-openapi`.

**Source spec:** `docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md` (Status: Accepted). The data-model half is **already implemented** (`docs/plans/2026-08-11-bot-config-and-audit.md`, complete). This plan implements the read/write HTTP surface that spec deferred: the "audit-trail read API" it listed as out of scope, and the routes for `resolveBotConfig` / `saveBotConfig`.

## Global Constraints

- **No new tables, columns, enums or migrations.** `bot_config` and `change_log` exist. If a task seems to need a schema change, the task is wrong.
- **Never insert into `change_log` outside `appendChangeLog`.** This slice only _reads_ it.
- **Never write `bot_config` outside `saveBotConfig`.** No route may `tx.insert(botConfig)` or `tx.update(botConfig)` itself. A config change with no audit row must stay impossible.
- **Never join `prompt` and `rules` at a call site.** `resolveBotConfig` already returns `systemPrompt` from `buildSystemPrompt`. Do not concatenate them in a controller, a serializer, or a test expectation.
- **Empty/whitespace prompt or rules is the domain's rejection, not Zod's.** The request schemas accept any string so `EmptyBotPrompt` — which names the offending column — is what reaches the client. A `z.string().min(1)` would swallow the field name.
- **Audited field names are column names** — `is_provisioned`, `prompt`, `rules`. The history response returns them verbatim, never mapped to API names.
- **CORS allows only `GET` and `POST`** (`backend/src/app.ts`). The save endpoint is `POST`, not `PUT`/`PATCH`. Do not widen the CORS `methods` array.
- **Roles come from the permission matrix in `docs/project-overview.md` §Roles and permissions, and it splits read from write.** Two rows govern this slice:
  - _"See bot config · trigger manual sync"_ — Agent ·, Team Lead ✓, Admin ✓
  - _"Edit bot prompt or rules · provision or disable bot"_ — Agent ·, Team Lead ·, **Admin ✓**

  So the two `GET`s are **Team Lead or Admin**, and the `POST` is **Admin only**. A plain agent gets `403` on all three. Do not gate the reads with `requireAdminRole` — that would deny a Team Lead a capability the matrix grants them. **A permission is never granted to an individual**, only to a role.

- **`team_lead` exists in the `workspace_role` enum but no middleware handles it yet** — `requireAdminRole` matches `'admin'` exactly. This slice adds the role-set middleware it needs (Task 4) rather than loosening `requireAdminRole`, which two `POST /agent/intents*` routes depend on staying admin-exact.
- Permission checks run at the API; hiding a control in the UI is not enforcement. Role is re-read from `workspace_member` on every request, not carried in the session JWT, so a demotion takes effect on the next request rather than at token expiry.
- **Every scoped read goes through `withWorkspace(ctx.workspaceId, …)`** and names its workspace in the predicate. `agent` is unscoped, so joining it for actor display names needs no policy consideration.
- **`change_log.id` is `bigserial` with Drizzle `mode: 'bigint'`, so it arrives as a JS `bigint`.** `JSON.stringify` throws on `bigint` — `TypeError: Do not know how to serialize a BigInt`. Every id that leaves a service must already be a `string`. This is the one non-obvious failure in this slice.
- **Expect `404`, not `403`, from RLS.** But a role failure _is_ `403` — that distinction belongs to the role middleware, and it is fine.
- **No hard deletes, no new delete route.**
- **Register every new endpoint in `backend/src/docs/openapi.ts`.** Non-negotiable per `CLAUDE.md`.
- Never `console.*`. Use `logger` from `backend/src/shared/logging/logger.ts` (nothing here needs a log line).
- Imports carry the `.ts` extension (`from '../services/botConfigService.ts'`). Follow the existing files exactly.
- All commands run from the repo root: `/Users/hassanrashid/Desktop/git/mindstorm/crm/app`. Postgres and Redis must be up (`docker compose up -d`) for any DB-touching test.
- Single-file test command: `pnpm --filter @support/api test tests/<file>.test.ts`. Types-package tests: `pnpm --filter @support/types test`.

---

## File Structure

| File                                                    | Action | Responsibility                                                                                                                                       |
| ------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/types/src/bot.ts`                             | create | `SaveBotConfigBody`, `ChangeLogHistoryQuery`, and the response view types shared by server + console                                                 |
| `packages/types/src/index.ts`                           | modify | one `export *` line                                                                                                                                  |
| `backend/src/shared/changeLog/cursor.ts`                | create | opaque keyset cursor encode/decode — `(changed_at, id)`, no SQL, no DB                                                                               |
| `backend/src/shared/changeLog/readChangeLog.ts`         | create | the generic newest-first read of `change_log` with its actor joined; lives next to `appendChangeLog` so the index knowledge stays with the table     |
| `backend/src/shared/middleware/requireWorkspaceRole.ts` | create | `requireWorkspaceRole(...roles)` — one role-set gate, replacing the copy-paste `requireAdminRole` would otherwise become                             |
| `backend/src/shared/middleware/requireAdminRole.ts`     | modify | re-expressed as `requireWorkspaceRole('admin')`; the export name and behaviour are unchanged, so the two taxonomy routes that import it need no edit |
| `backend/src/agent/services/botConfigService.ts`        | create | three functions, one transaction each: `getBotConfigView`, `saveBotConfigForAgent`, `listBotConfigHistory`                                           |
| `backend/src/agent/controllers/botConfigController.ts`  | create | Zod parse, `EmptyBotPrompt` → 422, response shaping                                                                                                  |
| `backend/src/agent/routers/botConfigRouter.ts`          | create | three paths: reads behind Team Lead+Admin, the save behind Admin                                                                                     |
| `backend/src/agent/router.ts`                           | modify | one import + one `agentRouter.use(botConfigRouter)`                                                                                                  |
| `backend/src/docs/openapi.ts`                           | modify | three `registry.registerPath` calls                                                                                                                  |
| `packages/types/tests/bot.test.ts`                      | create | request-schema parsing rules                                                                                                                         |
| `backend/tests/changeLog.cursor.test.ts`                | create | cursor round-trip and rejection of junk                                                                                                              |
| `backend/tests/changeLog.read.test.ts`                  | create | `readChangeLog` ordering, paging, actor join, tenancy, bigint→string                                                                                 |
| `backend/tests/auth.workspaceRole.test.ts`              | create | the role-set middleware, including the `team_lead` case nothing exercises today                                                                      |
| `backend/tests/agent.botConfig.test.ts`                 | create | the three endpoints end to end through the real middleware, per role                                                                                 |

Nothing in `backend/src/domain/bot/`, `backend/src/shared/changeLog/appendChangeLog.ts`, `backend/src/shared/db/schema/`, or `002_rls.sql` is edited by this plan.

### Endpoint summary

| Method | Path                        | Roles            | Purpose                                                                            |
| ------ | --------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `GET`  | `/agent/bot-config`         | Team Lead, Admin | The resolved config + which fields are customised + `updated_at`                   |
| `POST` | `/agent/bot-config`         | **Admin only**   | Partial save; returns the same shape as the GET                                    |
| `GET`  | `/agent/bot-config/history` | Team Lead, Admin | The `change_log` trail for this workspace's bot config, newest first, cursor-paged |

The `history` row is not in the permission matrix by name. It is filed under _"See bot config"_ rather than gated to Admin: it is a read of that same config's past values, and the matrix already grants a Team Lead an agent-attributed read in _"View per-agent workload"_. A Team Lead who can see the current prompt learns nothing new by seeing the previous one.

---

### Task 1: Shared request/response contract

**Files:**

- Create: `packages/types/src/bot.ts`
- Modify: `packages/types/src/index.ts`
- Test: `packages/types/tests/bot.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `SaveBotConfigBody` (Zod schema), `ChangeLogHistoryQuery` (Zod schema), and types `BotConfigView`, `ChangeLogActorView`, `ChangeLogEntryView`, `ChangeLogHistoryResponse`. Exact shapes in Step 3.

> `packages/types` has no `tests/` directory yet — this task creates it. `vitest` is already a devDependency of the package and `pnpm --filter @support/types test` already runs `vitest run`, which picks up `tests/*.test.ts` by default. No config file is needed.

- [ ] **Step 1: Write the failing test**

Create `packages/types/tests/bot.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ChangeLogHistoryQuery, SaveBotConfigBody } from '../src/bot.ts';

describe('SaveBotConfigBody', () => {
  it('accepts a single field on its own', () => {
    expect(SaveBotConfigBody.safeParse({ is_provisioned: true }).success).toBe(true);
    expect(SaveBotConfigBody.safeParse({ prompt: 'Be helpful.' }).success).toBe(true);
    expect(SaveBotConfigBody.safeParse({ rules: 'Never promise a refund.' }).success).toBe(true);
  });

  it('accepts explicit null as a reset for prompt and rules', () => {
    const parsed = SaveBotConfigBody.safeParse({ prompt: null, rules: null });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ prompt: null, rules: null });
  });

  it('rejects an empty body — a save that changes nothing is a client bug', () => {
    expect(SaveBotConfigBody.safeParse({}).success).toBe(false);
  });

  // The domain owns this rejection: EmptyBotPrompt names the offending column,
  // and a schema-level min(1) would replace that with a generic field error.
  it('lets a whitespace-only prompt through to the domain', () => {
    expect(SaveBotConfigBody.safeParse({ prompt: '   ' }).success).toBe(true);
  });

  it('rejects a wrong type and an unknown key', () => {
    expect(SaveBotConfigBody.safeParse({ is_provisioned: 'yes' }).success).toBe(false);
    expect(SaveBotConfigBody.safeParse({ is_provisioned: true, nope: 1 }).success).toBe(false);
  });

  it('rejects null for is_provisioned — there is no "unset" bot switch', () => {
    expect(SaveBotConfigBody.safeParse({ is_provisioned: null }).success).toBe(false);
  });
});

describe('ChangeLogHistoryQuery', () => {
  it('defaults limit to 50 when absent', () => {
    const parsed = ChangeLogHistoryQuery.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.cursor).toBeUndefined();
  });

  it('coerces a string limit, because query strings are strings', () => {
    expect(ChangeLogHistoryQuery.parse({ limit: '10' }).limit).toBe(10);
  });

  it('rejects a limit outside 1..200 and a non-integer limit', () => {
    expect(ChangeLogHistoryQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(ChangeLogHistoryQuery.safeParse({ limit: '201' }).success).toBe(false);
    expect(ChangeLogHistoryQuery.safeParse({ limit: '1.5' }).success).toBe(false);
  });

  it('keeps an opaque cursor as an unvalidated string', () => {
    expect(ChangeLogHistoryQuery.parse({ cursor: 'abc' }).cursor).toBe('abc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/types test`
Expected: FAIL — `Failed to resolve import "../src/bot.ts"`.

- [ ] **Step 3: Write the schemas and view types**

Create `packages/types/src/bot.ts`:

```ts
import { z } from 'zod';

/**
 * NOT part of the frozen SDK contract — ships with the server, same as
 * articles.ts. Shared by the agent console and OpenAPI.
 */

/**
 * A partial save: an omitted key means "leave this field alone", and an explicit
 * null on `prompt` / `rules` means "reset to the default". That is exactly the
 * `BotConfigSave` contract in backend/src/domain/bot/botConfig.ts, so the two
 * cannot drift.
 *
 * No `.min(1)` on the two text fields, deliberately: an empty or whitespace-only
 * value is rejected by the domain's `EmptyBotPrompt`, which names the offending
 * COLUMN so a rules edit is never reported as a prompt error. A schema-level
 * length rule would replace that message with a generic one.
 *
 * `.strict()` so a typo'd key is a 422 rather than a silently ignored no-op save
 * that still writes an audit-free success response.
 */
export const SaveBotConfigBody = z
  .object({
    is_provisioned: z.boolean().optional(),
    prompt: z.string().nullable().optional(),
    rules: z.string().nullable().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.is_provisioned !== undefined || body.prompt !== undefined || body.rules !== undefined,
    { message: 'At least one of is_provisioned, prompt or rules is required.' },
  );
export type SaveBotConfigBodyValue = z.infer<typeof SaveBotConfigBody>;

/**
 * `limit` is coerced because Express query values are always strings. The 200 cap
 * is the page ceiling; `cursor` is opaque and is validated by the server's cursor
 * decoder, not here — its format is not part of the contract.
 */
export const ChangeLogHistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});
export type ChangeLogHistoryQueryValue = z.infer<typeof ChangeLogHistoryQuery>;

/**
 * `prompt` and `rules` are always populated — the resolver substitutes the
 * defaults — and `system_prompt` is the buildSystemPrompt join, the only string
 * the bot is actually sent. The two `*_customized` flags are how the console
 * knows whether to offer a "reset to default" control: they report whether the
 * stored COLUMN is non-null, which is a different question from whether the
 * resolved value happens to equal the default.
 *
 * `updated_at` is null when no row exists yet (nothing has ever been saved).
 */
export type BotConfigView = {
  is_provisioned: boolean;
  prompt: string;
  rules: string;
  system_prompt: string;
  is_prompt_customized: boolean;
  is_rules_customized: boolean;
  updated_at: string | null;
};

export type ChangeLogActorView = { id: string; display_name: string; email: string };

/**
 * `field` is the COLUMN name — 'is_provisioned' | 'prompt' | 'rules' — never an
 * API field name, so the trail stays readable against the schema.
 *
 * `before_value` null means the field had no value before (first time it was ever
 * set); `after_value` null means it was cleared back to the default. The two nulls
 * are different facts and must not be collapsed on display.
 *
 * `id` is a string because change_log.id is a bigserial: a JSON number cannot
 * hold it safely and a JS bigint cannot be serialised at all.
 */
export type ChangeLogEntryView = {
  id: string;
  field: string;
  before_value: unknown;
  after_value: unknown;
  actor: ChangeLogActorView;
  changed_at: string;
};

/** `next_cursor` null means this is the last page. */
export type ChangeLogHistoryResponse = {
  entries: ChangeLogEntryView[];
  next_cursor: string | null;
};
```

- [ ] **Step 4: Export it from the package barrel**

Modify `packages/types/src/index.ts` — append one line, matching the existing style:

```ts
export * from './bot.ts';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @support/types test`
Expected: PASS — all cases in `tests/bot.test.ts`.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/bot.ts packages/types/src/index.ts packages/types/tests/bot.test.ts
git commit -m "feat(types): bot config request schemas and audit view types"
```

---

### Task 2: The keyset cursor util

**Files:**

- Create: `backend/src/shared/changeLog/cursor.ts`
- Test: `backend/tests/changeLog.cursor.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `export type ChangeLogCursor = { changedAt: Date; id: string }`
  - `export function encodeChangeLogCursor(cursor: ChangeLogCursor): string`
  - `export function decodeChangeLogCursor(raw: string): ChangeLogCursor | null` — `null` for anything unparseable, never a throw.

**Why a cursor and not an offset:** `change_log` only grows and is read newest-first. An `OFFSET` page shifts under a concurrent insert, so a row is silently skipped between pages. The sort key is the pair `(changed_at, id)` — `changed_at` alone is not unique (it is transaction start time, so every row written by one save shares it), and `id` alone is not the requested order.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/changeLog.cursor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeChangeLogCursor, encodeChangeLogCursor } from '../src/shared/changeLog/cursor.ts';

describe('change log cursor', () => {
  it('round-trips a timestamp and a bigserial id', () => {
    const changedAt = new Date('2026-08-12T10:20:30.456Z');
    const encoded = encodeChangeLogCursor({ changedAt, id: '9007199254740993' });
    const decoded = decodeChangeLogCursor(encoded);
    expect(decoded).toEqual({ changedAt, id: '9007199254740993' });
  });

  it('is opaque — no readable timestamp in the token', () => {
    const encoded = encodeChangeLogCursor({
      changedAt: new Date('2026-08-12T10:20:30.456Z'),
      id: '1',
    });
    expect(encoded).not.toContain('2026');
    expect(encoded).not.toContain('|');
  });

  it('is url-safe', () => {
    for (let id = 1; id <= 40; id += 1) {
      const encoded = encodeChangeLogCursor({
        changedAt: new Date(1_760_000_000_000 + id),
        id: String(id),
      });
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('returns null for junk rather than throwing', () => {
    expect(decodeChangeLogCursor('')).toBeNull();
    expect(decodeChangeLogCursor('not-base64!!')).toBeNull();
    expect(decodeChangeLogCursor(Buffer.from('only-one-part').toString('base64url'))).toBeNull();
    expect(decodeChangeLogCursor(Buffer.from('nope|1').toString('base64url'))).toBeNull();
    expect(
      decodeChangeLogCursor(Buffer.from('2026-08-12T10:20:30.456Z|abc').toString('base64url')),
    ).toBeNull();
  });

  it('returns null for a negative or oversized id', () => {
    expect(
      decodeChangeLogCursor(Buffer.from('2026-08-12T10:20:30.456Z|-1').toString('base64url')),
    ).toBeNull();
    expect(
      decodeChangeLogCursor(
        Buffer.from(`2026-08-12T10:20:30.456Z|${'9'.repeat(40)}`).toString('base64url'),
      ),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test tests/changeLog.cursor.test.ts`
Expected: FAIL — cannot resolve `../src/shared/changeLog/cursor.ts`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/shared/changeLog/cursor.ts`:

```ts
/**
 * The paging key for `change_log`, which is read newest-first by
 * (changed_at desc, id desc).
 *
 * Both halves are needed. `changed_at` is transaction start time, so every row a
 * single save writes shares one value — it is not unique. `id` alone is unique but
 * is not the requested order. The pair is a total order.
 *
 * `id` is carried as a string: it is a bigserial, so a JS number cannot hold it
 * safely and a JS bigint cannot be JSON-serialised.
 */
export type ChangeLogCursor = { changedAt: Date; id: string };

/** Digits only, and short enough that Postgres cannot overflow bigint on the cast. */
const ID_PATTERN = /^\d{1,19}$/;

/**
 * base64url of `<iso>|<id>`. Opaque on purpose: the format is not part of the API
 * contract, so paging can change shape later without a client change. Not
 * encryption — it hides nothing a caller could not already see in the response.
 */
export function encodeChangeLogCursor(cursor: ChangeLogCursor): string {
  return Buffer.from(`${cursor.changedAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

/**
 * Returns null for anything unparseable instead of throwing: a bad cursor is a
 * client mistake that the controller answers with a 422, and a decoder that
 * throws would turn a stale bookmark into a 500.
 */
export function decodeChangeLogCursor(raw: string): ChangeLogCursor | null {
  if (raw.length === 0 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;

  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator === -1) return null;

  const iso = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!ID_PATTERN.test(id)) return null;

  const changedAt = new Date(iso);
  if (Number.isNaN(changedAt.getTime())) return null;

  return { changedAt, id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/api test tests/changeLog.cursor.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/shared/changeLog/cursor.ts backend/tests/changeLog.cursor.test.ts
git commit -m "feat(changelog): opaque keyset cursor for the audit read path"
```

---

### Task 3: `readChangeLog` — the generic read

**Files:**

- Create: `backend/src/shared/changeLog/readChangeLog.ts`
- Test: `backend/tests/changeLog.read.test.ts`

**Interfaces:**

- Consumes: `Tx` from `backend/src/shared/db/withWorkspace.ts`; `changeLog` and `agent` from `backend/src/shared/db/schema/index.ts`; `ChangeLogCursor`, `encodeChangeLogCursor` from Task 2.
- Produces:
  ```ts
  export type ChangeLogRow = {
    id: string;
    field: string;
    beforeValue: unknown;
    afterValue: unknown;
    changedAt: Date;
    actor: { id: string; displayName: string; email: string };
  };
  export type ReadChangeLogInput = {
    workspaceId: string;
    entityType: string;
    entityId: string;
    limit: number;
    cursor?: ChangeLogCursor;
  };
  export type ChangeLogPage = { rows: ChangeLogRow[]; nextCursor: string | null };
  export async function readChangeLog(tx: Tx, input: ReadChangeLogInput): Promise<ChangeLogPage>;
  ```

**Why it lives beside `appendChangeLog` and not in the agent service:** the table's read path is `INDEX (workspace_id, entity_type, entity_id, changed_at)`. Keeping the query that must match that index in the same folder as the writer means the next audited entity reuses it instead of hand-rolling a second query that misses the index. It stays entity-agnostic — `entityType` is a parameter, and this slice's only caller passes `BOT_CONFIG_ENTITY_TYPE`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/changeLog.read.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { appendChangeLog } from '../src/shared/changeLog/appendChangeLog.ts';
import { readChangeLog } from '../src/shared/changeLog/readChangeLog.ts';
import { decodeChangeLogCursor } from '../src/shared/changeLog/cursor.ts';
import { closeOwnerPool, ownerPool, seedAgent, seedWorkspace, truncateAll } from './helpers/db.ts';

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

const ENTITY = 'bot_config';

/** Two saves' worth of audit rows, written in two transactions so changed_at differs. */
async function seedTrail(workspaceId: string, actorId: string): Promise<void> {
  await withWorkspace(workspaceId, (tx) =>
    appendChangeLog(tx, {
      workspaceId,
      entityType: ENTITY,
      entityId: workspaceId,
      actorId,
      changes: [
        { field: 'is_provisioned', before: false, after: true },
        { field: 'prompt', before: null, after: 'First prompt' },
      ],
    }),
  );
  await withWorkspace(workspaceId, (tx) =>
    appendChangeLog(tx, {
      workspaceId,
      entityType: ENTITY,
      entityId: workspaceId,
      actorId,
      changes: [{ field: 'prompt', before: 'First prompt', after: null }],
    }),
  );
}

describe('readChangeLog', () => {
  it('returns newest first, with the actor joined and the id as a string', async () => {
    const workspaceId = await seedWorkspace();
    const actorId = await seedAgent('auditor@example.test');
    await seedTrail(workspaceId, actorId);

    const page = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, { workspaceId, entityType: ENTITY, entityId: workspaceId, limit: 50 }),
    );

    expect(page.rows).toHaveLength(3);
    expect(page.rows[0]!.field).toBe('prompt');
    expect(page.rows[0]!.beforeValue).toBe('First prompt');
    expect(page.rows[0]!.afterValue).toBeNull();
    expect(typeof page.rows[0]!.id).toBe('string');
    expect(page.rows[0]!.actor).toEqual({
      id: actorId,
      displayName: 'Test Agent',
      email: 'auditor@example.test',
    });
    expect(page.nextCursor).toBeNull();
  });

  // The bug this guards: change_log.id is a bigserial mapped as a JS bigint, and
  // JSON.stringify throws on a bigint. A service returning it raw would 500.
  it('produces a page that JSON.stringify can serialise', async () => {
    const workspaceId = await seedWorkspace();
    const actorId = await seedAgent();
    await seedTrail(workspaceId, actorId);

    const page = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, { workspaceId, entityType: ENTITY, entityId: workspaceId, limit: 50 }),
    );

    expect(() => JSON.stringify(page)).not.toThrow();
  });

  it('pages with the cursor and never repeats or skips a row', async () => {
    const workspaceId = await seedWorkspace();
    const actorId = await seedAgent();
    await seedTrail(workspaceId, actorId);

    const first = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, { workspaceId, entityType: ENTITY, entityId: workspaceId, limit: 2 }),
    );
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const cursor = decodeChangeLogCursor(first.nextCursor!)!;
    const second = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, {
        workspaceId,
        entityType: ENTITY,
        entityId: workspaceId,
        limit: 2,
        cursor,
      }),
    );

    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.rows, ...second.rows].map((row) => row.id);
    expect(new Set(ids).size).toBe(3);
  });

  // changed_at is transaction start time, so both rows from one save share it.
  // A cursor on changed_at alone would drop the second one.
  it('pages correctly through rows that share one changed_at', async () => {
    const workspaceId = await seedWorkspace();
    const actorId = await seedAgent();
    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: ENTITY,
        entityId: workspaceId,
        actorId,
        changes: [
          { field: 'is_provisioned', before: false, after: true },
          { field: 'prompt', before: null, after: 'p' },
          { field: 'rules', before: null, after: 'r' },
        ],
      }),
    );

    const first = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, { workspaceId, entityType: ENTITY, entityId: workspaceId, limit: 1 }),
    );
    const second = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, {
        workspaceId,
        entityType: ENTITY,
        entityId: workspaceId,
        limit: 5,
        cursor: decodeChangeLogCursor(first.nextCursor!)!,
      }),
    );

    expect(second.rows).toHaveLength(2);
    expect(first.rows[0]!.changedAt.getTime()).toBe(second.rows[0]!.changedAt.getTime());
    expect(second.rows.map((row) => row.id)).not.toContain(first.rows[0]!.id);
  });

  it('sees nothing from another workspace', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const actorId = await seedAgent();
    await seedTrail(workspaceB, actorId);

    const page = await withWorkspace(workspaceA, (tx) =>
      readChangeLog(tx, {
        workspaceId: workspaceA,
        entityType: ENTITY,
        entityId: workspaceB,
        limit: 50,
      }),
    );

    expect(page.rows).toEqual([]);
  });

  it('filters by entity_type and entity_id', async () => {
    const workspaceId = await seedWorkspace();
    const actorId = await seedAgent();
    await seedTrail(workspaceId, actorId);

    const wrongType = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, { workspaceId, entityType: 'form', entityId: workspaceId, limit: 50 }),
    );
    expect(wrongType.rows).toEqual([]);

    const wrongEntity = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, {
        workspaceId,
        entityType: ENTITY,
        entityId: await seedWorkspace(),
        limit: 50,
      }),
    );
    expect(wrongEntity.rows).toEqual([]);
  });

  it('returns an empty page and a null cursor when nothing was ever changed', async () => {
    const workspaceId = await seedWorkspace();
    await ownerPool.query('select 1');

    const page = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, { workspaceId, entityType: ENTITY, entityId: workspaceId, limit: 50 }),
    );

    expect(page).toEqual({ rows: [], nextCursor: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test tests/changeLog.read.test.ts`
Expected: FAIL — cannot resolve `../src/shared/changeLog/readChangeLog.ts`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/shared/changeLog/readChangeLog.ts`:

```ts
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/withWorkspace.ts';
import { agent, changeLog } from '../db/schema/index.ts';
import { encodeChangeLogCursor, type ChangeLogCursor } from './cursor.ts';

/**
 * One audit row, with its actor resolved. `id` is already a string — see the
 * mapping below.
 */
export type ChangeLogRow = {
  id: string;
  field: string;
  beforeValue: unknown;
  afterValue: unknown;
  changedAt: Date;
  actor: { id: string; displayName: string; email: string };
};

export type ReadChangeLogInput = {
  workspaceId: string;
  entityType: string;
  entityId: string;
  /** Page size. The caller's schema caps this; nothing is capped here. */
  limit: number;
  cursor?: ChangeLogCursor;
};

/** `nextCursor` null means this was the last page. */
export type ChangeLogPage = { rows: ChangeLogRow[]; nextCursor: string | null };

/**
 * The generic read of the audit trail: one entity's history, newest first.
 * Entity-agnostic on purpose — `entityType` is a parameter, so the next audited
 * entity reuses this rather than hand-rolling a query that misses the index.
 *
 * The predicate and ORDER BY are shaped to match
 * INDEX (workspace_id, entity_type, entity_id, changed_at). The explicit
 * workspace predicate is belt-and-braces on top of RLS, matching the codebase
 * rule that scoped reads name their workspace.
 *
 * `agent` is one of the two unscoped tables, so joining it for the actor's name
 * needs no policy consideration — but the join is inner, and `actor_id` is
 * NOT NULL with a real FK, so it can never drop a row.
 *
 * Keyset paging on the PAIR (changed_at, id): changed_at is transaction start
 * time, so every row one save writes shares it, and a cursor on that column alone
 * would skip all but the first. One extra row is fetched to decide whether a next
 * page exists without a second COUNT query.
 */
export async function readChangeLog(tx: Tx, input: ReadChangeLogInput): Promise<ChangeLogPage> {
  const scope = and(
    eq(changeLog.workspaceId, input.workspaceId),
    eq(changeLog.entityType, input.entityType),
    eq(changeLog.entityId, input.entityId),
  );

  const where = input.cursor
    ? and(
        scope,
        sql`(${changeLog.changedAt}, ${changeLog.id}) < (${input.cursor.changedAt.toISOString()}::timestamptz, ${input.cursor.id}::bigint)`,
      )
    : scope;

  const found = await tx
    .select({
      id: changeLog.id,
      field: changeLog.field,
      beforeValue: changeLog.beforeValue,
      afterValue: changeLog.afterValue,
      changedAt: changeLog.changedAt,
      actorId: agent.id,
      actorDisplayName: agent.displayName,
      actorEmail: agent.email,
    })
    .from(changeLog)
    .innerJoin(agent, eq(agent.id, changeLog.actorId))
    .where(where)
    .orderBy(desc(changeLog.changedAt), desc(changeLog.id))
    .limit(input.limit + 1);

  const page = found.slice(0, input.limit);

  // String(), not Number(): the column is a bigserial mapped as a JS bigint, and
  // JSON.stringify throws outright on a bigint while Number() would silently lose
  // precision past 2^53.
  const rows: ChangeLogRow[] = page.map((row) => ({
    id: String(row.id),
    field: row.field,
    beforeValue: row.beforeValue,
    afterValue: row.afterValue,
    changedAt: row.changedAt,
    actor: { id: row.actorId, displayName: row.actorDisplayName, email: row.actorEmail },
  }));

  const last = rows.at(-1);
  const nextCursor =
    found.length > input.limit && last
      ? encodeChangeLogCursor({ changedAt: last.changedAt, id: last.id })
      : null;

  return { rows, nextCursor };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/api test tests/changeLog.read.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/shared/changeLog/readChangeLog.ts backend/tests/changeLog.read.test.ts
git commit -m "feat(changelog): entity-agnostic newest-first read with keyset paging"
```

---

### Task 4: The role-set middleware

**Files:**

- Create: `backend/src/shared/middleware/requireWorkspaceRole.ts`
- Modify: `backend/src/shared/middleware/requireAdminRole.ts`
- Test: `backend/tests/auth.workspaceRole.test.ts`

**Interfaces:**

- Consumes: `AgentContext` from `backend/src/shared/middleware/requireAgentSession.ts`; `workspaceMember` from `backend/src/shared/db/schema/index.ts`; `withWorkspace`; `sendError` from `backend/src/errors.ts`.
- Produces:
  - `export type WorkspaceRole = 'agent' | 'team_lead' | 'admin'`
  - `export function requireWorkspaceRole(...roles: readonly [WorkspaceRole, ...WorkspaceRole[]]): RequestHandler`
  - `backend/src/shared/middleware/requireAdminRole.ts` keeps its existing named export `requireAdminRole: RequestHandler` with identical behaviour, now defined as `requireWorkspaceRole('admin')`.

**Why a new middleware rather than loosening `requireAdminRole`:** `POST /agent/intents` and `POST /agent/intents/:id/subintents` import it and must stay admin-exact per the matrix (_"Create / rename / archive / move / merge a subintent"_ — Admin only). Widening it in place would silently grant Team Leads subintent creation. Keeping `requireAdminRole` as a named alias of the factory means one query, one 403 message, and no change at its two existing call sites.

**Why the role is re-read per request:** the existing `requireAdminRole` comment already establishes this — role is not carried in the session JWT, so a demoted agent loses an admin-gated route on their very next request rather than at token expiry. The factory preserves that, including the `deactivatedAt IS NULL` filter, so a deactivated member holds no role at all.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/auth.workspaceRole.test.ts`:

```ts
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { requireWorkspaceRole } from '../src/shared/middleware/requireWorkspaceRole.ts';
import { requireAdminRole } from '../src/shared/middleware/requireAdminRole.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(
  '/leads-and-admins',
  requireAgentSession,
  requireWorkspaceRole('team_lead', 'admin'),
  (_req, res) => {
    res.status(200).json({ ok: true });
  },
);
app.use('/admins-only', requireAgentSession, requireAdminRole, (_req, res) => {
  res.status(200).json({ ok: true });
});
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function tokenForRole(
  workspaceId: string,
  role: 'agent' | 'team_lead' | 'admin',
  options: { deactivated?: boolean } = {},
): Promise<string> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Test Agent') returning id`,
    [`${role}-${Math.random().toString(36).slice(2)}@example.test`],
  );
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role, deactivated_at) values ($1, $2, $3, $4)`,
    [workspaceId, rows[0]!.id, role, options.deactivated ? new Date() : null],
  );
  return signAgentSession({ agent_id: rows[0]!.id, workspace_id: workspaceId });
}

describe('requireWorkspaceRole', () => {
  it('admits every role in the set', async () => {
    const workspaceId = await seedWorkspace();
    for (const role of ['team_lead', 'admin'] as const) {
      const token = await tokenForRole(workspaceId, role);
      await request(app)
        .get('/leads-and-admins')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    }
  });

  it('refuses a role outside the set with 403', async () => {
    const workspaceId = await seedWorkspace();
    const token = await tokenForRole(workspaceId, 'agent');
    await request(app).get('/leads-and-admins').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('refuses an agent with no membership row in this workspace', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const token = await tokenForRole(workspaceB, 'admin');
    const { rows } = await ownerPool.query<{ agent_id: string }>(
      `select agent_id from workspace_member`,
    );
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
      [workspaceA, rows[0]!.agent_id],
    );
    // The session names workspaceB, where they are admin; the route is mounted on
    // whichever workspace the token claims, so this asserts the role is read for
    // the session's workspace and not "any workspace they are an admin of".
    await request(app).get('/admins-only').set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('refuses a deactivated member regardless of role', async () => {
    const workspaceId = await seedWorkspace();
    const token = await tokenForRole(workspaceId, 'admin', { deactivated: true });
    await request(app).get('/leads-and-admins').set('Authorization', `Bearer ${token}`).expect(403);
    await request(app).get('/admins-only').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('requires authentication before it can check a role', async () => {
    await request(app).get('/leads-and-admins').expect(401);
  });
});

describe('requireAdminRole', () => {
  it('still admits only admin — a team lead is refused', async () => {
    const workspaceId = await seedWorkspace();
    const lead = await tokenForRole(workspaceId, 'team_lead');
    const admin = await tokenForRole(workspaceId, 'admin');

    await request(app).get('/admins-only').set('Authorization', `Bearer ${lead}`).expect(403);
    await request(app).get('/admins-only').set('Authorization', `Bearer ${admin}`).expect(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test tests/auth.workspaceRole.test.ts`
Expected: FAIL — cannot resolve `../src/shared/middleware/requireWorkspaceRole.ts`.

- [ ] **Step 3: Write the middleware**

Create `backend/src/shared/middleware/requireWorkspaceRole.ts`:

```ts
import type { RequestHandler } from 'express';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { sendError } from '../../errors.ts';
import { workspaceMember } from '../db/schema/index.ts';
import { withWorkspace } from '../db/withWorkspace.ts';

export type WorkspaceRole = 'agent' | 'team_lead' | 'admin';

/**
 * Gates a route on a SET of workspace roles, per the permission matrix in
 * docs/project-overview.md §Roles and permissions. A permission is never granted
 * to an individual, so the only input is the role.
 *
 * Runs after requireAgentSession, which puts the verified claims on req.agent.
 *
 * Role is NOT carried in the session JWT, so this re-reads workspace_member on
 * every request: a demoted agent loses a gated route on their very next request
 * rather than at token expiry. A deactivated member holds no role at all, hence
 * the deactivatedAt filter.
 *
 * The read is scoped to the session's workspace by RLS plus the agent predicate,
 * so being an admin of some OTHER workspace grants nothing here.
 */
export function requireWorkspaceRole(
  ...roles: readonly [WorkspaceRole, ...WorkspaceRole[]]
): RequestHandler {
  return async (req, res, next) => {
    const ctx = req.agent!;
    const allowed = await withWorkspace(ctx.workspaceId, async (tx) => {
      const [row] = await tx
        .select({ role: workspaceMember.role })
        .from(workspaceMember)
        .where(
          and(
            eq(workspaceMember.agentId, ctx.agentId),
            isNull(workspaceMember.deactivatedAt),
            inArray(workspaceMember.role, [...roles]),
          ),
        )
        .limit(1);
      return row !== undefined;
    });

    if (!allowed) {
      sendError(res, 403, 'forbidden', `Requires one of these roles: ${roles.join(', ')}.`);
      return;
    }
    next();
  };
}
```

- [ ] **Step 4: Re-express `requireAdminRole` on top of it**

Replace the whole body of `backend/src/shared/middleware/requireAdminRole.ts`:

```ts
import { requireWorkspaceRole } from './requireWorkspaceRole.ts';

/**
 * Admin-exact, and it must stay that way: POST /agent/intents and
 * POST /agent/intents/:id/subintents depend on it, and the permission matrix
 * grants subintent creation to Admin only. Widening this would silently grant a
 * Team Lead that capability — add a requireWorkspaceRole(...) gate on the route
 * that needs a wider set instead.
 *
 * Kept as a named export so its two existing call sites need no edit.
 */
export const requireAdminRole = requireWorkspaceRole('admin');
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @support/api test tests/auth.workspaceRole.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Verify the existing admin-gated routes are unaffected**

Run: `pnpm --filter @support/api test tests/agent.taxonomy.test.ts`
Expected: PASS — including its "refuses a non-admin agent with 403, not 404" case.

Then: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/shared/middleware/requireWorkspaceRole.ts backend/src/shared/middleware/requireAdminRole.ts \
  backend/tests/auth.workspaceRole.test.ts
git commit -m "feat(auth): role-set middleware, with requireAdminRole as an alias"
```

---

### Task 5: `GET /agent/bot-config`

**Files:**

- Create: `backend/src/agent/services/botConfigService.ts`
- Create: `backend/src/agent/controllers/botConfigController.ts`
- Create: `backend/src/agent/routers/botConfigRouter.ts`
- Modify: `backend/src/agent/router.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.botConfig.test.ts`

**Interfaces:**

- Consumes: `AgentContext` from `backend/src/shared/middleware/requireAgentSession.ts`; `withWorkspace` from `backend/src/shared/db/withWorkspace.ts`; `resolveBotConfig` from `backend/src/domain/bot/botConfig.ts`; `botConfig` table from `backend/src/shared/db/schema/index.ts`; `BotConfigView` from `@support/types`; `requireWorkspaceRole` from Task 4.
- Produces:
  - `export async function getBotConfigView(ctx: AgentContext): Promise<BotConfigView>`
  - `export const getBotConfigHandler: RequestHandler`
  - `export const botConfigRouter: Router` — mounted on `agentRouter` in this task, and extended (not replaced) by Tasks 6 and 7.
  - `const canSeeBotConfig = requireWorkspaceRole('team_lead', 'admin')` — module-private, reused by the history route in Task 7.

**Two selects, one transaction, and why:** `resolveBotConfig` collapses "no row", `is_provisioned = false`, `prompt IS NULL` and `rules IS NULL` into one answer, and it is the only function allowed to do that — so the service must call it rather than reading the row and resolving itself. The console additionally needs to know whether each stored column is non-null, so it can offer "reset to default" only where there is something to reset, and that fact is not in the resolved shape by design. So the service does both: `resolveBotConfig` for the values, and one raw primary-key read for the two flags plus `updated_at`. Both are PK lookups in the same transaction, so this is one round of cheap reads, not a duplicated resolver.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/agent.botConfig.test.ts`:

```ts
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { botConfigRouter } from '../src/agent/routers/botConfigRouter.ts';
import {
  DEFAULT_BOT_PROMPT,
  DEFAULT_BOT_RULES,
  buildSystemPrompt,
} from '../src/domain/bot/defaultPrompt.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

// Standalone app carrying just this router behind the real session and role
// middleware — same rationale as agent.taxonomy.test.ts: it keeps this suite off
// the shared app wiring.
const app = express();
app.use(express.json());
app.use(requireAgentSession, botConfigRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function seedAgentWithRole(
  workspaceId: string,
  role: 'agent' | 'team_lead' | 'admin',
): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Test Agent') returning id`,
    [`${role}-${Math.random().toString(36).slice(2)}@example.test`],
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, $3)`,
    [workspaceId, agentId, role],
  );
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
  return { agentId, token };
}

describe('GET /bot-config', () => {
  it('resolves an absent row to the off state on the defaults', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .get('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toEqual({
      is_provisioned: false,
      prompt: DEFAULT_BOT_PROMPT,
      rules: DEFAULT_BOT_RULES,
      system_prompt: buildSystemPrompt(DEFAULT_BOT_PROMPT, DEFAULT_BOT_RULES),
      is_prompt_customized: false,
      is_rules_customized: false,
      updated_at: null,
    });
  });

  it('reports a stored prompt verbatim and marks only that field customised', async () => {
    const workspaceId = await seedWorkspace();
    await ownerPool.query(
      `insert into bot_config (workspace_id, is_provisioned, prompt) values ($1, true, 'Custom prompt')`,
      [workspaceId],
    );
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .get('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.is_provisioned).toBe(true);
    expect(res.body.prompt).toBe('Custom prompt');
    expect(res.body.rules).toBe(DEFAULT_BOT_RULES);
    expect(res.body.is_prompt_customized).toBe(true);
    expect(res.body.is_rules_customized).toBe(false);
    expect(res.body.system_prompt).toBe(buildSystemPrompt('Custom prompt', DEFAULT_BOT_RULES));
    expect(typeof res.body.updated_at).toBe('string');
  });

  // The matrix row is "See bot config" — Team Lead ✓, Admin ✓.
  it('admits a team lead, who may see the config but not edit it', async () => {
    const workspaceId = await seedWorkspace();
    await ownerPool.query(
      `insert into bot_config (workspace_id, prompt) values ($1, 'Custom prompt')`,
      [workspaceId],
    );
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');

    const res = await request(app)
      .get('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.prompt).toBe('Custom prompt');
  });

  it('refuses a plain agent with 403', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app).get('/bot-config').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('refuses an unauthenticated request with 401', async () => {
    await request(app).get('/bot-config').expect(401);
  });

  it('never leaks another workspace config', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    await ownerPool.query(
      `insert into bot_config (workspace_id, is_provisioned, prompt) values ($1, true, 'B prompt')`,
      [workspaceB],
    );
    const { token } = await seedAgentWithRole(workspaceA, 'admin');

    const res = await request(app)
      .get('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.prompt).toBe(DEFAULT_BOT_PROMPT);
    expect(res.body.is_provisioned).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test tests/agent.botConfig.test.ts`
Expected: FAIL — cannot resolve `../src/agent/routers/botConfigRouter.ts`.

- [ ] **Step 3: Write the service**

Create `backend/src/agent/services/botConfigService.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { BotConfigView } from '@support/types';
import { botConfig } from '../../shared/db/schema/index.ts';
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts';
import { resolveBotConfig } from '../../domain/bot/botConfig.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';

/**
 * The console needs two things the resolver deliberately does not return: whether
 * each stored COLUMN is non-null (so a "reset to default" control is only offered
 * where there is something to reset) and `updated_at` for the screen's header.
 *
 * Both come from one primary-key read. It sits alongside resolveBotConfig rather
 * than replacing it: collapsing "no row" / false / NULL into an answer is the
 * resolver's job and only the resolver's, or two call sites eventually disagree.
 */
async function readRowMeta(
  tx: Tx,
  workspaceId: string,
): Promise<{ isPromptCustomized: boolean; isRulesCustomized: boolean; updatedAt: Date | null }> {
  const [row] = await tx
    .select({ prompt: botConfig.prompt, rules: botConfig.rules, updatedAt: botConfig.updatedAt })
    .from(botConfig)
    .where(eq(botConfig.workspaceId, workspaceId))
    .limit(1);

  return {
    isPromptCustomized: row?.prompt != null,
    isRulesCustomized: row?.rules != null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Shared by the read and the save so one response shape cannot drift from the other. */
async function view(tx: Tx, workspaceId: string): Promise<BotConfigView> {
  const resolved = await resolveBotConfig(tx, workspaceId);
  const meta = await readRowMeta(tx, workspaceId);
  return {
    is_provisioned: resolved.isProvisioned,
    prompt: resolved.prompt,
    rules: resolved.rules,
    system_prompt: resolved.systemPrompt,
    is_prompt_customized: meta.isPromptCustomized,
    is_rules_customized: meta.isRulesCustomized,
    updated_at: meta.updatedAt?.toISOString() ?? null,
  };
}

export async function getBotConfigView(ctx: AgentContext): Promise<BotConfigView> {
  return withWorkspace(ctx.workspaceId, (tx) => view(tx, ctx.workspaceId));
}
```

- [ ] **Step 4: Write the controller**

Create `backend/src/agent/controllers/botConfigController.ts`:

```ts
import type { RequestHandler } from 'express';
import { getBotConfigView } from '../services/botConfigService.ts';

export const getBotConfigHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await getBotConfigView(req.agent!));
};
```

- [ ] **Step 5: Write the router**

Create `backend/src/agent/routers/botConfigRouter.ts`:

```ts
import { Router } from 'express';
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts';
import { requireWorkspaceRole } from '../../shared/middleware/requireWorkspaceRole.ts';
import { getBotConfigHandler } from '../controllers/botConfigController.ts';

/**
 * Roles follow the permission matrix in docs/project-overview.md, which splits
 * read from write:
 *
 *   "See bot config · trigger manual sync"            → Team Lead, Admin
 *   "Edit bot prompt or rules · provision or disable" → Admin only
 *
 * So the reads take a role SET and only the save takes requireAdminRole. A plain
 * agent is refused on all three. Both gates run after requireAgentSession, which
 * agent/router.ts installs before this router.
 *
 * Save is POST, not PUT/PATCH: app.ts's CORS allows only GET and POST, and the
 * console is a browser client.
 */
const canSeeBotConfig = requireWorkspaceRole('team_lead', 'admin');

export const botConfigRouter = Router();
botConfigRouter.get('/bot-config', canSeeBotConfig, getBotConfigHandler);
```

- [ ] **Step 6: Mount it on the agent router**

Modify `backend/src/agent/router.ts` — add the import next to the other router imports and the `use` call after `articlesRouter`:

```ts
import { botConfigRouter } from './routers/botConfigRouter.ts';
```

```ts
agentRouter.use(articlesRouter);
agentRouter.use(botConfigRouter);
```

- [ ] **Step 7: Register the path in OpenAPI**

Modify `backend/src/docs/openapi.ts` — add after the last `/agent/articles/...` `registerPath` call and before the `/surface/...` block:

```ts
registry.registerPath({
  method: 'get',
  path: '/agent/bot-config',
  summary: 'Agent Get Bot Config',
  description:
    'The resolved bot config for this workspace: is_provisioned, prompt, rules, the joined system_prompt, and which of the two text fields is customised. An absent row resolves to the off state on the defaults. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: {
    200: { description: 'Resolved bot config' },
    403: { description: 'Forbidden — Team Lead or Admin role required' },
  },
});
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @support/api test tests/agent.botConfig.test.ts`
Expected: PASS — 5 tests in `GET /bot-config`.

- [ ] **Step 9: Verify the OpenAPI document still builds**

Run: `pnpm --filter @support/api test tests/surface.test.ts` (it boots the real app, which imports `openapi.ts`)
Expected: PASS.

Then: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add backend/src/agent/services/botConfigService.ts backend/src/agent/controllers/botConfigController.ts \
  backend/src/agent/routers/botConfigRouter.ts backend/src/agent/router.ts backend/src/docs/openapi.ts \
  backend/tests/agent.botConfig.test.ts
git commit -m "feat(agent): GET /agent/bot-config"
```

---

### Task 6: `POST /agent/bot-config`

**Files:**

- Modify: `backend/src/agent/services/botConfigService.ts`
- Modify: `backend/src/agent/controllers/botConfigController.ts`
- Modify: `backend/src/agent/routers/botConfigRouter.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.botConfig.test.ts`

**Interfaces:**

- Consumes: `getBotConfigView`'s private `view(tx, workspaceId)` helper from Task 5; `saveBotConfig`, `EmptyBotPrompt` from `backend/src/domain/bot/botConfig.ts`; `SaveBotConfigBody` from `@support/types`.
- Produces:
  - `export async function saveBotConfigForAgent(ctx: AgentContext, input: { isProvisioned?: boolean; prompt?: string | null; rules?: string | null }): Promise<BotConfigView>`
  - `export const saveBotConfigHandler: RequestHandler`

**Status codes:** `200` (not `201` — `bot_config` is upserted, and a first save is not a new addressable resource), `422` for a schema failure or `EmptyBotPrompt`, `403` for anyone who is not an Admin — **including a Team Lead**, who may see the config but not edit it — `401` unauthenticated.

**This is the one endpoint that keeps `requireAdminRole`.** The matrix row is _"Edit bot prompt or rules · provision or disable bot"_ — Admin only. Do not reuse `canSeeBotConfig` here.

**The one thing that must not be reimplemented here:** `saveBotConfig` already rejects whitespace, computes before/after against the absent-row collapse, upserts, and calls `appendChangeLog` inside the caller's transaction. The service adds a transaction and the actor id — nothing more.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/agent.botConfig.test.ts`:

```ts
describe('POST /bot-config', () => {
  it('creates the row on a first save and returns the resolved view', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_provisioned: true, prompt: 'Custom prompt' })
      .expect(200);

    expect(res.body.is_provisioned).toBe(true);
    expect(res.body.prompt).toBe('Custom prompt');
    expect(res.body.rules).toBe(DEFAULT_BOT_RULES);
    expect(res.body.is_prompt_customized).toBe(true);
    expect(res.body.is_rules_customized).toBe(false);

    const { rows } = await ownerPool.query<{ prompt: string | null; is_provisioned: boolean }>(
      `select prompt, is_provisioned from bot_config where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows[0]).toEqual({ prompt: 'Custom prompt', is_provisioned: true });
  });

  it('writes one audit row per changed field, attributed to the caller', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_provisioned: true, prompt: 'Custom prompt' })
      .expect(200);

    const { rows } = await ownerPool.query<{ field: string; actor_id: string }>(
      `select field, actor_id from change_log
        where entity_type = 'bot_config' and entity_id = $1 order by field`,
      [workspaceId],
    );
    expect(rows.map((row) => row.field)).toEqual(['is_provisioned', 'prompt']);
    expect(rows.every((row) => row.actor_id === agentId)).toBe(true);
  });

  it('leaves an omitted field alone and audits nothing for it', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: 'First', rules: 'Rule one' })
      .expect(200);
    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: 'Second' })
      .expect(200);

    expect(res.body.prompt).toBe('Second');
    expect(res.body.rules).toBe('Rule one');

    const { rows } = await ownerPool.query<{ field: string }>(
      `select field from change_log where entity_type = 'bot_config' and entity_id = $1`,
      [workspaceId],
    );
    expect(rows.filter((row) => row.field === 'rules')).toHaveLength(1);
  });

  it('treats explicit null as a reset to the default and audits it', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: 'Custom' })
      .expect(200);
    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: null })
      .expect(200);

    expect(res.body.prompt).toBe(DEFAULT_BOT_PROMPT);
    expect(res.body.is_prompt_customized).toBe(false);

    const { rows } = await ownerPool.query<{ before_value: unknown; after_value: unknown }>(
      `select before_value, after_value from change_log
        where entity_type = 'bot_config' and entity_id = $1 and field = 'prompt'
        order by changed_at desc, id desc limit 1`,
      [workspaceId],
    );
    expect(rows[0]).toEqual({ before_value: 'Custom', after_value: null });
  });

  it('is an upsert — a second save does not error', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_provisioned: true })
      .expect(200);
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_provisioned: false })
      .expect(200);

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*)::text as count from bot_config where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('rejects a whitespace-only value with 422 naming the offending column', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ rules: '   ' })
      .expect(422);

    expect(res.body.error.message).toContain('rules');

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*)::text as count from bot_config where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('rejects an empty body and an unknown key with 422', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(422);
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ provisioned: true })
      .expect(422);
  });

  // Editing is Admin-only in the matrix, so a Team Lead who CAN read the config is
  // still refused here. This is the case that proves read and write are separate
  // gates rather than one copy-pasted middleware.
  it('refuses a team lead with 403 and writes nothing', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: 'Lead tried to edit' })
      .expect(403);

    await request(app).get('/bot-config').set('Authorization', `Bearer ${token}`).expect(200);

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*)::text as count from bot_config where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('refuses a plain agent with 403 and writes nothing', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_provisioned: true })
      .expect(403);

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*)::text as count from bot_config where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('writes no audit row when the caller was refused', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: 'x' })
      .expect(403);

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*)::text as count from change_log where entity_id = $1`,
      [workspaceId],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('writes only the caller workspace row', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceA, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: 'A' })
      .expect(200);

    const { rows } = await ownerPool.query<{ workspace_id: string }>(
      `select workspace_id from bot_config`,
    );
    expect(rows.map((row) => row.workspace_id)).toEqual([workspaceA]);
    expect(rows.map((row) => row.workspace_id)).not.toContain(workspaceB);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test tests/agent.botConfig.test.ts`
Expected: FAIL — every `POST /bot-config` case returns 404 (no route).

- [ ] **Step 3: Add the service function**

Modify `backend/src/agent/services/botConfigService.ts` — extend the domain import and append the function:

```ts
import { resolveBotConfig, saveBotConfig } from '../../domain/bot/botConfig.ts';
```

```ts
export type BotConfigSaveInput = {
  isProvisioned?: boolean;
  prompt?: string | null;
  rules?: string | null;
};

/**
 * One transaction for the upsert, its audit rows, and the re-read that shapes the
 * response — so a client that renders the response is looking at the same state
 * the audit trail describes.
 *
 * `saveBotConfig` owns everything substantive: whitespace rejection
 * (EmptyBotPrompt), the before/after comparison against the absent-row collapse,
 * the ON CONFLICT upsert, and the appendChangeLog call in this same transaction.
 * This function adds the transaction and the actor id, and nothing else. Never
 * write `bot_config` here directly.
 */
export async function saveBotConfigForAgent(
  ctx: AgentContext,
  input: BotConfigSaveInput,
): Promise<BotConfigView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    await saveBotConfig(tx, {
      workspaceId: ctx.workspaceId,
      actorId: ctx.agentId,
      isProvisioned: input.isProvisioned,
      prompt: input.prompt,
      rules: input.rules,
    });
    return view(tx, ctx.workspaceId);
  });
}
```

> `saveBotConfig` returns a `ResolvedBotConfig`, which is deliberately discarded: it carries no `updated_at` and no customised flags, and re-reading through the shared `view` helper is what keeps the GET and POST response shapes identical.

- [ ] **Step 4: Add the controller handler**

Modify `backend/src/agent/controllers/botConfigController.ts`:

```ts
import type { RequestHandler } from 'express';
import { SaveBotConfigBody } from '@support/types';
import { sendError } from '../../errors.ts';
import { EmptyBotPrompt } from '../../domain/bot/botConfig.ts';
import { getBotConfigView, saveBotConfigForAgent } from '../services/botConfigService.ts';

export const getBotConfigHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await getBotConfigView(req.agent!));
};

/**
 * 200, not 201: the row is upserted and a first save is not a new addressable
 * resource — GET /agent/bot-config already answers for a workspace with no row.
 *
 * EmptyBotPrompt is caught here rather than mapped in errorMiddleware because its
 * message names the offending COLUMN, which is the whole point of the error, and
 * the generic 500 path would discard it.
 */
export const saveBotConfigHandler: RequestHandler = async (req, res) => {
  const body = SaveBotConfigBody.safeParse(req.body);
  if (!body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'At least one of is_provisioned, prompt or rules is required, and no other field is accepted.',
    );
    return;
  }

  try {
    res.status(200).json(
      await saveBotConfigForAgent(req.agent!, {
        isProvisioned: body.data.is_provisioned,
        prompt: body.data.prompt,
        rules: body.data.rules,
      }),
    );
  } catch (error) {
    if (error instanceof EmptyBotPrompt) {
      sendError(res, 422, 'invalid_request', error.message);
      return;
    }
    throw error;
  }
};
```

- [ ] **Step 5: Add the route**

Modify `backend/src/agent/routers/botConfigRouter.ts`:

```ts
import { getBotConfigHandler, saveBotConfigHandler } from '../controllers/botConfigController.ts';
```

```ts
// requireAdminRole, NOT canSeeBotConfig: "Edit bot prompt or rules · provision or
// disable bot" is Admin-only in the matrix, while seeing it is Team Lead+Admin.
botConfigRouter.post('/bot-config', requireAdminRole, saveBotConfigHandler);
```

- [ ] **Step 6: Register the path in OpenAPI**

Modify `backend/src/docs/openapi.ts` — add after the `GET /agent/bot-config` block:

```ts
registry.registerPath({
  method: 'post',
  path: '/agent/bot-config',
  summary: 'Agent Save Bot Config',
  description:
    'Partial upsert of this workspace bot config, audited field-by-field into change_log in the same transaction. An omitted key is left alone; an explicit null on prompt or rules resets it to the default. An empty or whitespace-only value is refused. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            is_provisioned: z.boolean().optional().openapi({ example: true }),
            prompt: z
              .string()
              .nullable()
              .optional()
              .openapi({ example: 'You are the first-line support assistant…' }),
            rules: z.string().nullable().optional().openapi({ example: 'Never promise a refund.' }),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Resolved bot config after the save' },
    403: { description: 'Forbidden — admin role required' },
    422: { description: 'Nothing to change, an unknown field, or an empty prompt/rules value' },
  },
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @support/api test tests/agent.botConfig.test.ts`
Expected: PASS — the 6 GET cases plus the 11 POST cases.

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add backend/src/agent/services/botConfigService.ts backend/src/agent/controllers/botConfigController.ts \
  backend/src/agent/routers/botConfigRouter.ts backend/src/docs/openapi.ts backend/tests/agent.botConfig.test.ts
git commit -m "feat(agent): POST /agent/bot-config with field-level audit"
```

---

### Task 7: `GET /agent/bot-config/history`

**Files:**

- Modify: `backend/src/agent/services/botConfigService.ts`
- Modify: `backend/src/agent/controllers/botConfigController.ts`
- Modify: `backend/src/agent/routers/botConfigRouter.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.botConfig.test.ts`

**Interfaces:**

- Consumes: `readChangeLog` from Task 3; `decodeChangeLogCursor` from Task 2; `BOT_CONFIG_ENTITY_TYPE` from `backend/src/domain/bot/botConfig.ts`; `ChangeLogHistoryQuery`, `ChangeLogHistoryResponse` from `@support/types`.
- Produces:
  - `export async function listBotConfigHistory(ctx: AgentContext, input: { limit: number; cursor?: ChangeLogCursor }): Promise<ChangeLogHistoryResponse>`
  - `export const getBotConfigHistoryHandler: RequestHandler`

**Route ordering note:** Express matches `'/bot-config'` and `'/bot-config/history'` as distinct literal paths, so registration order does not matter here. Do not introduce a `'/bot-config/:field'` style param route — it would shadow `/history`.

**Entity scoping is the server's, not the client's.** The path is `bot-config/history`, and `entityType` / `entityId` are supplied by the service as `BOT_CONFIG_ENTITY_TYPE` and `ctx.workspaceId`. There is no `?entity_type=` parameter: the spec is explicit that no `entity_type` values exist for writers that do not exist, and a client-chosen entity type would be an open query surface over a table whose other rows are not this endpoint's business.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/agent.botConfig.test.ts`:

```ts
describe('GET /bot-config/history', () => {
  it('returns an empty trail before anything is saved', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .get('/bot-config/history')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toEqual({ entries: [], next_cursor: null });
  });

  it('returns the trail newest-first with column names, actor and null semantics', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: 'First' })
      .expect(200);
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: null })
      .expect(200);

    const res = await request(app)
      .get('/bot-config/history')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0]).toEqual({
      id: expect.any(String),
      field: 'prompt',
      before_value: 'First',
      after_value: null,
      actor: { id: agentId, display_name: 'Test Agent', email: expect.any(String) },
      changed_at: expect.any(String),
    });
    // The first-ever set: before is null, and that is a different fact from the clear above.
    expect(res.body.entries[1].before_value).toBeNull();
    expect(res.body.entries[1].after_value).toBe('First');
    expect(res.body.next_cursor).toBeNull();
  });

  it('pages with limit and next_cursor', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ is_provisioned: true, prompt: 'First', rules: 'Rule one' })
      .expect(200);

    const first = await request(app)
      .get('/bot-config/history?limit=2')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(first.body.entries).toHaveLength(2);
    expect(first.body.next_cursor).toEqual(expect.any(String));

    const second = await request(app)
      .get(`/bot-config/history?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(second.body.entries).toHaveLength(1);
    expect(second.body.next_cursor).toBeNull();

    const ids = [...first.body.entries, ...second.body.entries].map(
      (entry: { id: string }) => entry.id,
    );
    expect(new Set(ids).size).toBe(3);
  });

  it('rejects a bad limit and an undecodable cursor with 422', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .get('/bot-config/history?limit=0')
      .set('Authorization', `Bearer ${token}`)
      .expect(422);
    await request(app)
      .get('/bot-config/history?limit=201')
      .set('Authorization', `Bearer ${token}`)
      .expect(422);
    await request(app)
      .get('/bot-config/history?cursor=not-a-cursor!!')
      .set('Authorization', `Bearer ${token}`)
      .expect(422);
  });

  it('never returns another workspace trail', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const { token: tokenB } = await seedAgentWithRole(workspaceB, 'admin');
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ prompt: 'B' })
      .expect(200);
    const { token: tokenA } = await seedAgentWithRole(workspaceA, 'admin');

    const res = await request(app)
      .get('/bot-config/history')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    expect(res.body.entries).toEqual([]);
  });

  // Filed under "See bot config" — a Team Lead who can read the current prompt is
  // not kept from reading the previous one.
  it('admits a team lead', async () => {
    const workspaceId = await seedWorkspace();
    const { token: adminToken } = await seedAgentWithRole(workspaceId, 'admin');
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ prompt: 'First' })
      .expect(200);
    const { token: leadToken } = await seedAgentWithRole(workspaceId, 'team_lead');

    const res = await request(app)
      .get('/bot-config/history')
      .set('Authorization', `Bearer ${leadToken}`)
      .expect(200);

    expect(res.body.entries).toHaveLength(1);
  });

  it('refuses a plain agent with 403', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .get('/bot-config/history')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test tests/agent.botConfig.test.ts`
Expected: FAIL — the history cases 404.

- [ ] **Step 3: Add the service function**

Modify `backend/src/agent/services/botConfigService.ts` — extend the imports and append:

```ts
import type { BotConfigView, ChangeLogHistoryResponse } from '@support/types';
import {
  BOT_CONFIG_ENTITY_TYPE,
  resolveBotConfig,
  saveBotConfig,
} from '../../domain/bot/botConfig.ts';
import type { ChangeLogCursor } from '../../shared/changeLog/cursor.ts';
import { readChangeLog } from '../../shared/changeLog/readChangeLog.ts';
```

```ts
/**
 * The audit trail for this workspace's bot config, newest first.
 *
 * The entity is fixed by the server — BOT_CONFIG_ENTITY_TYPE and the caller's own
 * workspace id, which for bot_config IS the entity id. There is deliberately no
 * client-supplied entity_type: the only writer that exists is bot config, and a
 * client-chosen type would turn this into an open query over rows that are not
 * this endpoint's business.
 *
 * `field` values are returned verbatim — they are COLUMN names, and mapping them
 * to API names would make the trail unreadable against the schema.
 */
export async function listBotConfigHistory(
  ctx: AgentContext,
  input: { limit: number; cursor?: ChangeLogCursor },
): Promise<ChangeLogHistoryResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const page = await readChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: BOT_CONFIG_ENTITY_TYPE,
      entityId: ctx.workspaceId,
      limit: input.limit,
      cursor: input.cursor,
    });

    return {
      entries: page.rows.map((row) => ({
        id: row.id,
        field: row.field,
        before_value: row.beforeValue,
        after_value: row.afterValue,
        actor: { id: row.actor.id, display_name: row.actor.displayName, email: row.actor.email },
        changed_at: row.changedAt.toISOString(),
      })),
      next_cursor: page.nextCursor,
    };
  });
}
```

- [ ] **Step 4: Add the controller handler**

Modify `backend/src/agent/controllers/botConfigController.ts` — extend the imports and append:

```ts
import { ChangeLogHistoryQuery, SaveBotConfigBody } from '@support/types';
import { decodeChangeLogCursor } from '../../shared/changeLog/cursor.ts';
import {
  getBotConfigView,
  listBotConfigHistory,
  saveBotConfigForAgent,
} from '../services/botConfigService.ts';
```

```ts
/**
 * A cursor that will not decode is a client mistake — a hand-edited or stale
 * bookmark — so it is a 422, not a silent first page. Silently ignoring it would
 * make a paging bug look like duplicate data.
 */
export const getBotConfigHistoryHandler: RequestHandler = async (req, res) => {
  const query = ChangeLogHistoryQuery.safeParse(req.query);
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'limit must be an integer between 1 and 200.');
    return;
  }

  const cursor =
    query.data.cursor === undefined ? undefined : decodeChangeLogCursor(query.data.cursor);
  if (query.data.cursor !== undefined && cursor === null) {
    sendError(res, 422, 'invalid_request', 'cursor is not a valid page cursor.');
    return;
  }

  res.status(200).json(await listBotConfigHistory(req.agent!, { limit: query.data.limit, cursor }));
};
```

- [ ] **Step 5: Add the route**

Modify `backend/src/agent/routers/botConfigRouter.ts`:

```ts
import {
  getBotConfigHandler,
  getBotConfigHistoryHandler,
  saveBotConfigHandler,
} from '../controllers/botConfigController.ts';
```

```ts
// canSeeBotConfig, the same Team Lead+Admin gate as the config read — reuse the
// constant rather than a second requireWorkspaceRole(...) call, so the two reads
// cannot drift apart.
botConfigRouter.get('/bot-config/history', canSeeBotConfig, getBotConfigHistoryHandler);
```

- [ ] **Step 6: Register the path in OpenAPI**

Modify `backend/src/docs/openapi.ts` — add after the `POST /agent/bot-config` block:

```ts
registry.registerPath({
  method: 'get',
  path: '/agent/bot-config/history',
  summary: 'Agent Get Bot Config Audit Trail',
  description:
    'This workspace bot-config change_log rows, newest first, cursor-paged. `field` is the database column name. `before_value` null means the field had no value before; `after_value` null means it was reset to the default. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional().openapi({ example: 50 }),
      cursor: z
        .string()
        .optional()
        .openapi({ description: 'Opaque next_cursor from the previous page' }),
    }),
  },
  responses: {
    200: { description: 'Audit trail page' },
    403: { description: 'Forbidden — Team Lead or Admin role required' },
    422: { description: 'Invalid limit or cursor' },
  },
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @support/api test tests/agent.botConfig.test.ts`
Expected: PASS — all GET, POST and history cases.

- [ ] **Step 8: Run the whole suite and typecheck**

Run: `pnpm typecheck`
Expected: no errors.

Run: `pnpm test`
Expected: PASS — every package. Postgres and Redis must be up. If `tests/schema.test.ts` or `tests/rls.test.ts` fails, stop: this plan changes no schema, so such a failure means something outside this plan moved.

- [ ] **Step 9: Verify the live docs list the three endpoints**

Run: `pnpm dev` in one terminal, then in another:

```bash
curl -s http://localhost:4000/docs/json | grep -o '"/agent/bot-config[^"]*"' | sort -u
```

Expected output:

```
"/agent/bot-config"
"/agent/bot-config/history"
```

Stop `pnpm dev`.

- [ ] **Step 10: Commit**

```bash
git add backend/src/agent/services/botConfigService.ts backend/src/agent/controllers/botConfigController.ts \
  backend/src/agent/routers/botConfigRouter.ts backend/src/docs/openapi.ts backend/tests/agent.botConfig.test.ts
git commit -m "feat(agent): GET /agent/bot-config/history audit trail"
```

---

## Out of scope — named so nobody wonders

- **Any frontend.** No admin screen, no TanStack Query hook, no page under `surfaces/agent-console`. This slice is the API those will call.
- **Forms routes.** `form`, `form_version`, `form_submission`, `form_answer` and their endpoints are a separate slice; nothing here touches them.
- **A generic `/agent/change-log` endpoint.** `readChangeLog` is entity-agnostic so the next audited entity reuses it, but no route exposes a client-chosen `entity_type` — the spec is explicit that entity types for writers that do not exist must not be added.
- **Realtime.** A config save emits no socket event. Nothing subscribes, and the orchestrator reads `bot_config` from Postgres on every message.
- **`rule` / `rule_firing`**, so the "cannot be provisioned with an empty rule set" invariant still cannot be enforced. `is_provisioned` can be flipped true with default rules, exactly as the data-model slice left it.
- **Placeholder substitution.** `system_prompt` is returned with `{{subintents}}` and friends intact; the orchestrator fills them.
- **Caching the resolved config.** Every read hits Postgres. Adding a cache needs an invalidation story the save path does not have.
- **"Trigger manual sync"**, the second half of the matrix's _"See bot config · trigger manual sync"_ row. Nothing pushes bot config anywhere — the orchestrator reads `bot_config` from Postgres on every message, and the data-model spec §7 dropped the `last_sync_*` columns for exactly that reason. There is no sync endpoint to gate, so only the "see" half of that row is implemented here.
