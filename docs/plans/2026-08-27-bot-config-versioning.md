# Bot Config Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-field, restore-only bot config `HistoryPanel` with a single "History" tab that shows real version numbers (v1, v2, v3...) and a type-aware diff of what changed in each version, with full-snapshot restore.

**Architecture:** A new `bot_config_version` table snapshots the entire `bot_config` row (prompt + rules + tools_config + limits_config) every time `saveBotConfig` writes, with an auto-incrementing `version` per workspace and a `changed_fields` summary computed at write time. The existing `change_log` table and its endpoints are untouched — they keep being written by `saveBotConfig` exactly as today. `GET /bot-config/history` and `POST /bot-config/rollback`'s field-scoped shape are removed and replaced by version-scoped endpoints; the frontend gets one `VersionHistoryTab` instead of three `HistoryPanel`s.

**Tech Stack:** Express 5 + Zod + Drizzle ORM + PostgreSQL (backend), React + TanStack Query + Tailwind v4 (frontend), Vitest (both).

## Global Constraints

- No hard deletes anywhere; `bot_config_version` is append-only via `REVOKE UPDATE, DELETE`, same as `change_log`.
- `saveBotConfig` remains the single write path for `bot_config` — the version insert happens inside its existing transaction, no new choke point.
- Restore is a full-snapshot restore (all four fields), recorded as a brand-new version — never a mutation of history.
- Every new API endpoint gets its route and Zod schema registered in `backend/src/docs/openapi.ts`.
- Tailwind v4 utilities only in any new frontend component — no hand-written CSS classes.
- `@support/types` stays the single source of truth for wire shapes shared by backend Zod schemas and the frontend API client.

---

### Task 1: `bot_config_version` schema, migration, RLS

**Files:**

- Modify: `backend/src/shared/db/schema/bot.ts`
- Modify: `backend/src/shared/db/sql/002_rls.sql`
- Create (generated): `backend/drizzle/00NN_<auto-name>.sql` via `pnpm db:generate`

**Interfaces:**

- Produces: Drizzle table `botConfigVersion` exported from `backend/src/shared/db/schema/bot.ts`, columns `id` (bigserial), `workspaceId` (uuid), `version` (integer), `prompt` (text), `rules`/`toolsConfig`/`limitsConfig` (jsonb), `actorId` (uuid), `changedFields` (text array), `createdAt` (timestamptz). Re-exported from `backend/src/shared/db/schema/index.ts` (barrel file — confirm it re-exports everything from `./bot.ts` already; if so no edit needed there).

- [ ] **Step 1: Add the table definition**

In `backend/src/shared/db/schema/bot.ts`, replace the two existing import lines at the top of the file with:

```typescript
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { agent, workspace } from './identity.ts';
```

Then leave the existing `botConfig` table export exactly as it is, and append the new table below it:

```typescript
/**
 * A full snapshot of bot_config, one row per save. Unlike change_log (field-level,
 * generic across entity types), this is bot_config-specific and always carries all
 * four fields together, so "what did the whole bot look like at v3" is one row, not
 * a join across four change_log entries that may not even share a changed_at.
 *
 * Append-only, same enforcement as change_log: REVOKE UPDATE, DELETE in 002_rls.sql.
 *
 * `version` is 1-based per workspace, assigned as MAX(version)+1 inside the same
 * transaction as the bot_config write in saveBotConfig — never computed from row
 * count, which would be wrong the moment a version is ever skipped for any reason.
 *
 * `changed_fields` is computed at write time (which of prompt/rules/tools_config/
 * limits_config actually differ from the immediately prior version) so the version
 * list can show "v4 — Prompt, Rules" without loading two full snapshots per row.
 */
export const botConfigVersion = pgTable(
  'bot_config_version',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    prompt: text('prompt').notNull(),
    rules: jsonb('rules').notNull(),
    toolsConfig: jsonb('tools_config').notNull(),
    limitsConfig: jsonb('limits_config').notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'restrict' }),
    /** Subset of 'prompt' | 'rules' | 'tools_config' | 'limits_config'. */
    changedFields: text('changed_fields').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    unique('bot_config_version_workspace_version_unique').on(t.workspaceId, t.version),
    index('bot_config_version_workspace_created_idx').on(t.workspaceId, t.createdAt),
    check('bot_config_version_has_changes', sql`array_length(${t.changedFields}, 1) > 0`),
  ],
);
```

- [ ] **Step 2: Revoke UPDATE/DELETE in the RLS SQL file**

In `backend/src/shared/db/sql/002_rls.sql`, immediately after the existing `change_log` revoke block (the one with the "2a" comment), add:

```sql
-- 2b - bot_config_version is a full-snapshot audit trail, same append-only
-- reasoning as change_log directly above.
REVOKE UPDATE, DELETE ON bot_config_version FROM support_app;
REVOKE UPDATE, DELETE ON bot_config_version FROM PUBLIC;
REVOKE UPDATE, DELETE ON bot_config_version FROM crm_admin;
```

(Renumber any existing "2b"/"2c" comments below if this collides — check the file first.)

- [ ] **Step 3: Generate and review the migration**

Run: `pnpm db:generate`

Expected: a new file appears under `backend/drizzle/` creating table `bot_config_version` with the columns above, plus the unique and check constraints. Open the generated `.sql` file and confirm it matches — Drizzle sometimes needs `--name` disambiguation; if prompted, name it `bot_config_version`.

- [ ] **Step 4: Apply and verify**

Run: `pnpm db:setup`

Expected: exits 0. Then verify RLS took effect:

```bash
psql "$DATABASE_URL" -c "\dp bot_config_version"
```

Expected: `support_app` has no `w` (UPDATE) or `d` (DELETE) privilege listed.

- [ ] **Step 5: Commit**

```bash
git add backend/src/shared/db/schema/bot.ts backend/src/shared/db/sql/002_rls.sql backend/drizzle/
git commit -m "feat: add bot_config_version table for full-snapshot bot config history"
```

---

### Task 2: Domain layer — write and read versions

**Files:**

- Create: `backend/src/domain/bot/botConfigVersion.ts`
- Modify: `backend/src/domain/bot/botConfig.ts`
- Test: `backend/tests/agent.botConfig.test.ts` (extend, integration-level — this codebase tests domain writes through the HTTP layer, see Task 4)

**Interfaces:**

- Consumes: `Tx` from `../../shared/db/withWorkspace.ts`; `botConfigVersion` table from Task 1; `RuleEntry`/`ToolToggle`/`LimitToggle` types already imported in `botConfig.ts`.
- Produces:
  - `appendBotConfigVersion(tx, input: { workspaceId: string; actorId: string; prompt: string; rules: RuleEntry[]; toolsConfig: ToolToggle[]; limitsConfig: LimitToggle[] }): Promise<void>` — inserts the next version row, or does nothing if nothing changed vs. the prior version (mirrors `appendChangeLog`'s no-op drop).
  - `listBotConfigVersions(tx, input: { workspaceId: string; limit: number; cursor?: number }): Promise<{ rows: BotConfigVersionSummaryRow[]; nextCursor: number | null }>` — newest-first by `version`, cursor is the last-seen version number (integers page cleanly, no need for `change_log`'s two-part cursor).
  - `getBotConfigVersionByNumber(tx, input: { workspaceId: string; version: number }): Promise<BotConfigVersionSnapshotRow | null>`.
  - Types `BotConfigVersionSummaryRow = { version: number; actor: {...}; createdAt: Date; changedFields: string[] }` and `BotConfigVersionSnapshotRow = BotConfigVersionSummaryRow & { prompt: string; rules: RuleEntry[]; toolsConfig: ToolToggle[]; limitsConfig: LimitToggle[] }`.

- [ ] **Step 1: Write `botConfigVersion.ts`**

Create `backend/src/domain/bot/botConfigVersion.ts`:

```typescript
import { isDeepStrictEqual } from 'node:util';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { agent, botConfigVersion } from '../../shared/db/schema/index.ts';
import type { RuleEntry } from './rulesCatalog.ts';
import type { ToolToggle } from './tools.ts';
import type { LimitToggleValue as LimitToggle } from '@support/types';

export type BotConfigVersionActor = { id: string; displayName: string; email: string };

export type BotConfigVersionSummaryRow = {
  version: number;
  actor: BotConfigVersionActor;
  createdAt: Date;
  changedFields: string[];
};

export type BotConfigVersionSnapshotRow = BotConfigVersionSummaryRow & {
  prompt: string;
  rules: RuleEntry[];
  toolsConfig: ToolToggle[];
  limitsConfig: LimitToggle[];
};

const FIELD_NAMES = ['prompt', 'rules', 'tools_config', 'limits_config'] as const;

/**
 * Inserts the next bot_config_version row for the workspace, or writes nothing
 * if every field is deep-equal to the immediately prior version — the same
 * no-op guard appendChangeLog applies per-field, applied here to the whole
 * snapshot so a save that changes nothing does not mint an empty version.
 *
 * `version` is MAX(version)+1 computed in the same transaction as the caller's
 * bot_config write, so two concurrent saves for one workspace still serialize
 * correctly under Postgres's transaction isolation on this table.
 */
export async function appendBotConfigVersion(
  tx: Tx,
  input: {
    workspaceId: string;
    actorId: string;
    prompt: string;
    rules: RuleEntry[];
    toolsConfig: ToolToggle[];
    limitsConfig: LimitToggle[];
  },
): Promise<void> {
  const [prior] = await tx
    .select({
      prompt: botConfigVersion.prompt,
      rules: botConfigVersion.rules,
      toolsConfig: botConfigVersion.toolsConfig,
      limitsConfig: botConfigVersion.limitsConfig,
      version: botConfigVersion.version,
    })
    .from(botConfigVersion)
    .where(eq(botConfigVersion.workspaceId, input.workspaceId))
    .orderBy(desc(botConfigVersion.version))
    .limit(1);

  const changedFields = FIELD_NAMES.filter((field) => {
    if (!prior) return true;
    const before =
      field === 'prompt'
        ? prior.prompt
        : field === 'rules'
          ? prior.rules
          : field === 'tools_config'
            ? prior.toolsConfig
            : prior.limitsConfig;
    const after =
      field === 'prompt'
        ? input.prompt
        : field === 'rules'
          ? input.rules
          : field === 'tools_config'
            ? input.toolsConfig
            : input.limitsConfig;
    return !isDeepStrictEqual(before, after);
  });

  if (changedFields.length === 0) return;

  await tx.insert(botConfigVersion).values({
    workspaceId: input.workspaceId,
    version: (prior?.version ?? 0) + 1,
    prompt: input.prompt,
    rules: input.rules,
    toolsConfig: input.toolsConfig,
    limitsConfig: input.limitsConfig,
    actorId: input.actorId,
    changedFields,
  });
}

/** Newest-first, keyset-paged on the integer version column. */
export async function listBotConfigVersions(
  tx: Tx,
  input: { workspaceId: string; limit: number; cursor?: number },
): Promise<{ rows: BotConfigVersionSummaryRow[]; nextCursor: number | null }> {
  const where =
    input.cursor === undefined
      ? eq(botConfigVersion.workspaceId, input.workspaceId)
      : and(
          eq(botConfigVersion.workspaceId, input.workspaceId),
          lt(botConfigVersion.version, input.cursor),
        );

  const found = await tx
    .select({
      version: botConfigVersion.version,
      createdAt: botConfigVersion.createdAt,
      changedFields: botConfigVersion.changedFields,
      actorId: agent.id,
      actorDisplayName: agent.displayName,
      actorEmail: agent.email,
    })
    .from(botConfigVersion)
    .innerJoin(agent, eq(agent.id, botConfigVersion.actorId))
    .where(where)
    .orderBy(desc(botConfigVersion.version))
    .limit(input.limit + 1);

  const page = found.slice(0, input.limit);
  const rows: BotConfigVersionSummaryRow[] = page.map((row) => ({
    version: row.version,
    createdAt: row.createdAt,
    changedFields: row.changedFields,
    actor: { id: row.actorId, displayName: row.actorDisplayName, email: row.actorEmail },
  }));

  const last = rows.at(-1);
  const nextCursor = found.length > input.limit && last ? last.version : null;

  return { rows, nextCursor };
}

export async function getBotConfigVersionByNumber(
  tx: Tx,
  input: { workspaceId: string; version: number },
): Promise<BotConfigVersionSnapshotRow | null> {
  const [row] = await tx
    .select({
      version: botConfigVersion.version,
      prompt: botConfigVersion.prompt,
      rules: botConfigVersion.rules,
      toolsConfig: botConfigVersion.toolsConfig,
      limitsConfig: botConfigVersion.limitsConfig,
      createdAt: botConfigVersion.createdAt,
      changedFields: botConfigVersion.changedFields,
      actorId: agent.id,
      actorDisplayName: agent.displayName,
      actorEmail: agent.email,
    })
    .from(botConfigVersion)
    .innerJoin(agent, eq(agent.id, botConfigVersion.actorId))
    .where(
      and(
        eq(botConfigVersion.workspaceId, input.workspaceId),
        eq(botConfigVersion.version, input.version),
      ),
    )
    .limit(1);

  if (!row) return null;
  return {
    version: row.version,
    prompt: row.prompt,
    rules: row.rules as RuleEntry[],
    toolsConfig: row.toolsConfig as ToolToggle[],
    limitsConfig: row.limitsConfig as LimitToggle[],
    createdAt: row.createdAt,
    changedFields: row.changedFields,
    actor: { id: row.actorId, displayName: row.actorDisplayName, email: row.actorEmail },
  };
}
```

Note: `sql` is imported but unused if you don't add a raw predicate — remove the import if your editor flags it (only needed if you end up needing a raw expression; the code above doesn't).

- [ ] **Step 2: Wire into `saveBotConfig` and `seedBotConfig`**

In `backend/src/domain/bot/botConfig.ts`, add the import:

```typescript
import { appendBotConfigVersion } from './botConfigVersion.ts';
```

In `saveBotConfig`, immediately after the existing `appendChangeLog(...)` call (before `return resolved(...)`), add:

```typescript
await appendBotConfigVersion(tx, {
  workspaceId: input.workspaceId,
  actorId: input.actorId,
  prompt: afterPrompt,
  rules: afterRules,
  toolsConfig: afterTools,
  limitsConfig: afterLimits,
});
```

In `seedBotConfig`, immediately after its `appendChangeLog(...)` call (before `return resolved(...)`), add:

```typescript
await appendBotConfigVersion(tx, {
  workspaceId,
  actorId,
  prompt,
  rules,
  toolsConfig,
  limitsConfig,
});
```

This makes `seedBotConfig` write version 1 (no prior row exists, so `appendBotConfigVersion` treats every field as changed) — matching the "version 1" framing already documented on `seedBotConfig`'s docblock. Update that docblock's last sentence to also mention the version row:

```typescript
 * baseline. A workspace that already has a row is left untouched. Deliberately
 * does NOT call saveBotConfig: a first save's before-values collapse to the
 * baseline (nothing observably changed), which would make appendChangeLog drop
 * every field as a no-op — but the seed's before_value must be `null` (genuinely
 * never set), not "collapsed to baseline", so the History panel shows a real
 * "version 1" row.
```

(No code change needed here beyond the `appendBotConfigVersion` call — the existing docblock's reasoning already covers why this bypasses `saveBotConfig`.)

- [ ] **Step 3: Write an integration test for version writes**

Add to `backend/tests/agent.botConfig.test.ts`, a new `describe` block near the bottom (after the existing `GET /bot-config/history` block):

```typescript
describe('bot_config_version writes', () => {
  it('seeding writes version 1 with all four fields as changed', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    // Any provisioning path that calls seedBotConfig would work; the simplest
    // trigger available at the HTTP layer today is a save, which upserts the
    // row and therefore also runs through saveBotConfig's own version write.
    // This test instead asserts directly against the table so it exercises
    // seedBotConfig specifically once a provisioning endpoint calls it — until
    // then, assert saveBotConfig's first-ever save behaves the same way:
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'Version one prompt' })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select version, changed_fields from bot_config_version where workspace_id = $1 order by version`,
      [workspaceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].changed_fields.sort()).toEqual(
      ['limits_config', 'prompt', 'rules', 'tools_config'].sort(),
    );
  });

  it('a second save with only prompt changed writes version 2 naming only prompt', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'First' })
      .expect(200);
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'Second' })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select version, changed_fields from bot_config_version where workspace_id = $1 order by version`,
      [workspaceId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[1].version).toBe(2);
    expect(rows[1].changed_fields).toEqual(['prompt']);
  });

  it('a save with no actual change writes no new version', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'Same' })
      .expect(200);
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'Same' })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select version from bot_config_version where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter backend test agent.botConfig.test.ts`

Expected: all tests pass, including the three new ones (Postgres must be up — `pnpm db:setup` first if not already run this session).

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/bot/botConfigVersion.ts backend/src/domain/bot/botConfig.ts backend/tests/agent.botConfig.test.ts
git commit -m "feat: write a full bot_config snapshot version on every save"
```

---

### Task 3: `@support/types` — version wire shapes

**Files:**

- Modify: `packages/types/src/bot.ts`

**Interfaces:**

- Produces: `BotConfigVersionActorView`, `BotConfigVersionSummaryView`, `BotConfigVersionSnapshotView`, `BotConfigVersionsListResponse`, `BotConfigVersionsQuery` (Zod), `RollbackBotConfigVersionBody` (Zod) — consumed by Task 4 (backend service/controller) and Task 6 (frontend api client).

- [ ] **Step 1: Add the types**

Append to `packages/types/src/bot.ts` (after the existing `ChangeLogHistoryResponse` at the bottom — leave `ChangeLogHistoryQuery`/`ChangeLogHistoryResponse`/`RollbackBotConfigBody` in place, they still back `readChangeLog` even though nothing calls the old `/bot-config/history` route anymore after Task 4 removes it... actually Task 4 DELETES the old route; keep these types only if something else uses `ChangeLogHistoryResponse` — check with `grep -rn ChangeLogHistoryResponse backend frontend` before removing. If nothing else references it, delete `ChangeLogHistoryQuery`, `ChangeLogHistoryResponse`, `ChangeLogActorView`, `ChangeLogEntryView`, and `RollbackBotConfigBody` in this step instead of appending new types alongside dead ones):

```typescript
export type BotConfigVersionActorView = { id: string; display_name: string; email: string };

export const BOT_CONFIG_VERSIONED_FIELDS = [
  'prompt',
  'rules',
  'tools_config',
  'limits_config',
] as const;
export type BotConfigVersionedField = (typeof BOT_CONFIG_VERSIONED_FIELDS)[number];

/** One row in the version list — no full snapshot payload, kept light for paging. */
export type BotConfigVersionSummaryView = {
  version: number;
  actor: BotConfigVersionActorView;
  changed_fields: BotConfigVersionedField[];
  created_at: string;
};

/** `next_cursor` null means this is the last page. Cursor is the last-seen version number. */
export type BotConfigVersionsListResponse = {
  versions: BotConfigVersionSummaryView[];
  next_cursor: number | null;
};

/** Full snapshot for one version — fetched on demand when a row is expanded. */
export type BotConfigVersionSnapshotView = BotConfigVersionSummaryView & {
  prompt: string;
  rules: RuleEntryValue[];
  tools_config: ToolToggleValue[];
  limits_config: LimitToggleValue[];
};

export const BotConfigVersionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});
export type BotConfigVersionsQueryValue = z.infer<typeof BotConfigVersionsQuery>;

export const RollbackBotConfigVersionBody = z
  .object({
    version: z.number().int().positive(),
  })
  .strict();
export type RollbackBotConfigVersionBodyValue = z.infer<typeof RollbackBotConfigVersionBody>;
```

- [ ] **Step 2: Check for other consumers of the types being removed**

Run: `grep -rn "ChangeLogHistoryQuery\|ChangeLogHistoryResponse\|ChangeLogActorView\|ChangeLogEntryView\|RollbackBotConfigBody" backend frontend --include=*.ts --include=*.tsx`

Expected: only the files this plan touches in Tasks 4/6/7 (botConfigController.ts, botConfigService.ts, botConfigRouter.ts's imports, agentApi.ts, HistoryPanel.tsx and its test). If anything else references them, note it and keep the old types instead of deleting — do not silently break an unrelated caller.

- [ ] **Step 3: Typecheck the types package in isolation**

Run: `pnpm --filter @support/types typecheck` (or `pnpm typecheck` from repo root if the package has no standalone script — check `packages/types/package.json` first)

Expected: passes. (It will show errors from backend/frontend files that haven't been updated yet if `pnpm typecheck` runs the whole workspace — that's expected until Tasks 4–7 land; if the package-scoped command exists, prefer it here.)

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/bot.ts
git commit -m "feat: add BotConfigVersion wire types, drop unused change_log history types"
```

---

### Task 4: Backend service, controller, router — version endpoints

**Files:**

- Modify: `backend/src/agent/services/botConfigService.ts`
- Modify: `backend/src/agent/controllers/botConfigController.ts`
- Modify: `backend/src/agent/routers/botConfigRouter.ts`
- Modify: `backend/tests/agent.botConfig.test.ts`

**Interfaces:**

- Consumes: `listBotConfigVersions`, `getBotConfigVersionByNumber` from Task 2; `BotConfigVersionsListResponse`, `BotConfigVersionSnapshotView`, `BotConfigVersionsQuery`, `RollbackBotConfigVersionBody` from Task 3.
- Produces: `listBotConfigVersionsForAgent(ctx, input: { limit: number; cursor?: number }): Promise<BotConfigVersionsListResponse>`, `getBotConfigVersionForAgent(ctx, version: number): Promise<BotConfigVersionSnapshotView>`, `rollbackBotConfigVersionForAgent(ctx, version: number): Promise<BotConfigView>`, error class `BotConfigVersionNotFound`. Routes: `GET /bot-config/versions`, `GET /bot-config/versions/:version`, `POST /bot-config/rollback` (body now `{ version }`). `GET /bot-config/history` is removed.

- [ ] **Step 1: Replace the history/rollback service functions**

In `backend/src/agent/services/botConfigService.ts`, remove `listBotConfigHistory` and `rollbackBotConfigForAgent`, and their now-unused imports (`ChangeLogCursor`, `getChangeLogEntryById`, `readChangeLog`, `ChangeLogHistoryResponse`). Remove `ChangeLogEntryNotFound`/`ChangeLogFieldMismatch` too — nothing else uses them (confirmed in Task 3 Step 2). Add:

```typescript
import type { BotConfigVersionSnapshotView, BotConfigVersionsListResponse } from '@support/types';
import {
  getBotConfigVersionByNumber,
  listBotConfigVersions,
} from '../../domain/bot/botConfigVersion.ts';

export async function listBotConfigVersionsForAgent(
  ctx: AgentContext,
  input: { limit: number; cursor?: number },
): Promise<BotConfigVersionsListResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const page = await listBotConfigVersions(tx, {
      workspaceId: ctx.workspaceId,
      limit: input.limit,
      cursor: input.cursor,
    });
    return {
      versions: page.rows.map((row) => ({
        version: row.version,
        actor: {
          id: row.actor.id,
          display_name: row.actor.displayName,
          email: row.actor.email,
        },
        changed_fields:
          row.changedFields as BotConfigVersionsListResponse['versions'][number]['changed_fields'],
        created_at: row.createdAt.toISOString(),
      })),
      next_cursor: page.nextCursor,
    };
  });
}

export class BotConfigVersionNotFound extends Error {
  constructor() {
    super('No matching bot config version.');
    this.name = 'BotConfigVersionNotFound';
  }
}

export async function getBotConfigVersionForAgent(
  ctx: AgentContext,
  version: number,
): Promise<BotConfigVersionSnapshotView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const row = await getBotConfigVersionByNumber(tx, { workspaceId: ctx.workspaceId, version });
    if (!row) throw new BotConfigVersionNotFound();
    return {
      version: row.version,
      actor: {
        id: row.actor.id,
        display_name: row.actor.displayName,
        email: row.actor.email,
      },
      changed_fields: row.changedFields as BotConfigVersionSnapshotView['changed_fields'],
      created_at: row.createdAt.toISOString(),
      prompt: row.prompt,
      rules: row.rules.map((r) => ({ ...r, enforcement: deriveEnforcement(r) })),
      tools_config: row.toolsConfig,
      limits_config: row.limitsConfig,
    };
  });
}

/**
 * Restores a prior version's full snapshot as the new current bot_config — a
 * normal, newly-audited save (through saveBotConfig, which writes both
 * change_log and a fresh bot_config_version), never a mutation of history.
 */
export async function rollbackBotConfigVersionForAgent(
  ctx: AgentContext,
  version: number,
): Promise<BotConfigView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const snapshot = await getBotConfigVersionByNumber(tx, {
      workspaceId: ctx.workspaceId,
      version,
    });
    if (!snapshot) throw new BotConfigVersionNotFound();

    await saveBotConfig(tx, {
      workspaceId: ctx.workspaceId,
      actorId: ctx.agentId,
      prompt: snapshot.prompt,
      rules: snapshot.rules,
      toolsConfig: snapshot.toolsConfig,
      limitsConfig: snapshot.limitsConfig,
    });
    return view(tx, ctx.workspaceId);
  });
}
```

`deriveEnforcement` is already imported at the top of this file for the existing `view()` function — reuse it, don't re-import.

- [ ] **Step 2: Replace the controller handlers**

In `backend/src/agent/controllers/botConfigController.ts`, remove `getBotConfigHistoryHandler` and `rollbackBotConfigHandler`, the `HISTORY_FIELDS` set, and the now-unused `ChangeLogHistoryQuery`/`RollbackBotConfigBody`/`decodeChangeLogCursor`/`ChangeLogEntryNotFound`/`ChangeLogFieldMismatch` imports. Add:

```typescript
import { BotConfigVersionsQuery, RollbackBotConfigVersionBody } from '@support/types';
import {
  BotConfigVersionNotFound,
  getBotConfigVersionForAgent,
  listBotConfigVersionsForAgent,
  rollbackBotConfigVersionForAgent,
} from '../services/botConfigService.ts';

export const getBotConfigVersionsHandler: RequestHandler = async (req, res) => {
  const query = BotConfigVersionsQuery.safeParse(req.query);
  if (!query.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'limit must be 1-200, cursor must be a positive integer.',
    );
    return;
  }
  res.status(200).json(
    await listBotConfigVersionsForAgent(req.agent!, {
      limit: query.data.limit,
      cursor: query.data.cursor,
    }),
  );
};

export const getBotConfigVersionHandler: RequestHandler = async (req, res) => {
  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version < 1) {
    sendError(res, 422, 'invalid_request', 'version must be a positive integer.');
    return;
  }
  try {
    res.status(200).json(await getBotConfigVersionForAgent(req.agent!, version));
  } catch (error) {
    if (error instanceof BotConfigVersionNotFound) {
      sendError(res, 404, 'not_found', error.message);
      return;
    }
    throw error;
  }
};

export const rollbackBotConfigHandler: RequestHandler = async (req, res) => {
  const body = RollbackBotConfigVersionBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'version is required and must be a positive integer.');
    return;
  }
  try {
    res.status(200).json(await rollbackBotConfigVersionForAgent(req.agent!, body.data.version));
  } catch (error) {
    if (error instanceof BotConfigVersionNotFound) {
      sendError(res, 404, 'not_found', error.message);
      return;
    }
    if (
      error instanceof InvalidRulesPayload ||
      error instanceof InvalidToolsPayload ||
      error instanceof InvalidLimitsPayload ||
      error instanceof EmptyBotPrompt
    ) {
      sendError(res, 422, 'invalid_request', error.message);
      return;
    }
    throw error;
  }
};
```

Keep the existing `getBotConfigHandler` and `saveBotConfigHandler` untouched.

- [ ] **Step 3: Update the router**

In `backend/src/agent/routers/botConfigRouter.ts`, replace:

```typescript
botConfigRouter.get('/bot-config/history', canSeeBotConfig, getBotConfigHistoryHandler);
botConfigRouter.post('/bot-config/rollback', requireAdminRole, rollbackBotConfigHandler);
```

with:

```typescript
botConfigRouter.get('/bot-config/versions', canSeeBotConfig, getBotConfigVersionsHandler);
botConfigRouter.get('/bot-config/versions/:version', canSeeBotConfig, getBotConfigVersionHandler);
botConfigRouter.post('/bot-config/rollback', requireAdminRole, rollbackBotConfigHandler);
```

Update the import line at the top accordingly (`getBotConfigVersionsHandler`, `getBotConfigVersionHandler`, `rollbackBotConfigHandler` in place of `getBotConfigHistoryHandler`).

- [ ] **Step 4: Register in OpenAPI**

Open `backend/src/docs/openapi.ts`, find the existing `/bot-config/history` and `/bot-config/rollback` registrations, and replace/add entries for `GET /bot-config/versions`, `GET /bot-config/versions/{version}`, and the updated `POST /bot-config/rollback` body shape (`{ version: number }` instead of `{ field, change_log_id, side }`). Follow the exact registration pattern already used for the other `/bot-config/*` routes in that file (same helper functions, same response-schema wiring) — copy the shape from the neighboring `/bot-config` GET/POST entries rather than inventing a new pattern.

- [ ] **Step 5: Rewrite the endpoint tests**

In `backend/tests/agent.botConfig.test.ts`, replace the entire `describe('POST /bot-config/rollback', ...)` and `describe('GET /bot-config/history', ...)` blocks with:

```typescript
describe('GET /bot-config/versions', () => {
  it('returns one version after seeding via first save, newest first', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'V1' })
      .expect(200);
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'V2' })
      .expect(200);

    const res = await request(app)
      .get('/bot-config/versions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(res.body.versions[0].changed_fields).toEqual(['prompt']);
    expect(res.body.versions[1].changed_fields.sort()).toEqual(
      ['limits_config', 'prompt', 'rules', 'tools_config'].sort(),
    );
    expect(res.body.next_cursor).toBeNull();
  });

  it('never returns another workspace trail', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const { token: tokenA } = await seedAgentWithRole(workspaceA, 'admin');
    const { token: tokenB } = await seedAgentWithRole(workspaceB, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Workspace-Id', workspaceA)
      .send({ prompt: 'A only' })
      .expect(200);

    const res = await request(app)
      .get('/bot-config/versions')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('X-Workspace-Id', workspaceB)
      .expect(200);

    expect(res.body.versions).toEqual([]);
  });

  it('refuses a plain agent with 403', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .get('/bot-config/versions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(403);
  });
});

describe('GET /bot-config/versions/:version', () => {
  it('returns the full snapshot for that version', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'V1' })
      .expect(200);

    const res = await request(app)
      .get('/bot-config/versions/1')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.version).toBe(1);
    expect(res.body.prompt).toBe('V1');
    expect(res.body.rules).toBeInstanceOf(Array);
  });

  it('404s on an unknown version', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .get('/bot-config/versions/99')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(404);
  });
});

describe('POST /bot-config/rollback', () => {
  it('restores a prior version and writes a new, forward version', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'Original' })
      .expect(200);
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'Changed' })
      .expect(200);

    const res = await request(app)
      .post('/bot-config/rollback')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ version: 1 })
      .expect(200);

    expect(res.body.prompt).toBe('Original');

    const versions = await request(app)
      .get('/bot-config/versions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(versions.body.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
  });

  it('404s on an unknown version', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config/rollback')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ version: 99 })
      .expect(404);
  });

  it('refuses a team lead with 403', async () => {
    const workspaceId = await seedWorkspace();
    const { token: adminToken } = await seedAgentWithRole(workspaceId, 'admin');
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'X' })
      .expect(200);

    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');
    await request(app)
      .post('/bot-config/rollback')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ version: 1 })
      .expect(403);
  });
});
```

Also delete the now-obsolete `it('rolls back limits_config the same way as tools_config', ...)` test under `describe('GET /bot-config')` if it calls the old field-scoped rollback shape — check it first; if it only exercises the GET, leave it.

- [ ] **Step 6: Run the backend suite**

Run: `pnpm --filter backend test`

Expected: all pass. Fix any compile errors from leftover references to removed exports (`getBotConfigHistoryHandler`, `ChangeLogEntryNotFound`, etc.) surfaced by TypeScript.

- [ ] **Step 7: Commit**

```bash
git add backend/src/agent backend/src/docs/openapi.ts backend/tests/agent.botConfig.test.ts
git commit -m "feat: replace field-scoped bot config history/rollback with version endpoints"
```

---

### Task 5: Frontend API client — version endpoints

**Files:**

- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`

**Interfaces:**

- Consumes: `BotConfigVersionsListResponse`, `BotConfigVersionSnapshotView`, `RollbackBotConfigVersionBodyValue` from `@support/types` (Task 3).
- Produces: `fetchBotConfigVersions(token, opts?: { limit?: number; cursor?: number }): Promise<BotConfigVersionsListResponse>`, `fetchBotConfigVersion(token, version: number): Promise<BotConfigVersionSnapshotView>`, `rollbackBotConfigVersion(token, version: number): Promise<BotConfigView>`.

- [ ] **Step 1: Replace `fetchBotConfigHistory`/`rollbackBotConfig`**

In `frontend/src/surfaces/agent-console/api/agentApi.ts`, remove `fetchBotConfigHistory` and `rollbackBotConfig`, and update the `import type { ... } from '@support/types'` line at the top of the file to drop `ChangeLogHistoryResponse`/`RollbackBotConfigBodyValue` (if nothing else in this file uses them) and add `BotConfigVersionsListResponse`, `BotConfigVersionSnapshotView`. Replace with:

```typescript
export function fetchBotConfigVersions(
  token: string,
  opts: { limit?: number; cursor?: number } = {},
): Promise<BotConfigVersionsListResponse> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', String(opts.cursor));
  const query = params.toString();
  return call(`/agent/bot-config/versions${query ? `?${query}` : ''}`, token);
}

export function fetchBotConfigVersion(
  token: string,
  version: number,
): Promise<BotConfigVersionSnapshotView> {
  return call(`/agent/bot-config/versions/${version}`, token);
}

export function rollbackBotConfigVersion(token: string, version: number): Promise<BotConfigView> {
  return call('/agent/bot-config/rollback', token, {
    method: 'POST',
    body: JSON.stringify({ version }),
  });
}
```

- [ ] **Step 2: Search for other callers of the removed functions**

Run: `grep -rn "fetchBotConfigHistory\|rollbackBotConfig\b" frontend/src`

Expected: only `HistoryPanel.tsx` and `HistoryPanel.test.tsx`, which Task 8 removes. If anything else shows up, stop and reconcile before proceeding.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter frontend typecheck` (or `pnpm typecheck` from repo root)

Expected: errors only in `HistoryPanel.tsx`/`.test.tsx` and the three tab components still importing it — all fixed in Task 8.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts
git commit -m "feat: add versioned bot config API client functions"
```

---

### Task 6: Type-aware diff utility

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/BotConfig/lib/diffBotConfigVersion.ts`
- Test: `frontend/src/surfaces/agent-console/pages/BotConfig/lib/diffBotConfigVersion.test.ts`

**Interfaces:**

- Consumes: `BotConfigVersionSnapshotView` (`prompt`, `rules: RuleEntryView[]`, `tools_config: ToolToggleValue[]`, `limits_config: LimitToggleValue[]`) from `@support/types`.
- Produces:
  - `diffPromptText(before: string, after: string): PromptDiffToken[]` where `PromptDiffToken = { text: string; type: 'same' | 'added' | 'removed' }`.
  - `diffRules(before: RuleEntryView[], after: RuleEntryView[]): StructuredDiffEntry[]`.
  - `diffToolsConfig(before: ToolToggleValue[], after: ToolToggleValue[]): StructuredDiffEntry[]`.
  - `diffLimitsConfig(before: LimitToggleValue[], after: LimitToggleValue[]): StructuredDiffEntry[]`.
  - `type StructuredDiffEntry = { key: string; kind: 'added' | 'removed' | 'changed'; description: string }`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/surfaces/agent-console/pages/BotConfig/lib/diffBotConfigVersion.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  diffLimitsConfig,
  diffPromptText,
  diffRules,
  diffToolsConfig,
} from './diffBotConfigVersion.ts';

describe('diffPromptText', () => {
  it('marks unchanged words as same and changed words as removed/added', () => {
    const tokens = diffPromptText('You are a helpful bot', 'You are a friendly bot');
    expect(tokens).toEqual([
      { text: 'You', type: 'same' },
      { text: 'are', type: 'same' },
      { text: 'a', type: 'same' },
      { text: 'helpful', type: 'removed' },
      { text: 'friendly', type: 'added' },
      { text: 'bot', type: 'same' },
    ]);
  });

  it('returns all-same tokens for identical text', () => {
    expect(diffPromptText('Same text', 'Same text')).toEqual([
      { text: 'Same', type: 'same' },
      { text: 'text', type: 'same' },
    ]);
  });
});

describe('diffRules', () => {
  const rule = (key: string, enabled: boolean) => ({
    key,
    text: `${key} text`,
    enabled,
    locked: false,
    source: 'builtin' as const,
    enforcement: 'prompt' as const,
  });

  it('reports an enabled flag flip as changed', () => {
    const entries = diffRules([rule('greeting', true)], [rule('greeting', false)]);
    expect(entries).toEqual([
      { key: 'greeting', kind: 'changed', description: 'Rule "greeting": enabled → disabled' },
    ]);
  });

  it('reports a rule present only in after as added', () => {
    const entries = diffRules([], [rule('greeting', true)]);
    expect(entries).toEqual([
      { key: 'greeting', kind: 'added', description: 'Rule "greeting" added' },
    ]);
  });

  it('reports a rule present only in before as removed', () => {
    const entries = diffRules([rule('greeting', true)], []);
    expect(entries).toEqual([
      { key: 'greeting', kind: 'removed', description: 'Rule "greeting" removed' },
    ]);
  });
});

describe('diffToolsConfig', () => {
  it('reports a tool enabled flip', () => {
    const entries = diffToolsConfig(
      [{ tool: 'search_articles', enabled: true }],
      [{ tool: 'search_articles', enabled: false }],
    );
    expect(entries).toEqual([
      {
        key: 'search_articles',
        kind: 'changed',
        description: 'Tool "search_articles": enabled → disabled',
      },
    ]);
  });
});

describe('diffLimitsConfig', () => {
  it('reports a limit value change', () => {
    const entries = diffLimitsConfig(
      [{ key: 'max_bot_messages', value: 3 }],
      [{ key: 'max_bot_messages', value: 5 }],
    );
    expect(entries).toEqual([
      {
        key: 'max_bot_messages',
        kind: 'changed',
        description: 'Limit "max_bot_messages": 3 → 5',
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter frontend test diffBotConfigVersion -- --run`

Expected: FAIL — `diffBotConfigVersion.ts` does not exist yet.

- [ ] **Step 3: Implement the diff utility**

Create `frontend/src/surfaces/agent-console/pages/BotConfig/lib/diffBotConfigVersion.ts`:

```typescript
import type { LimitToggleValue, RuleEntryView, ToolToggleValue } from '@support/types';

export type PromptDiffToken = { text: string; type: 'same' | 'added' | 'removed' };
export type StructuredDiffEntry = {
  key: string;
  kind: 'added' | 'removed' | 'changed';
  description: string;
};

/**
 * Word-level LCS diff. No external dependency: bot prompts are a few hundred
 * words at most, well within an O(n*m) dynamic-programming table.
 */
export function diffPromptText(before: string, after: string): PromptDiffToken[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);

  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const tokens: PromptDiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      tokens.push({ text: a[i], type: 'same' });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      tokens.push({ text: a[i], type: 'removed' });
      i++;
    } else {
      tokens.push({ text: b[j], type: 'added' });
      j++;
    }
  }
  while (i < a.length) tokens.push({ text: a[i++], type: 'removed' });
  while (j < b.length) tokens.push({ text: b[j++], type: 'added' });

  return tokens;
}

export function diffRules(before: RuleEntryView[], after: RuleEntryView[]): StructuredDiffEntry[] {
  const beforeByKey = new Map(before.map((r) => [r.key, r]));
  const afterByKey = new Map(after.map((r) => [r.key, r]));
  const entries: StructuredDiffEntry[] = [];

  for (const [key, rule] of afterByKey) {
    const prior = beforeByKey.get(key);
    if (!prior) {
      entries.push({ key, kind: 'added', description: `Rule "${key}" added` });
    } else if (prior.enabled !== rule.enabled) {
      entries.push({
        key,
        kind: 'changed',
        description: `Rule "${key}": ${prior.enabled ? 'enabled' : 'disabled'} → ${rule.enabled ? 'enabled' : 'disabled'}`,
      });
    } else if (prior.text !== rule.text) {
      entries.push({ key, kind: 'changed', description: `Rule "${key}" text changed` });
    }
  }
  for (const key of beforeByKey.keys()) {
    if (!afterByKey.has(key))
      entries.push({ key, kind: 'removed', description: `Rule "${key}" removed` });
  }
  return entries;
}

export function diffToolsConfig(
  before: ToolToggleValue[],
  after: ToolToggleValue[],
): StructuredDiffEntry[] {
  const beforeByTool = new Map(before.map((t) => [t.tool, t]));
  const entries: StructuredDiffEntry[] = [];
  for (const t of after) {
    const prior = beforeByTool.get(t.tool);
    if (prior && prior.enabled !== t.enabled) {
      entries.push({
        key: t.tool,
        kind: 'changed',
        description: `Tool "${t.tool}": ${prior.enabled ? 'enabled' : 'disabled'} → ${t.enabled ? 'enabled' : 'disabled'}`,
      });
    }
  }
  return entries;
}

export function diffLimitsConfig(
  before: LimitToggleValue[],
  after: LimitToggleValue[],
): StructuredDiffEntry[] {
  const beforeByKey = new Map(before.map((l) => [l.key, l]));
  const entries: StructuredDiffEntry[] = [];
  for (const l of after) {
    const prior = beforeByKey.get(l.key);
    if (prior && prior.value !== l.value) {
      entries.push({
        key: l.key,
        kind: 'changed',
        description: `Limit "${l.key}": ${prior.value} → ${l.value}`,
      });
    }
  }
  return entries;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter frontend test diffBotConfigVersion -- --run`

Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/BotConfig/lib/diffBotConfigVersion.ts frontend/src/surfaces/agent-console/pages/BotConfig/lib/diffBotConfigVersion.test.ts
git commit -m "feat: add type-aware diff utility for bot config versions"
```

---

### Task 7: `VersionHistoryTab` component

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/BotConfig/components/VersionHistoryTab.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/BotConfig/components/VersionHistoryTab.test.tsx`

**Interfaces:**

- Consumes: `fetchBotConfigVersions`, `fetchBotConfigVersion`, `rollbackBotConfigVersion` (Task 5); `diffPromptText`, `diffRules`, `diffToolsConfig`, `diffLimitsConfig` (Task 6); `ConfirmDialog`, `Button`, `ScrollArea` (existing shared components, same imports `HistoryPanel.tsx` used).
- Produces: `VersionHistoryTab({ token }: { token: string })` — a default export is not used elsewhere in this folder (`PromptTab`/`RulesTab`/`ToolsTab` are named exports), so keep this a named export too.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/surfaces/agent-console/pages/BotConfig/components/VersionHistoryTab.test.tsx`:

```typescript
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { VersionHistoryTab } from './VersionHistoryTab.tsx';
import * as agentApi from '../../../api/agentApi.ts';

function renderTab() {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <VersionHistoryTab token="t" />
    </QueryClientProvider>,
  );
}

const rule = (key: string, enabled: boolean) => ({
  key,
  text: `${key} text`,
  enabled,
  locked: false,
  source: 'builtin' as const,
  enforcement: 'prompt' as const,
});

describe('VersionHistoryTab', () => {
  it('lists versions newest-first with changed-field chips', async () => {
    vi.spyOn(agentApi, 'fetchBotConfigVersions').mockResolvedValue({
      versions: [
        {
          version: 2,
          actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
          changed_fields: ['prompt'],
          created_at: '2026-08-27T00:00:00.000Z',
        },
        {
          version: 1,
          actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
          changed_fields: ['prompt', 'rules', 'tools_config', 'limits_config'],
          created_at: '2026-08-26T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });

    renderTab();

    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());
    expect(screen.getByText('v1')).toBeInTheDocument();
  });

  it('expands a version to show a diff against the prior version', async () => {
    vi.spyOn(agentApi, 'fetchBotConfigVersions').mockResolvedValue({
      versions: [
        {
          version: 2,
          actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
          changed_fields: ['prompt'],
          created_at: '2026-08-27T00:00:00.000Z',
        },
        {
          version: 1,
          actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
          changed_fields: ['prompt'],
          created_at: '2026-08-26T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });
    vi.spyOn(agentApi, 'fetchBotConfigVersion').mockImplementation(async (_token, version) =>
      version === 2
        ? {
            version: 2,
            actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
            changed_fields: ['prompt'],
            created_at: '2026-08-27T00:00:00.000Z',
            prompt: 'New prompt',
            rules: [rule('r1', true)],
            tools_config: [],
            limits_config: [],
          }
        : {
            version: 1,
            actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
            changed_fields: ['prompt'],
            created_at: '2026-08-26T00:00:00.000Z',
            prompt: 'Old prompt',
            rules: [rule('r1', true)],
            tools_config: [],
            limits_config: [],
          },
    );

    renderTab();
    await waitFor(() => screen.getByText('v2'));
    fireEvent.click(screen.getByText('v2'));

    await waitFor(() => expect(screen.getByText('New')).toBeInTheDocument());
    expect(screen.getByText('Old')).toBeInTheDocument();
  });

  it('restores a version behind a confirm dialog', async () => {
    vi.spyOn(agentApi, 'fetchBotConfigVersions').mockResolvedValue({
      versions: [
        {
          version: 1,
          actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
          changed_fields: ['prompt', 'rules', 'tools_config', 'limits_config'],
          created_at: '2026-08-26T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });
    const rollbackSpy = vi
      .spyOn(agentApi, 'rollbackBotConfigVersion')
      .mockResolvedValue({} as never);

    renderTab();
    await waitFor(() => screen.getByText('v1'));
    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    await waitFor(() => screen.getByRole('button', { name: 'Roll back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));

    await waitFor(() => expect(rollbackSpy).toHaveBeenCalledWith('t', 1));
  });

  it('shows an empty state with no prior version to compare', async () => {
    vi.spyOn(agentApi, 'fetchBotConfigVersions').mockResolvedValue({
      versions: [
        {
          version: 1,
          actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' },
          changed_fields: ['prompt'],
          created_at: '2026-08-26T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });

    renderTab();
    await waitFor(() => screen.getByText('v1'));
    fireEvent.click(screen.getByText('v1'));

    await waitFor(() => expect(screen.getByText('No prior changes.')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter frontend test VersionHistoryTab -- --run`

Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement `VersionHistoryTab.tsx`**

```typescript
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotConfigVersionedField } from '@support/types';
import {
  fetchBotConfigVersion,
  fetchBotConfigVersions,
  rollbackBotConfigVersion,
} from '../../../api/agentApi.ts';
import { Button } from '../../../components/ui/button.tsx';
import { ScrollArea } from '../../../components/ui/scroll-area.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import {
  diffLimitsConfig,
  diffPromptText,
  diffRules,
  diffToolsConfig,
} from '../lib/diffBotConfigVersion.ts';

const FIELD_LABELS: Record<BotConfigVersionedField, string> = {
  prompt: 'Prompt',
  rules: 'Rules',
  tools_config: 'Tools',
  limits_config: 'Limits',
};

function VersionDiff({ token, version }: { token: string; version: number }) {
  const currentQuery = useQuery({
    queryKey: ['bot-config-version', version],
    queryFn: () => fetchBotConfigVersion(token, version),
  });
  const priorQuery = useQuery({
    queryKey: ['bot-config-version', version - 1],
    queryFn: () => fetchBotConfigVersion(token, version - 1),
    enabled: version > 1,
  });

  if (currentQuery.isLoading || (version > 1 && priorQuery.isLoading)) {
    return <p className="text-xs text-muted">Loading diff…</p>;
  }
  if (version === 1 || !priorQuery.data) {
    return <p className="text-xs text-muted">No prior changes.</p>;
  }
  const current = currentQuery.data;
  const prior = priorQuery.data;
  if (!current) return null;

  const promptTokens =
    current.prompt !== prior.prompt ? diffPromptText(prior.prompt, current.prompt) : null;
  const ruleEntries = diffRules(prior.rules, current.rules);
  const toolEntries = diffToolsConfig(prior.tools_config, current.tools_config);
  const limitEntries = diffLimitsConfig(prior.limits_config, current.limits_config);

  return (
    <div className="flex flex-col gap-2 text-xs">
      {promptTokens && (
        <div>
          <p className="font-medium">Prompt</p>
          <p className="rounded bg-slate-50 p-2 font-mono">
            {promptTokens.map((token, i) => (
              <span
                key={i}
                className={
                  token.type === 'added'
                    ? 'bg-green-100 text-green-800'
                    : token.type === 'removed'
                      ? 'bg-red-100 text-red-800 line-through'
                      : undefined
                }
              >
                {token.text}{' '}
              </span>
            ))}
          </p>
        </div>
      )}
      {[...ruleEntries, ...toolEntries, ...limitEntries].map((entry) => (
        <p key={entry.key + entry.description}>{entry.description}</p>
      ))}
    </div>
  );
}

export function VersionHistoryTab({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);

  const versionsQuery = useQuery({
    queryKey: ['bot-config-versions'],
    queryFn: () => fetchBotConfigVersions(token, { limit: 50 }),
  });

  const restore = useMutation({
    mutationFn: (version: number) => rollbackBotConfigVersion(token, version),
    onSuccess: () => {
      setRestoreTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['bot-config'] });
      void queryClient.invalidateQueries({ queryKey: ['bot-config-versions'] });
    },
  });

  const versions = versionsQuery.data?.versions ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-2">
          {versions.map((entry) => (
            <li key={entry.version} className="rounded-md border border-slate-200 p-2 text-xs">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 text-left"
                onClick={() => setExpanded((v) => (v === entry.version ? null : entry.version))}
              >
                <span className="flex items-center gap-2">
                  <span className="font-semibold">v{entry.version}</span>
                  <span className="text-muted">{entry.actor.display_name}</span>
                  <span className="text-muted">{new Date(entry.created_at).toLocaleString()}</span>
                </span>
                <span className="flex gap-1">
                  {entry.changed_fields.map((field) => (
                    <span key={field} className="rounded bg-slate-100 px-1.5 py-0.5">
                      {FIELD_LABELS[field]}
                    </span>
                  ))}
                </span>
              </button>
              {expanded === entry.version && (
                <div className="mt-2 border-t border-slate-100 pt-2">
                  <VersionDiff token={token} version={entry.version} />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => setRestoreTarget(entry.version)}
                    disabled={restore.isPending}
                  >
                    Restore this version
                  </Button>
                </div>
              )}
            </li>
          ))}
          {versions.length === 0 && <li className="text-xs text-muted">No changes yet.</li>}
        </ul>
      </ScrollArea>
      {restore.isError && <p className="text-xs text-red-600">{restore.error?.message}</p>}
      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
        title="Roll back to this version?"
        description="This overwrites prompt, rules, tools and limits with this version's snapshot."
        confirmLabel="Roll back"
        confirming={restore.isPending}
        onConfirm={() => restoreTarget !== null && restore.mutate(restoreTarget)}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter frontend test VersionHistoryTab -- --run`

Expected: PASS, all 4 cases.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/BotConfig/components/VersionHistoryTab.tsx frontend/src/surfaces/agent-console/pages/BotConfig/components/VersionHistoryTab.test.tsx
git commit -m "feat: add VersionHistoryTab with type-aware diff and restore"
```

---

### Task 8: Wire the History tab into `BotConfig.tsx`, remove `HistoryPanel`

**Files:**

- Modify: `frontend/src/surfaces/agent-console/pages/BotConfig/BotConfig.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/BotConfig/components/PromptTab.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/BotConfig/components/RulesTab.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolsTab.tsx`
- Delete: `frontend/src/surfaces/agent-console/pages/BotConfig/components/HistoryPanel.tsx`
- Delete: `frontend/src/surfaces/agent-console/pages/BotConfig/components/HistoryPanel.test.tsx`

**Interfaces:**

- Consumes: `VersionHistoryTab` from Task 7.

- [ ] **Step 1: Add the History tab in `BotConfig.tsx`**

```typescript
import { useQuery } from '@tanstack/react-query';
import { fetchBotConfig } from '../../api/agentApi.ts';
import { loadAgentSession } from '../../lib/agentSession.ts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.tsx';
import { PromptTab } from './components/PromptTab.tsx';
import { RulesTab } from './components/RulesTab.tsx';
import { ToolsTab } from './components/ToolsTab.tsx';
import { VersionHistoryTab } from './components/VersionHistoryTab.tsx';

export function BotConfig() {
  const session = loadAgentSession();

  const configQuery = useQuery({
    queryKey: ['bot-config'],
    queryFn: () => fetchBotConfig(session!.token),
    enabled: session !== null,
  });

  if (!session) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Bot Config</span>
      </div>
      <Tabs defaultValue="prompt" className="min-h-0 flex-1 gap-0 p-3">
        <TabsList>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="prompt" className="min-h-0 overflow-auto pt-3">
          <PromptTab token={session.token} config={configQuery.data} />
        </TabsContent>
        <TabsContent value="rules" className="min-h-0 overflow-auto pt-3">
          <RulesTab token={session.token} config={configQuery.data} />
        </TabsContent>
        <TabsContent value="tools" className="min-h-0 overflow-auto pt-3">
          <ToolsTab token={session.token} config={configQuery.data} />
        </TabsContent>
        <TabsContent value="history" className="min-h-0 overflow-auto pt-3">
          <VersionHistoryTab token={session.token} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

- [ ] **Step 2: Remove `HistoryPanel` from `PromptTab.tsx`**

Remove the `import { HistoryPanel } from './HistoryPanel.tsx';` line and the `<HistoryPanel token={token} field="prompt" onRestored={invalidate} />` JSX line. Since `HistoryPanel` was the only thing making the outer container a two-column flex row (`<div className="flex h-full min-h-0 gap-4">` wrapping the form column and the panel), collapse it back to a single column:

```typescript
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <label htmlFor="bot-config-prompt" className="text-xs font-medium text-muted">
        Prompt
      </label>
```

(i.e. drop the now-redundant inner `<div className="flex min-h-0 flex-1 flex-col gap-2">` wrapper — merge its className onto the outer div as shown, and close one fewer `</div>` at the end, right before the `<ConfirmDialog>` elements which stay siblings of the outer div as before.)

- [ ] **Step 3: Remove `HistoryPanel` from `RulesTab.tsx`**

Same pattern: drop the `HistoryPanel` import and its JSX usage (`field="rules"`), collapse the two-column flex wrapper the same way Step 2 did. Read the file first to confirm its exact wrapper structure mirrors `PromptTab.tsx` before editing (it does, per the earlier grep showing identical `<HistoryPanel token={token} field="rules" onRestored={invalidate} />` placement).

- [ ] **Step 4: Remove `HistoryPanel` from `ToolsTab.tsx`**

Same pattern, `field="tools_config"`. Note `ToolsTab.tsx` also contains the "Conversation limits" section (`limits_config`) — that section keeps its own `saveLimits` mutation and `ConfirmDialog` exactly as-is; only the `HistoryPanel` import/JSX and the outer flex-wrapper collapse are touched.

- [ ] **Step 5: Delete the old panel and its test**

```bash
rm frontend/src/surfaces/agent-console/pages/BotConfig/components/HistoryPanel.tsx
rm frontend/src/surfaces/agent-console/pages/BotConfig/components/HistoryPanel.test.tsx
```

- [ ] **Step 6: Run the full frontend suite and typecheck**

Run: `pnpm --filter frontend typecheck && pnpm --filter frontend test -- --run`

Expected: both pass. Fix any snapshot/layout test in `PromptTab.test.tsx`/`RulesTab.test.tsx`/`ToolsTab.test.tsx` (if they exist and assert on the removed flex wrapper or `HistoryPanel` presence) — check for those test files first with `find frontend/src/surfaces/agent-console/pages/BotConfig/components -name "*.test.tsx"` and update any assertion that queries for "History" text or a `Restore` button inside those three tab tests, since that control moved to `VersionHistoryTab`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/BotConfig
git commit -m "feat: replace per-tab HistoryPanel with a shared History tab"
```

---

### Task 9: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full workspace test suite**

Run: `pnpm test`

Expected: all packages pass (Postgres must be up — `pnpm db:setup` if needed).

- [ ] **Step 2: Run the full typecheck**

Run: `pnpm typecheck`

Expected: no errors.

- [ ] **Step 3: Manual smoke test**

Run: `pnpm dev`, open the agent console, navigate to Bot Config as an Admin. Edit the prompt and save — confirm a new "History" tab entry appears as `v2` with a "Prompt" chip. Expand it and confirm the diff shows the changed words highlighted. Click "Restore this version" on `v1`, confirm through the dialog, and confirm the prompt reverts and a new `v3` entry appears (never a mutation of `v1`/`v2`).

- [ ] **Step 4: Confirm OpenAPI docs reflect the new endpoints**

With `pnpm dev` running, open `http://localhost:4000/docs` and confirm `GET /bot-config/versions`, `GET /bot-config/versions/{version}`, and the updated `POST /bot-config/rollback` body all appear correctly, and that `GET /bot-config/history` is gone.
