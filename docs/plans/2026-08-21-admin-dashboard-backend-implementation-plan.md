# Admin Dashboard — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote `admin` from a per-workspace `workspace_member.role` value to a global `agent.is_admin` flag, add `agent.is_super_admin`, add a rotatable `workspace_secret` table with a grace window, and ship the `/admin/*` API a global admin dashboard needs (create workspace, rename, manage members, rotate secret, manage the admin/super-admin flags themselves).

**Architecture:** Two schema migrations (additive columns/table, then a custom migration that backfills and narrows the `workspace_role` enum) land first, followed by an authz layer split in two: `requireAdminRole`/`requireSuperAdminFlag`/`requireTeamLeadOrAdmin` for the still-workspace-session-scoped agent-console routes, and a new `/admin/*` router that authenticates the same session but runs its queries through a dedicated `crm_admin` Postgres role (`BYPASSRLS`) so a single query can read/write across every workspace. Every existing route/test that referenced `workspace_member.role = 'admin'` is migrated in the same pass so the codebase never carries two competing admin concepts.

**Tech Stack:** Express 5, Drizzle ORM + drizzle-kit, PostgreSQL 17 RLS, Zod, Vitest + Supertest — all matching the existing `backend/` conventions; no new dependencies.

## Global Constraints

- No hard deletes anywhere — enforce with `ON DELETE RESTRICT` / soft-delete columns (`deactivated_at`, `revoked_at`), never a DELETE route on a domain row.
- Every scoped table (any table with a `workspace_id` column) gets its RLS policy automatically via the dynamic loop in `002_rls.sql` — never hand-write a policy for a new table.
- `support_app` never gets `BYPASSRLS`; only the new `crm_admin` role does, and only `/admin/*` handlers may use it.
- FK checks bypass RLS — any client-supplied id used as a FK must be confirmed visible with an explicit scoped `SELECT` first (not needed in this plan: every admin endpoint either targets an id already known to be global (`agent`) or reached through a validated route param under `crm_admin`, which sees everything by design).
- `event` and `change_log` stay append-only (`REVOKE UPDATE, DELETE`) for every role, including `crm_admin`.
- Never `console.*` — use `logger` from `backend/src/shared/logging/logger.ts`.
- When adding any new API endpoint, register its route and Zod schema in `backend/src/docs/openapi.ts`.
- Secret values are hashed with sha256 (`workspaceSecret.ts`'s existing `generateWorkspaceSecret`/`secretMatches`) — never logged, never stored raw, returned in a response body exactly once (at creation/rotation).

---

## File Structure

```
backend/src/shared/db/schema/
  identity.ts                 MODIFY: agent gets is_admin/is_super_admin, agent_status gets 'invited';
                               workspace loses secret_hash; new workspaceSecret table
  schema/enums.ts              MODIFY: agentStatus adds 'invited'; workspaceRole drops 'admin'
  schema/index.ts               MODIFY: export workspaceSecret

backend/src/shared/db/sql/
  002_rls.sql                  MODIFY: add crm_admin role (BYPASSRLS + broader grants)

backend/src/shared/db/
  adminClient.ts                NEW: crm_admin pool/db client, parallel to client.ts
  seed.ts                       MODIFY: seed admin via is_admin, seed a workspace_secret row

backend/src/shared/auth/
  workspaceSecret.ts             MODIFY: add secretMatchesAny() for the grace-window check
  playerTokenRoute.ts            MODIFY: check against workspace_secret rows, not workspace.secret_hash

backend/src/shared/middleware/
  requireAdminRole.ts             MODIFY: now checks agent.is_admin globally (export name unchanged)
  requireSuperAdminFlag.ts        NEW: gates on agent.is_super_admin
  requireTeamLeadOrAdmin.ts       NEW: workspace_member.role='team_lead' OR agent.is_admin
  requireWorkspaceRole.ts         MODIFY: WorkspaceRole type drops 'admin'
  requireAdminAccess.ts           NEW: /admin/* gate — session + is_admin, attaches AdminContext
  requireSuperAdminAccess.ts      NEW: /admin/* gate — session + is_super_admin

backend/src/agent/routers/
  botConfigRouter.ts              MODIFY: canSeeBotConfig -> requireTeamLeadOrAdmin
  formsRouter.ts                  MODIFY: canBuildForms -> requireTeamLeadOrAdmin

backend/src/admin/                NEW directory, mirrors backend/src/agent/'s shape
  router.ts
  controllers/
    workspacesController.ts
    membersController.ts
    secretController.ts
    agentsController.ts
  services/
    workspacesService.ts
    membersService.ts
    secretService.ts
    agentsService.ts
  routers/
    workspacesRouter.ts
    agentsRouter.ts

backend/src/app.ts                 MODIFY: mount adminRouter at /admin
backend/src/docs/openapi.ts        MODIFY: register every new /admin/* path

backend/tests/helpers/db.ts        MODIFY: seedAgent gains isAdmin/isSuperAdmin options;
                                    seedWorkspaceMember role type drops 'admin';
                                    new seedWorkspaceSecret helper; seedWorkspace drops secretHash param
backend/tests/schema.test.ts       MODIFY: EXPECTED_TABLES gains workspace_secret,
                                    secret_hash assertion replaced
backend/tests/ticketNumber.test.ts MODIFY: secret_hash privilege assertion moves to workspace_secret
backend/tests/auth.playerToken.test.ts  MODIFY: seed via workspace_secret, not workspace.secret_hash
backend/tests/isolation.test.ts    MODIFY: same
backend/tests/rls.test.ts          MODIFY: same
backend/tests/auth.workspaceRole.test.ts MODIFY: reflects global is_admin semantics
backend/tests/agent.taxonomy.test.ts     MODIFY: seedAgentWithRole('admin') -> global is_admin
backend/tests/agent.botConfig.test.ts    MODIFY: same
backend/tests/formsAdmin.test.ts         MODIFY: same
backend/tests/bot.assignment.test.ts     MODIFY: 'includes admins' test updated (admin no longer a workspace_member row)

backend/tests/admin.workspaces.test.ts   NEW
backend/tests/admin.members.test.ts      NEW
backend/tests/admin.secret.test.ts       NEW
backend/tests/admin.agents.test.ts       NEW
backend/tests/admin.isolation.test.ts    NEW
```

---

### Task 1: Schema — global admin flags and `invited` status

**Files:**

- Modify: `backend/src/shared/db/schema/enums.ts`
- Modify: `backend/src/shared/db/schema/identity.ts`
- Create: (generated) `backend/drizzle/00xx_*.sql`
- Test: `backend/tests/schema.test.ts`

**Interfaces:**

- Produces: `agent.isAdmin: boolean`, `agent.isSuperAdmin: boolean` (Drizzle columns `is_admin`, `is_super_admin`), `agentStatus` enum including `'invited'`. Every later task's `is_admin`/`is_super_admin` checks read these columns.

- [ ] **Step 1: Edit the enum**

In `backend/src/shared/db/schema/enums.ts`, change:

```ts
export const agentStatus = pgEnum('agent_status', ['active', 'on_leave', 'deactivated']);
```

to:

```ts
export const agentStatus = pgEnum('agent_status', ['active', 'on_leave', 'deactivated', 'invited']);
```

- [ ] **Step 2: Add the columns**

In `backend/src/shared/db/schema/identity.ts`, in the `agent` table definition, add two fields after `status`:

```ts
  status: agentStatus('status').notNull().default('active'),
  /** Global: grants access to every workspace. Only a super admin may toggle this. See requireAdminRole. */
  isAdmin: boolean('is_admin').notNull().default(false),
  /** Global: may toggle isAdmin/isSuperAdmin on any agent. */
  isSuperAdmin: boolean('is_super_admin').notNull().default(false),
```

Add `boolean` to the `drizzle-orm/pg-core` import at the top of the file.

- [ ] **Step 3: Generate and inspect the migration**

Run: `pnpm --filter @support/api db:generate`

Expected: a new file under `backend/drizzle/` containing `ALTER TABLE "agent" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;`, `ALTER TABLE "agent" ADD COLUMN "is_super_admin" boolean DEFAULT false NOT NULL;`, and `ALTER TYPE "public"."agent_status" ADD VALUE 'invited';`. Confirm no other diffs are present (a stray unrelated diff means a schema file elsewhere drifted — investigate before continuing).

- [ ] **Step 4: Apply and verify**

Run: `pnpm db:setup`
Expected: exits 0. Then: `psql "$MIGRATION_DATABASE_URL" -c "\d agent"` and confirm `is_admin` and `is_super_admin` both show `boolean not null default false`.

- [ ] **Step 5: Extend the schema test**

In `backend/tests/schema.test.ts`, add after the existing `'carries the two columns the wire contract adds to workspace'` test:

```ts
it('gives agent the two global admin flags, both defaulting false', async () => {
  const cols = await columns('agent');
  expect(cols.get('is_admin')?.nullable).toBe(false);
  expect(cols.get('is_super_admin')?.nullable).toBe(false);
});
```

- [ ] **Step 6: Run and commit**

Run: `pnpm --filter @support/api test schema.test.ts`
Expected: PASS.

```bash
git add backend/src/shared/db/schema/enums.ts backend/src/shared/db/schema/identity.ts backend/drizzle backend/tests/schema.test.ts
git commit -m "Add global agent.is_admin/is_super_admin flags and agent_status 'invited'"
```

---

### Task 2: Schema — `workspace_secret` table, drop `workspace.secret_hash`

**Files:**

- Modify: `backend/src/shared/db/schema/identity.ts`
- Modify: `backend/src/shared/db/schema/index.ts`
- Create: (generated, then hand-edited) `backend/drizzle/00xx_*.sql`
- Test: `backend/tests/schema.test.ts`

**Interfaces:**

- Consumes: `workspace.id` (from Task 1's unchanged `workspace` table).
- Produces: `workspaceSecret` table — `{ id, workspaceId, secretHash, createdAt, expiresAt: Date | null, revokedAt: Date | null }`. Task 4's `playerTokenRoute.ts` and Task 17's secret service both read/write this table.

- [ ] **Step 1: Add the table, remove the old column**

In `backend/src/shared/db/schema/identity.ts`, remove the `secretHash` field from `workspace`:

```ts
  slug: text('slug').notNull().unique(),
  // secretHash removed — see workspaceSecret below.
  ticketSeq: integer('ticket_seq').notNull().default(0),
```

(delete the `secretHash` line and its comment entirely). Then add a new table at the end of the file:

```ts
/**
 * Replaces the single `workspace.secret_hash`. Rotation inserts a new row rather
 * than overwriting one, so the previous secret can keep working for a grace
 * window while a game studio redeploys with the new one. See auth/workspaceSecret.ts.
 */
export const workspaceSecret = pgTable('workspace_secret', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  secretHash: text('secret_hash').notNull(),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  /** Null = no expiry (the current active secret). Set on rotation for the row it replaces. */
  expiresAt: timestamp('expires_at', tz),
  /** Set only if an admin manually revokes ahead of expiry. */
  revokedAt: timestamp('revoked_at', tz),
});
```

- [ ] **Step 2: Export it**

In `backend/src/shared/db/schema/index.ts`, no change is needed — `export * from './identity.ts'` already re-exports every named export from that file, including the new `workspaceSecret`.

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @support/api db:generate`

Expected: a new file containing (in some order) `CREATE TABLE "workspace_secret" (...)` and `ALTER TABLE "workspace" DROP COLUMN "secret_hash";`.

- [ ] **Step 4: Hand-edit the generated file to backfill before dropping**

Open the newly generated file and reorder/insert so it reads exactly:

```sql
CREATE TABLE "workspace_secret" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspace_secret" ADD CONSTRAINT "workspace_secret_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Backfill: every existing workspace's single secret becomes its one active
-- workspace_secret row (expires_at null) before the column it came from is dropped.
INSERT INTO "workspace_secret" (workspace_id, secret_hash)
SELECT id, secret_hash FROM "workspace";
--> statement-breakpoint
ALTER TABLE "workspace" DROP COLUMN "secret_hash";
```

(Keep drizzle-kit's exact generated constraint name and `gen_random_uuid()`/`uuid_generate_v4()` default expression as it actually emitted them — only reorder statements and insert the backfill `INSERT`, do not retype the DDL by hand.)

- [ ] **Step 5: Apply and verify**

Run: `pnpm db:setup`
Expected: exits 0. Then: `psql "$MIGRATION_DATABASE_URL" -c "select count(*) from workspace_secret;"` should equal the current row count of `workspace` (the seed/dev workspace's secret carried over).

- [ ] **Step 6: Update `schema.test.ts`**

Add `'workspace_secret'` to `EXPECTED_TABLES` (alphabetically, after `'subintent'`). Replace the `'carries the two columns the wire contract adds to workspace'` test's `secret_hash` line:

```ts
it('carries the disabled_at column the wire contract adds to workspace', async () => {
  const cols = await columns('workspace');
  expect(cols.get('disabled_at')?.nullable).toBe(true);
  expect(cols.get('secret_hash')).toBeUndefined();
});

it('gives workspace_secret a nullable expiry and revocation, non-null hash', async () => {
  const cols = await columns('workspace_secret');
  expect(cols.get('secret_hash')?.nullable).toBe(false);
  expect(cols.get('expires_at')?.nullable).toBe(true);
  expect(cols.get('revoked_at')?.nullable).toBe(true);
});
```

(rename the `it(...)` title from `'carries the two columns...'` since it now only covers one).

- [ ] **Step 7: Run and commit**

Run: `pnpm --filter @support/api test schema.test.ts`
Expected: PASS.

```bash
git add backend/src/shared/db/schema/identity.ts backend/drizzle backend/tests/schema.test.ts
git commit -m "Replace workspace.secret_hash with rotatable workspace_secret table"
```

---

### Task 3: Migrate `workspace_role` — drop `'admin'`, backfill `agent.is_admin`

**Files:**

- Create (via `drizzle-kit generate --custom`, then hand-written): `backend/drizzle/00xx_migrate_admin_role.sql`
- Modify: `backend/src/shared/db/schema/enums.ts`

**Interfaces:**

- Consumes: `agent.isAdmin` (Task 1), `workspace_member.role` (existing).
- Produces: `workspaceRole` enum with only `'agent' | 'team_lead'`; every agent that held any `workspace_member.role = 'admin'` row now has `agent.is_admin = true` and no such rows remain.

- [ ] **Step 1: Narrow the Drizzle enum**

In `backend/src/shared/db/schema/enums.ts`:

```ts
export const workspaceRole = pgEnum('workspace_role', ['agent', 'team_lead']);
```

- [ ] **Step 2: Scaffold a custom (empty) migration**

Run: `cd backend && pnpm exec drizzle-kit generate --custom --name migrate_admin_role`

Expected: an empty `backend/drizzle/00xx_migrate_admin_role.sql` is created and registered in `backend/drizzle/meta/_journal.json`. (A plain `db:generate` will not produce correct SQL here — narrowing an enum with existing dependent rows needs the backfill-then-recreate sequence below, which drizzle-kit cannot infer.)

- [ ] **Step 3: Write the migration**

Fill in the generated file:

```sql
-- 1. Backfill: every agent who held an 'admin' workspace_member row in ANY
--    workspace becomes globally is_admin. Distinct because the same agent could
--    hold 'admin' in more than one workspace before this migration.
UPDATE agent
   SET is_admin = true
  FROM workspace_member
 WHERE workspace_member.agent_id = agent.id
   AND workspace_member.role = 'admin';
--> statement-breakpoint

-- 2. Those rows are now redundant: an admin has implicit access to every
--    workspace and holds no workspace_member row at all under the new model.
DELETE FROM workspace_member WHERE role = 'admin';
--> statement-breakpoint

-- 3. Postgres has no ALTER TYPE ... DROP VALUE — recreate the enum without it.
CREATE TYPE "workspace_role_new" AS ENUM ('agent', 'team_lead');
--> statement-breakpoint
ALTER TABLE "workspace_member"
  ALTER COLUMN "role" TYPE "workspace_role_new"
  USING "role"::text::"workspace_role_new";
--> statement-breakpoint
DROP TYPE "workspace_role";
--> statement-breakpoint
ALTER TYPE "workspace_role_new" RENAME TO "workspace_role";
```

- [ ] **Step 4: Apply and verify**

Run: `pnpm db:setup`
Expected: exits 0.
Run: `psql "$MIGRATION_DATABASE_URL" -c "select enum_range(NULL::workspace_role);"`
Expected: `{agent,team_lead}`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/shared/db/schema/enums.ts backend/drizzle
git commit -m "Drop workspace_role 'admin', backfill agent.is_admin"
```

(This migration is applied before any of the code changes in Tasks 4–13 land, so those tasks' own tests run against the already-narrowed schema.)

---

### Task 4: Rotatable secret checking — `playerTokenRoute.ts` and `workspaceSecret.ts`

**Files:**

- Modify: `backend/src/shared/auth/workspaceSecret.ts`
- Modify: `backend/src/shared/auth/playerTokenRoute.ts`
- Test: `backend/tests/auth.playerToken.test.ts`

**Interfaces:**

- Consumes: `workspaceSecret` table (Task 2).
- Produces: `secretMatchesAny(raw: string, hashes: readonly string[]): boolean` — used by `playerTokenRoute.ts` and later by Task 17's rotation service indirectly (rotation itself doesn't need this, but keeping the matcher here keeps every secret-comparison code path in one file).

- [ ] **Step 1: Add `secretMatchesAny` to `workspaceSecret.ts`**

Append to `backend/src/shared/auth/workspaceSecret.ts`:

```ts
/** True if `raw` matches ANY of the given hashes — used when a grace-window rotation leaves two active secrets. */
export function secretMatchesAny(raw: string, hashes: readonly string[]): boolean {
  return hashes.some((hash) => secretMatches(raw, hash));
}
```

- [ ] **Step 2: Update `playerTokenRoute.ts`'s lookup**

Replace the existing lookup block:

```ts
const [found] = await withoutWorkspace(async (tx) =>
  tx
    .select({
      id: workspace.id,
      secretHash: workspace.secretHash,
      disabledAt: workspace.disabledAt,
    })
    .from(workspace)
    .where(eq(workspace.slug, parsed.slug))
    .limit(1),
);

// Unknown and disabled are both 404, per the wire contract. The slug itself is not
// a secret — it travels in the X-Support-Workspace header on every SDK request —
// so a 404 revealing "no such slug" is accepted deliberately: a game backend
// operator needs 404 to mean "you typed the slug wrong".
if (!found || !secretMatches(parsed.raw, found.secretHash)) {
  sendError(
    res,
    found ? 401 : 404,
    found ? 'unauthorized' : 'not_found',
    found ? 'Workspace secret is not valid.' : 'Workspace not found.',
  );
  return;
}
if (found.disabledAt) {
  sendError(res, 404, 'not_found', 'Workspace not found.');
  return;
}
```

with:

```ts
const [found] = await withoutWorkspace(async (tx) =>
  tx
    .select({ id: workspace.id, disabledAt: workspace.disabledAt })
    .from(workspace)
    .where(eq(workspace.slug, parsed.slug))
    .limit(1),
);

const activeHashes = found
  ? (
      await withWorkspace(found.id, (tx) =>
        tx
          .select({ secretHash: workspaceSecret.secretHash })
          .from(workspaceSecret)
          .where(
            and(
              eq(workspaceSecret.workspaceId, found.id),
              isNull(workspaceSecret.revokedAt),
              or(isNull(workspaceSecret.expiresAt), gt(workspaceSecret.expiresAt, new Date())),
            ),
          ),
      )
    ).map((row) => row.secretHash)
  : [];

// Unknown and disabled are both 404, per the wire contract. The slug itself is not
// a secret — it travels in the X-Support-Workspace header on every SDK request —
// so a 404 revealing "no such slug" is accepted deliberately: a game backend
// operator needs 404 to mean "you typed the slug wrong".
if (!found || !secretMatchesAny(parsed.raw, activeHashes)) {
  sendError(
    res,
    found ? 401 : 404,
    found ? 'unauthorized' : 'not_found',
    found ? 'Workspace secret is not valid.' : 'Workspace not found.',
  );
  return;
}
if (found.disabledAt) {
  sendError(res, 404, 'not_found', 'Workspace not found.');
  return;
}
```

Update the imports at the top: replace `import { player, workspace } from '../db/schema/index.ts'` with `import { player, workspace, workspaceSecret } from '../db/schema/index.ts'`; replace `import { and, eq, sql } from 'drizzle-orm'` with `import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'`; replace `import { parseWorkspaceSecret, secretMatches } from './workspaceSecret.ts'` with `import { parseWorkspaceSecret, secretMatchesAny } from './workspaceSecret.ts'`.

- [ ] **Step 3: Update the test's seeding**

In `backend/tests/auth.playerToken.test.ts`, find where it seeds via `seedWorkspace({ slug, secretHash, disabledAt })` (around line 22-23) and replace with (Task 5 adds `seedWorkspaceSecret`, so this step depends on it — do Task 5 first if executing out of order, or treat Steps 3 of both tasks as one combined edit):

```ts
const { secret, secretHash } = generateWorkspaceSecret(slug);
const id = await seedWorkspace({ slug, disabledAt });
await seedWorkspaceSecret({ workspaceId: id, secretHash });
```

Add `seedWorkspaceSecret` to the `from './helpers/db.ts'` import.

- [ ] **Step 4: Run and commit**

Run: `pnpm --filter @support/api test auth.playerToken.test.ts`
Expected: PASS (defer full green run until Task 5 lands `seedWorkspaceSecret`, then run again).

```bash
git add backend/src/shared/auth/workspaceSecret.ts backend/src/shared/auth/playerTokenRoute.ts backend/tests/auth.playerToken.test.ts
git commit -m "Check player-token auth against rotatable workspace_secret rows"
```

---

### Task 5: Test helpers — `seedWorkspaceSecret`, `isAdmin`/`isSuperAdmin`, drop `'admin'` from role types

**Files:**

- Modify: `backend/tests/helpers/db.ts`
- Modify: `backend/tests/isolation.test.ts`
- Modify: `backend/tests/rls.test.ts`
- Modify: `backend/tests/ticketNumber.test.ts`

**Interfaces:**

- Produces: `seedWorkspaceSecret(args: { workspaceId: string; secretHash: string; expiresAt?: Date | null; revokedAt?: Date | null }): Promise<string>`; `seedAgent(email?, options?: { isAdmin?: boolean; isSuperAdmin?: boolean }): Promise<string>` (signature widened, backward compatible with existing single-arg call sites); `seedWorkspace`'s `secretHash`/`SCOPED_TABLES` no longer reference workspace's own column.

- [ ] **Step 1: Remove `secretHash` from `seedWorkspace`, add `seedWorkspaceSecret`**

In `backend/tests/helpers/db.ts`, change `seedWorkspace`'s overrides type and body:

```ts
export async function seedWorkspace(
  overrides: {
    id?: string;
    slug?: string;
    name?: string;
    disabledAt?: Date | null;
    autoCloseDays?: number;
  } = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const slug = overrides.slug ?? `ws-${id.slice(0, 8)}`;
  await ownerPool.query(
    `insert into workspace (id, name, slug, disabled_at, auto_close_days)
     values ($1, $2, $3, $4, $5)`,
    [id, overrides.name ?? slug, slug, overrides.disabledAt ?? null, overrides.autoCloseDays ?? 7],
  );
  return id;
}

export async function seedWorkspaceSecret(args: {
  workspaceId: string;
  secretHash: string;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into workspace_secret (id, workspace_id, secret_hash, expires_at, revoked_at) values ($1, $2, $3, $4, $5)`,
    [id, args.workspaceId, args.secretHash, args.expiresAt ?? null, args.revokedAt ?? null],
  );
  return id;
}
```

Add `'workspace_secret'` to `SCOPED_TABLES` (before `'workspace_member'`, since it references `workspace` and must truncate cleanly under `cascade` — position doesn't matter given `cascade`, but keep the list grouped by domain for readability).

- [ ] **Step 2: Widen `seedAgent`**

Replace:

```ts
export async function seedAgent(
  email = `a-${randomUUID().slice(0, 8)}@example.test`,
): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into agent (id, email, display_name) values ($1, $2, 'Test Agent')`,
    [id, email],
  );
  return id;
}
```

with:

```ts
export async function seedAgent(
  email = `a-${randomUUID().slice(0, 8)}@example.test`,
  options: { isAdmin?: boolean; isSuperAdmin?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into agent (id, email, display_name, is_admin, is_super_admin) values ($1, $2, 'Test Agent', $3, $4)`,
    [id, email, options.isAdmin ?? false, options.isSuperAdmin ?? false],
  );
  return id;
}
```

- [ ] **Step 3: Narrow `seedWorkspaceMember`'s role type**

Change:

```ts
export async function seedWorkspaceMember(args: {
  workspaceId: string
  agentId: string
  role?: 'agent' | 'team_lead' | 'admin'
  deactivatedAt?: Date | null
}): Promise<string> {
```

to:

```ts
export async function seedWorkspaceMember(args: {
  workspaceId: string
  agentId: string
  role?: 'agent' | 'team_lead'
  deactivatedAt?: Date | null
}): Promise<string> {
```

(body unchanged).

- [ ] **Step 4: Update the three tests that wrote `workspace.secret_hash` directly**

In `backend/tests/isolation.test.ts`, replace the two `update workspace set secret_hash = $2 where id = $1` calls (around lines 151-157) with inserts into `workspace_secret`:

```ts
await ownerPool.query(`insert into workspace_secret (workspace_id, secret_hash) values ($1, $2)`, [
  workspaceA,
  aSecret.secretHash,
]);
await ownerPool.query(`insert into workspace_secret (workspace_id, secret_hash) values ($1, $2)`, [
  workspaceB,
  bSecret.secretHash,
]);
```

In `backend/tests/rls.test.ts`, replace `insert into workspace (id, name, slug, secret_hash) values ($1, $2, $3, 'x')` (line 47) with `insert into workspace (id, name, slug) values ($1, $2, $3)` (drop the fourth bind param from that call).

In `backend/tests/ticketNumber.test.ts`, replace the `'grants support_app UPDATE on ticket_seq but not on secret_hash'` test:

```ts
it('grants support_app UPDATE on ticket_seq, and no write access to workspace_secret', async () => {
  const { rows: allowed } = await ownerPool.query<{ ok: boolean }>(
    `select has_column_privilege('support_app', 'workspace', 'ticket_seq', 'UPDATE') as ok`,
  );
  expect(allowed[0]!.ok).toBe(true);

  const { rows: denied } = await ownerPool.query<{ ok: boolean }>(
    `select has_table_privilege('support_app', 'workspace_secret', 'INSERT') as ok`,
  );
  expect(denied[0]!.ok).toBe(false);
});
```

(This anticipates Task 11 revoking `workspace_secret` writes from `support_app` — only `crm_admin` may write it. If Task 11 hasn't landed yet when this test runs, it will fail; sequence Tasks 5 and 11 together, or run this specific test only after Task 11.)

- [ ] **Step 5: Run and commit**

Run: `pnpm --filter @support/api test helpers` (helpers have no direct test file; instead run the full suite once Task 11 lands) — for now: `pnpm --filter @support/api test rls.test.ts isolation.test.ts`
Expected: PASS.

```bash
git add backend/tests/helpers/db.ts backend/tests/isolation.test.ts backend/tests/rls.test.ts backend/tests/ticketNumber.test.ts
git commit -m "Update test helpers for workspace_secret table and global admin flags"
```

---

### Task 6: `seed.ts` — dev seed uses global `is_admin`

**Files:**

- Modify: `backend/src/shared/db/seed.ts`

**Interfaces:**

- Consumes: `agent.isAdmin` (Task 1), `workspaceSecret` (Task 2).

- [ ] **Step 1: Seed the workspace secret via the new table**

Find the block writing `workspace` on the owner connection with `secret_hash` (around line 48) and change it to also insert into `workspace_secret`:

```ts
      `insert into workspace (id, name, slug) values ($1, 'Demo Game', $2)
         on conflict (slug) do nothing
         returning id`,
      [randomUUID(), SLUG],
```

then, immediately after that statement resolves and the workspace `id` is known, add:

```ts
await client.query(
  `insert into workspace_secret (workspace_id, secret_hash)
         select id, $2 from workspace where slug = $1
         on conflict do nothing`,
  [SLUG, secretHash],
);
```

(Read the surrounding function fully before editing — the exact variable name holding the resolved workspace id and the `client`/`ownerPool` handle in scope must match what Task 6's implementer sees in the actual file; preserve every other statement in that block unchanged.)

- [ ] **Step 2: Seed the admin via `is_admin`, not a `workspace_member` row**

Find:

```ts
await tx
  .insert(workspaceMember)
  .values({ workspaceId, agentId: adminId, role: 'admin' })
  .onConflictDoNothing();
```

and delete it. Instead, where `adminId` is first resolved (the `agent` upsert near the top of `seed()`), add `isAdmin: true` to that upsert's `.values({...})` and `.onConflictDoUpdate({ ..., set: { ... } })` — mirroring how `displayName` is already set in that same upsert:

```ts
const [admin] = await tx
  .insert(agent)
  .values({ email: ADMIN_EMAIL, displayName: 'Admin Agent', isAdmin: true })
  .onConflictDoUpdate({ target: agent.email, set: { displayName: 'Admin Agent', isAdmin: true } })
  .returning({ id: agent.id });
```

(Read the actual existing admin-upsert block before editing — reuse its exact `displayName` value and query shape, only adding `isAdmin: true` to both the `.values()` and the `.set()`.)

- [ ] **Step 3: Run and commit**

Run: `pnpm db:seed`
Expected: exits 0. Then `psql "$MIGRATION_DATABASE_URL" -c "select email, is_admin from agent where email = 'admin@example.test';"` shows `is_admin = t`.

```bash
git add backend/src/shared/db/seed.ts
git commit -m "Seed dev admin via global is_admin instead of a workspace_member row"
```

---

### Task 7: `requireAdminRole` becomes global; add `requireSuperAdminFlag`

**Files:**

- Modify: `backend/src/shared/middleware/requireAdminRole.ts`
- Create: `backend/src/shared/middleware/requireSuperAdminFlag.ts`
- Test: `backend/tests/auth.workspaceRole.test.ts`

**Interfaces:**

- Consumes: `req.agent: AgentContext` (from `requireAgentSession`, unchanged), `agent.isAdmin`/`agent.isSuperAdmin` (Task 1), `withoutWorkspace` (existing, `shared/db/withWorkspace.ts`).
- Produces: `requireAdminRole: RequestHandler` (same export name, new global semantics — its 11 existing call sites across `taxonomyRouter.ts`, `formsRouter.ts`, `botConfigRouter.ts` need no edits). `requireSuperAdminFlag: RequestHandler`.

- [ ] **Step 1: Rewrite `requireAdminRole.ts`**

```ts
import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { sendError } from '../../errors.ts';
import { agent } from '../db/schema/index.ts';
import { withoutWorkspace } from '../db/withWorkspace.ts';

/**
 * Global, not workspace-scoped: an admin manages every workspace, so this reads
 * agent.is_admin directly rather than a workspace_member role. Kept as the same
 * export name it always had — POST /agent/intents and the other 10 existing call
 * sites need no edit; only what "admin" means underneath changed.
 *
 * agent is one of the two unscoped tables, so this reads it with
 * withoutWorkspace rather than withWorkspace.
 */
export const requireAdminRole: RequestHandler = async (req, res, next) => {
  const ctx = req.agent!;
  const isAdmin = await withoutWorkspace(async (tx) => {
    const [row] = await tx
      .select({ isAdmin: agent.isAdmin })
      .from(agent)
      .where(eq(agent.id, ctx.agentId))
      .limit(1);
    return row?.isAdmin ?? false;
  });

  if (!isAdmin) {
    sendError(res, 403, 'forbidden', 'Requires admin.');
    return;
  }
  next();
};
```

- [ ] **Step 2: Add `requireSuperAdminFlag.ts`**

```ts
import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { sendError } from '../../errors.ts';
import { agent } from '../db/schema/index.ts';
import { withoutWorkspace } from '../db/withWorkspace.ts';

/** Gates grant/revoke of the is_admin and is_super_admin flags themselves. */
export const requireSuperAdminFlag: RequestHandler = async (req, res, next) => {
  const ctx = req.agent!;
  const isSuperAdmin = await withoutWorkspace(async (tx) => {
    const [row] = await tx
      .select({ isSuperAdmin: agent.isSuperAdmin })
      .from(agent)
      .where(eq(agent.id, ctx.agentId))
      .limit(1);
    return row?.isSuperAdmin ?? false;
  });

  if (!isSuperAdmin) {
    sendError(res, 403, 'forbidden', 'Requires super admin.');
    return;
  }
  next();
};
```

- [ ] **Step 3: Rewrite the `requireAdminRole` describe block in `auth.workspaceRole.test.ts`**

Replace the entire `describe('requireAdminRole', ...)` block at the bottom of the file with:

```ts
describe('requireAdminRole (global)', () => {
  it('admits a globally is_admin agent regardless of which workspace their session names', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const adminId = await seedAgent(undefined, { isAdmin: true });
    // Session names workspace A; is_admin is global, so this must still pass —
    // unlike the old per-workspace admin, no workspace_member row exists at all.
    const token = await signAgentSession({ agent_id: adminId, workspace_id: workspaceA });
    await request(app).get('/admins-only').set('Authorization', `Bearer ${token}`).expect(200);
    // Same agent, session naming the OTHER workspace — still admitted, because
    // the flag is global, not tied to either workspace.
    const tokenB = await signAgentSession({ agent_id: adminId, workspace_id: workspaceB });
    await request(app).get('/admins-only').set('Authorization', `Bearer ${tokenB}`).expect(200);
  });

  it('refuses a non-admin agent', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
    await request(app).get('/admins-only').set('Authorization', `Bearer ${token}`).expect(403);
  });
});
```

Add `seedAgent` and `signAgentSession` to the file's imports if not already present (`signAgentSession` already is; add `seedAgent` to the `from './helpers/db.ts'` import list).

The earlier `describe('requireWorkspaceRole', ...)` block's `'admits every role in the set'` test currently loops `for (const role of ['team_lead', 'admin'] as const)` — change the loop to `for (const role of ['team_lead'] as const)` (a single-element loop reads oddly; leave it as a loop rather than collapsing it, so a future third workspace role needs no shape change here) and delete the two `'admin'`-seeding tests that exercised the old per-workspace admin concept (`'refuses an agent with no membership row in this workspace'` and `'refuses a deactivated member regardless of role'`'s admin half) — replace both with the single new describe block from Step 3 above plus a narrowed team-lead-only deactivation test:

```ts
it('refuses a deactivated team lead', async () => {
  const workspaceId = await seedWorkspace();
  const token = await tokenForRole(workspaceId, 'team_lead', { deactivated: true });
  await request(app).get('/leads-and-admins').set('Authorization', `Bearer ${token}`).expect(403);
});
```

Narrow `tokenForRole`'s `role` parameter type from `'agent' | 'team_lead' | 'admin'` to `'agent' | 'team_lead'`, and its `insert into workspace_member` call is unchanged otherwise.

- [ ] **Step 4: Run and commit**

Run: `pnpm --filter @support/api test auth.workspaceRole.test.ts`
Expected: PASS.

```bash
git add backend/src/shared/middleware/requireAdminRole.ts backend/src/shared/middleware/requireSuperAdminFlag.ts backend/tests/auth.workspaceRole.test.ts
git commit -m "Make requireAdminRole check the global is_admin flag; add requireSuperAdminFlag"
```

---

### Task 8: `requireTeamLeadOrAdmin`, narrow `WorkspaceRole`, update the two combined-role routers

**Files:**

- Create: `backend/src/shared/middleware/requireTeamLeadOrAdmin.ts`
- Modify: `backend/src/shared/middleware/requireWorkspaceRole.ts`
- Modify: `backend/src/agent/routers/botConfigRouter.ts`
- Modify: `backend/src/agent/routers/formsRouter.ts`

**Interfaces:**

- Consumes: `requireWorkspaceRole('team_lead')` (existing, now narrower type), `withoutWorkspace`, `agent.isAdmin`.
- Produces: `requireTeamLeadOrAdmin: RequestHandler`, used by `canSeeBotConfig` and `canBuildForms`.

- [ ] **Step 1: Narrow the type**

In `backend/src/shared/middleware/requireWorkspaceRole.ts`, change:

```ts
export type WorkspaceRole = 'agent' | 'team_lead' | 'admin';
```

to:

```ts
export type WorkspaceRole = 'agent' | 'team_lead';
```

(the function body is unchanged — it already reads `workspaceMember.role`, which the database now only ever contains `'agent'`/`'team_lead'` for, per Task 3).

- [ ] **Step 2: Add `requireTeamLeadOrAdmin.ts`**

```ts
import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { sendError } from '../../errors.ts';
import { agent } from '../db/schema/index.ts';
import { withoutWorkspace } from '../db/withWorkspace.ts';
import { requireWorkspaceRole } from './requireWorkspaceRole.ts';

const isTeamLead = requireWorkspaceRole('team_lead');

/**
 * Replaces the old requireWorkspaceRole('team_lead', 'admin') now that admin is
 * global rather than a workspace_member role: a team lead check plus a global
 * is_admin check, either one sufficient. Used where the permission matrix reads
 * "Team Lead, Admin" — see botConfigRouter.ts and formsRouter.ts.
 */
export const requireTeamLeadOrAdmin: RequestHandler = async (req, res, next) => {
  const ctx = req.agent!;
  const isAdmin = await withoutWorkspace(async (tx) => {
    const [row] = await tx
      .select({ isAdmin: agent.isAdmin })
      .from(agent)
      .where(eq(agent.id, ctx.agentId))
      .limit(1);
    return row?.isAdmin ?? false;
  });
  if (isAdmin) {
    next();
    return;
  }
  isTeamLead(req, res, next);
};
```

- [ ] **Step 3: Swap the two call sites**

In `backend/src/agent/routers/botConfigRouter.ts`, replace:

```ts
import { requireWorkspaceRole } from '../../shared/middleware/requireWorkspaceRole.ts';
```

with

```ts
import { requireTeamLeadOrAdmin } from '../../shared/middleware/requireTeamLeadOrAdmin.ts';
```

and replace `const canSeeBotConfig = requireWorkspaceRole('team_lead', 'admin')` with `const canSeeBotConfig = requireTeamLeadOrAdmin`.

Make the identical two edits in `backend/src/agent/routers/formsRouter.ts` (import swap, and `const canBuildForms = requireWorkspaceRole('team_lead', 'admin')` becomes `const canBuildForms = requireTeamLeadOrAdmin`).

- [ ] **Step 4: Update the two test files' `seedAgentWithRole` for `'admin'`**

In `backend/tests/agent.botConfig.test.ts`, change `seedAgentWithRole`'s signature and body:

```ts
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
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
  return { agentId, token };
}
```

(This keeps every existing `seedAgentWithRole(workspaceId, 'admin')` call site in that file working unchanged — 'admin' now means "seed with `is_admin = true`, no `workspace_member` row" instead of "seed a `workspace_member` row with role admin.")

Apply the identical change to `seedAgentWithRole` in `backend/tests/formsAdmin.test.ts` and `backend/tests/agent.taxonomy.test.ts` (that file's version has the narrower `role: 'agent' | 'admin'` signature — widen the same way, keeping its two-value union, and add `is_admin` to its insert).

- [ ] **Step 5: Update `bot.assignment.test.ts`'s admin-inclusion test**

`assignOnHandoff` selects from `workspace_member` only, so a global admin (no `workspace_member` row) is now correctly never a handoff candidate — this is intentional (admins manage, they don't take tickets by default). Replace the test:

```ts
it('includes admins and team leads', async () => {
  const workspaceId = await seedWorkspace();
  const admin = await seedAgent();
  await seedWorkspaceMember({ workspaceId, agentId: admin, role: 'admin' });

  const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
  expect(result).toBe(admin);
});
```

with:

```ts
it('includes team leads', async () => {
  const workspaceId = await seedWorkspace();
  const lead = await seedAgent();
  await seedWorkspaceMember({ workspaceId, agentId: lead, role: 'team_lead' });

  const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
  expect(result).toBe(lead);
});

it('never assigns a global admin, who holds no workspace_member row', async () => {
  const workspaceId = await seedWorkspace();
  const admin = await seedAgent(undefined, { isAdmin: true });
  const active = await seedAgent();
  await seedWorkspaceMember({ workspaceId, agentId: active });

  const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
  expect(result).toBe(active);
});
```

- [ ] **Step 6: Run and commit**

Run: `pnpm --filter @support/api test agent.botConfig.test.ts formsAdmin.test.ts agent.taxonomy.test.ts bot.assignment.test.ts`
Expected: PASS.

```bash
git add backend/src/shared/middleware/requireTeamLeadOrAdmin.ts backend/src/shared/middleware/requireWorkspaceRole.ts backend/src/agent/routers/botConfigRouter.ts backend/src/agent/routers/formsRouter.ts backend/tests/agent.botConfig.test.ts backend/tests/formsAdmin.test.ts backend/tests/agent.taxonomy.test.ts backend/tests/bot.assignment.test.ts
git commit -m "Add requireTeamLeadOrAdmin, migrate all 'team_lead or admin' gates off workspace_role"
```

---

### Task 9: `crm_admin` Postgres role

**Files:**

- Modify: `backend/src/shared/db/sql/002_rls.sql`
- Test: `backend/tests/ticketNumber.test.ts` (Task 5's Step 4 deferred assertion now applies)

**Interfaces:**

- Produces: Postgres role `crm_admin` — `LOGIN`, `BYPASSRLS`, same table grants as `support_app` (`SELECT, INSERT, UPDATE` on every table, `event`/`change_log`/`form_answer` still `REVOKE UPDATE, DELETE`) plus **unrestricted** `INSERT, UPDATE` on `workspace` and full access to `workspace_secret` (both denied to `support_app`).

- [ ] **Step 1: Add the role block**

In `backend/src/shared/db/sql/002_rls.sql`, after the existing `support_app` setup (after the `ALTER DEFAULT PRIVILEGES ... SEQUENCES` block, before the `-- 2 - The event spine is append-only` comment), insert:

```sql
-- 1b - The admin-dashboard role. BYPASSRLS is scoped to exactly this role, and
-- application code may only select it after confirming agent.is_admin — see
-- requireAdminAccess.ts. It still respects table-level grants (BYPASSRLS
-- bypasses row policies, not GRANT/REVOKE), which is why the append-only
-- revokes below are re-applied to it too.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_admin') THEN
    CREATE ROLE crm_admin LOGIN PASSWORD 'crm_admin' BYPASSRLS;
  END IF;
END $$;

ALTER ROLE crm_admin LOGIN PASSWORD 'crm_admin' BYPASSRLS;

REVOKE ALL ON SCHEMA public FROM crm_admin;
GRANT USAGE ON SCHEMA public TO crm_admin;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO crm_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crm_admin;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO crm_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO crm_admin;
```

- [ ] **Step 2: Re-apply the append-only revokes to `crm_admin`**

Immediately after the existing `-- 2 - The event spine is append-only` block's three `REVOKE UPDATE, DELETE ... FROM support_app` / `... FROM PUBLIC` pairs (`event`, `change_log`, `form_answer`), add matching lines for `crm_admin`:

```sql
REVOKE UPDATE, DELETE ON event FROM crm_admin;
REVOKE UPDATE, DELETE ON change_log FROM crm_admin;
REVOKE UPDATE, DELETE ON form_answer FROM crm_admin;
```

(`FROM PUBLIC` is already global and covers `crm_admin` too — only the role-specific revokes need repeating.)

- [ ] **Step 3: Leave `workspace`/`workspace_secret` fully open to `crm_admin`**

Directly below the existing `-- 2b - workspace and agent are the two unscoped tables` comment block (which ends with `GRANT UPDATE (ticket_seq) ON workspace TO support_app;`), add:

```sql
-- crm_admin is exactly the role that IS allowed to write workspace and
-- workspace_secret — that is the whole point of the admin dashboard's
-- create-workspace and rotate-secret endpoints. No narrowing here, unlike the
-- REVOKE above for support_app.
```

(No further SQL needed: the blanket `GRANT SELECT, INSERT, UPDATE ON ALL TABLES` from Step 1 already covers both tables for `crm_admin`, since it runs before the dynamic RLS loop and there is no subsequent `REVOKE` targeting `crm_admin` on either table.)

- [ ] **Step 4: Apply and verify**

Run: `pnpm db:setup`
Expected: exits 0.
Run: `psql "$MIGRATION_DATABASE_URL" -c "select rolname, rolbypassrls from pg_roles where rolname = 'crm_admin';"`
Expected: `rolbypassrls = t`.

- [ ] **Step 5: Run the deferred Task 5 test and commit**

Run: `pnpm --filter @support/api test ticketNumber.test.ts`
Expected: PASS (the `'grants support_app UPDATE on ticket_seq...'` test from Task 5 Step 4 now passes since `support_app` never had `workspace_secret` access to begin with — this assertion was really always true; it's included here for completeness of the role model, not because this task changes `support_app`).

```bash
git add backend/src/shared/db/sql/002_rls.sql
git commit -m "Add crm_admin BYPASSRLS role for the admin dashboard"
```

---

### Task 10: `adminClient.ts` — the `crm_admin` connection pool

**Files:**

- Create: `backend/src/shared/db/adminClient.ts`
- Modify: `backend/src/env.ts`
- Modify: `.env.example` (repo root)

**Interfaces:**

- Produces: `adminDb: NodePgDatabase<typeof schema>`, `closeAdminDb(): Promise<void>` — mirrors `client.ts`'s `db`/`closeDb`. Every Task 14–18 service imports `adminDb` and `withoutWorkspace`-style raw queries against it (no RLS context to set, since `crm_admin` bypasses RLS entirely).

- [ ] **Step 1: Add the env var**

In `backend/src/env.ts`, add to `EnvSchema` right after `DATABASE_URL`:

```ts
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  ADMIN_DATABASE_URL: z.string().min(1, 'ADMIN_DATABASE_URL is required'),
```

- [ ] **Step 2: Document it**

In `.env.example` (repo root), add directly below the existing `DATABASE_URL` line:

```
# The admin dashboard connects as crm_admin: BYPASSRLS, gated in application code
# behind agent.is_admin (see requireAdminAccess.ts). Never used outside /admin/*.
ADMIN_DATABASE_URL=postgres://crm_admin:crm_admin@localhost:5432/support
```

- [ ] **Step 3: Create `adminClient.ts`**

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getEnv } from '../../env.ts';
import { logger } from '../logging/logger.ts';
import * as schema from './schema/index.ts';

/**
 * Connects as crm_admin: BYPASSRLS. Every query run through this client sees
 * every workspace's rows. Import this ONLY from backend/src/admin/** — a
 * non-admin handler reaching for this instead of client.ts's `db` is a tenancy
 * bug, not a style choice.
 */
export const adminPool = new Pool({ connectionString: getEnv().ADMIN_DATABASE_URL, max: 5 });
adminPool.on('error', (err) => {
  logger.error('db.adminPool', `Idle client error: ${err.message}`);
});

export const adminDb = drizzle(adminPool, { schema });

export async function closeAdminDb(): Promise<void> {
  await adminPool.end();
}
```

- [ ] **Step 4: Add to test env**

Find the test env file the suite loads (check `backend/vitest.config.ts` and any `.env.test` in `backend/`) and add the same `ADMIN_DATABASE_URL=postgres://crm_admin:crm_admin@localhost:5432/support` line there (mirroring whatever `DATABASE_URL`/`MIGRATION_DATABASE_URL` are already set to in that file, since all three point at the same local/test database).

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @support/api typecheck`
Expected: passes (no test yet exercises `adminDb` directly — Task 14 is the first consumer).

```bash
git add backend/src/shared/db/adminClient.ts backend/src/env.ts .env.example
git commit -m "Add crm_admin connection pool for the admin dashboard"
```

---

### Task 11: `requireAdminAccess`, `requireSuperAdminAccess` — the `/admin/*` gate

**Files:**

- Create: `backend/src/shared/middleware/requireAdminAccess.ts`
- Create: `backend/src/shared/middleware/requireSuperAdminAccess.ts`
- Test: `backend/tests/admin.isolation.test.ts` (first test in this file; more added by Task 18)

**Interfaces:**

- Consumes: `req.agent: AgentContext` (from `requireAgentSession`, run first — an admin's session still names a workspace, even though `is_admin` grants access beyond it), `adminDb` (Task 10).
- Produces: `requireAdminAccess: RequestHandler` — after this runs, `req.agent!.agentId` is confirmed `is_admin`. `requireSuperAdminAccess: RequestHandler` — additionally confirms `is_super_admin`. Every Task 14–18 router mounts one of these after `requireAgentSession`.

- [ ] **Step 1: `requireAdminAccess.ts`**

```ts
import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { sendError } from '../../errors.ts';
import { adminDb } from '../db/adminClient.ts';
import { agent } from '../db/schema/index.ts';

/**
 * Gates every /admin/* route. Runs after requireAgentSession, which puts the
 * verified claims on req.agent. The read itself goes through crm_admin (agent
 * has no RLS policy regardless — it's one of the two unscoped tables — but every
 * /admin/* handler downstream of this gate uses adminDb, so this check does too,
 * to fail the same way the rest of the route would if crm_admin were misconfigured).
 */
export const requireAdminAccess: RequestHandler = async (req, res, next) => {
  const ctx = req.agent!;
  const [row] = await adminDb
    .select({ isAdmin: agent.isAdmin })
    .from(agent)
    .where(eq(agent.id, ctx.agentId))
    .limit(1);

  if (!row?.isAdmin) {
    sendError(res, 403, 'forbidden', 'Requires admin.');
    return;
  }
  next();
};
```

- [ ] **Step 2: `requireSuperAdminAccess.ts`**

```ts
import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { sendError } from '../../errors.ts';
import { adminDb } from '../db/adminClient.ts';
import { agent } from '../db/schema/index.ts';

/** Gates grant/revoke of is_admin and is_super_admin themselves. Run after requireAdminAccess. */
export const requireSuperAdminAccess: RequestHandler = async (req, res, next) => {
  const ctx = req.agent!;
  const [row] = await adminDb
    .select({ isSuperAdmin: agent.isSuperAdmin })
    .from(agent)
    .where(eq(agent.id, ctx.agentId))
    .limit(1);

  if (!row?.isSuperAdmin) {
    sendError(res, 403, 'forbidden', 'Requires super admin.');
    return;
  }
  next();
};
```

- [ ] **Step 3: Write the first isolation test**

Create `backend/tests/admin.isolation.test.ts`:

```ts
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { requireAdminAccess } from '../src/shared/middleware/requireAdminAccess.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeOwnerPool, seedAgent, seedWorkspace, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use('/admin/probe', requireAgentSession, requireAdminAccess, (_req, res) => {
  res.status(200).json({ ok: true });
});
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('requireAdminAccess', () => {
  it('admits a globally is_admin agent', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent(undefined, { isAdmin: true });
    const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
    await request(app).get('/admin/probe').set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('refuses a non-admin agent with 403', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
    await request(app).get('/admin/probe').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('requires authentication before it can check the flag', async () => {
    await request(app).get('/admin/probe').expect(401);
  });
});
```

- [ ] **Step 4: Run and commit**

Run: `pnpm --filter @support/api test admin.isolation.test.ts`
Expected: PASS.

```bash
git add backend/src/shared/middleware/requireAdminAccess.ts backend/src/shared/middleware/requireSuperAdminAccess.ts backend/tests/admin.isolation.test.ts
git commit -m "Add requireAdminAccess/requireSuperAdminAccess for the /admin/* router"
```

---

### Task 12: Workspaces — list, create

**Files:**

- Create: `backend/src/admin/services/workspacesService.ts`
- Create: `backend/src/admin/controllers/workspacesController.ts`
- Create: `backend/src/admin/routers/workspacesRouter.ts`
- Create: `backend/src/admin/router.ts`
- Test: `backend/tests/admin.workspaces.test.ts`

**Interfaces:**

- Consumes: `adminDb` (Task 10), `workspace`/`workspaceMember` schema.
- Produces: `listWorkspaces(): Promise<WorkspaceSummary[]>`, `createWorkspace(args: { name: string; slug: string }): Promise<{ id: string; name: string; slug: string; createdAt: Date }>` — both consumed by Task 13's rename service file import and Task 19's `admin/router.ts` wiring.

- [ ] **Step 1: `workspacesService.ts`**

```ts
import { count, eq } from 'drizzle-orm';
import { adminDb } from '../../shared/db/adminClient.ts';
import { workspace, workspaceMember } from '../../shared/db/schema/index.ts';

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  member_count: number;
  created_at: Date;
};

/** One query across every workspace — this is what crm_admin's BYPASSRLS is for. */
export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const rows = await adminDb
    .select({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      memberCount: count(workspaceMember.id),
      createdAt: workspace.createdAt,
    })
    .from(workspace)
    .leftJoin(workspaceMember, eq(workspaceMember.workspaceId, workspace.id))
    .groupBy(workspace.id)
    .orderBy(workspace.createdAt);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    member_count: row.memberCount,
    created_at: row.createdAt,
  }));
}

export class SlugTaken extends Error {}

export async function createWorkspace(args: {
  name: string;
  slug: string;
}): Promise<WorkspaceSummary> {
  try {
    const [row] = await adminDb
      .insert(workspace)
      .values({ name: args.name, slug: args.slug })
      .returning({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        createdAt: workspace.createdAt,
      });
    if (!row) throw new Error('workspace insert returned nothing');
    return { ...row, member_count: 0 };
  } catch (error) {
    // Postgres unique_violation
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw new SlugTaken(args.slug);
    }
    throw error;
  }
}
```

- [ ] **Step 2: `workspacesController.ts`**

```ts
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import { createWorkspace, listWorkspaces, SlugTaken } from '../services/workspacesService.ts';

export const listWorkspacesHandler: RequestHandler = async (_req, res) => {
  const workspaces = await listWorkspaces();
  res.status(200).json({ workspaces });
};

const CreateWorkspaceBody = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, numbers, and hyphens'),
});

export const createWorkspaceHandler: RequestHandler = async (req, res) => {
  const body = CreateWorkspaceBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'name or slug is missing or malformed.');
    return;
  }
  try {
    const created = await createWorkspace(body.data);
    res.status(201).json(created);
  } catch (error) {
    if (error instanceof SlugTaken) {
      sendError(res, 422, 'name_taken', 'That slug is already in use.');
      return;
    }
    throw error;
  }
};
```

- [ ] **Step 3: `workspacesRouter.ts`**

```ts
import { Router } from 'express';
import {
  createWorkspaceHandler,
  listWorkspacesHandler,
} from '../controllers/workspacesController.ts';

export const workspacesRouter = Router();
workspacesRouter.get('/workspaces', listWorkspacesHandler);
workspacesRouter.post('/workspaces', createWorkspaceHandler);
```

- [ ] **Step 4: `admin/router.ts`**

```ts
import { Router } from 'express';
import { requireAgentSession } from '../shared/middleware/requireAgentSession.ts';
import { requireAdminAccess } from '../shared/middleware/requireAdminAccess.ts';
import { workspacesRouter } from './routers/workspacesRouter.ts';

export const adminRouter = Router();

adminRouter.use(requireAgentSession);
adminRouter.use(requireAdminAccess);
adminRouter.use(workspacesRouter);
```

(Task 13–18 each add one more `adminRouter.use(...Router)` line here, mirroring `agent/router.ts`'s shape.)

- [ ] **Step 5: `admin.workspaces.test.ts`**

```ts
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { adminRouter } from '../src/admin/router.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function adminToken(workspaceId: string): Promise<string> {
  const agentId = await seedAgent(undefined, { isAdmin: true });
  return signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
}

describe('GET /admin/workspaces', () => {
  it('lists every workspace with its member count, in one call, across tenants', async () => {
    const workspaceA = await seedWorkspace({ name: 'Game A' });
    const workspaceB = await seedWorkspace({ name: 'Game B' });
    const memberAgent = await seedAgent();
    await seedWorkspaceMember({ workspaceId: workspaceA, agentId: memberAgent });
    const token = await adminToken(workspaceA);

    const res = await request(app)
      .get('/admin/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const byId = new Map(res.body.workspaces.map((w: any) => [w.id, w]));
    expect(byId.get(workspaceA)).toMatchObject({ name: 'Game A', member_count: 1 });
    expect(byId.get(workspaceB)).toMatchObject({ name: 'Game B', member_count: 0 });
  });
});

describe('POST /admin/workspaces', () => {
  it('creates a workspace', async () => {
    const workspaceId = await seedWorkspace();
    const token = await adminToken(workspaceId);

    const res = await request(app)
      .post('/admin/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Game', slug: 'new-game' })
      .expect(201);

    expect(res.body).toMatchObject({ name: 'New Game', slug: 'new-game', member_count: 0 });
    const { rows } = await ownerPool.query(`select * from workspace where slug = 'new-game'`);
    expect(rows).toHaveLength(1);
  });

  it('rejects a duplicate slug with 422', async () => {
    const workspaceId = await seedWorkspace({ slug: 'taken' });
    const token = await adminToken(workspaceId);

    await request(app)
      .post('/admin/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Other', slug: 'taken' })
      .expect(422);
  });

  it('refuses a non-admin agent with 403', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId });

    await request(app)
      .post('/admin/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nope', slug: 'nope' })
      .expect(403);
  });
});
```

- [ ] **Step 6: Run and commit**

Run: `pnpm --filter @support/api test admin.workspaces.test.ts`
Expected: PASS.

```bash
git add backend/src/admin backend/tests/admin.workspaces.test.ts
git commit -m "Add GET/POST /admin/workspaces"
```

---

### Task 13: Workspace rename

**Files:**

- Modify: `backend/src/admin/services/workspacesService.ts`
- Modify: `backend/src/admin/controllers/workspacesController.ts`
- Modify: `backend/src/admin/routers/workspacesRouter.ts`
- Modify: `backend/tests/admin.workspaces.test.ts`

**Interfaces:**

- Produces: `renameWorkspace(id: string, name: string): Promise<WorkspaceSummary | null>` — `null` when no row with that id exists.

- [ ] **Step 1: Add `renameWorkspace` to `workspacesService.ts`**

```ts
export async function renameWorkspace(id: string, name: string): Promise<WorkspaceSummary | null> {
  const [row] = await adminDb
    .update(workspace)
    .set({ name })
    .where(eq(workspace.id, id))
    .returning({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      createdAt: workspace.createdAt,
    });
  if (!row) return null;

  const [{ memberCount }] = await adminDb
    .select({ memberCount: count(workspaceMember.id) })
    .from(workspaceMember)
    .where(eq(workspaceMember.workspaceId, id));
  return { ...row, member_count: memberCount };
}
```

- [ ] **Step 2: Add the handler**

In `workspacesController.ts`:

```ts
const RenameWorkspaceBody = z.object({ name: z.string().min(1).max(200) });

export const renameWorkspaceHandler: RequestHandler = async (req, res) => {
  const body = RenameWorkspaceBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'name is missing or malformed.');
    return;
  }
  const updated = await renameWorkspace(req.params.id!, body.data.name);
  if (!updated) {
    sendError(res, 404, 'not_found', 'Workspace not found.');
    return;
  }
  res.status(200).json(updated);
};
```

Add `renameWorkspace` to the `from '../services/workspacesService.ts'` import.

- [ ] **Step 3: Add the route**

In `workspacesRouter.ts`: `workspacesRouter.patch('/workspaces/:id', renameWorkspaceHandler)`, and add `renameWorkspaceHandler` to the controller import.

- [ ] **Step 4: Add tests**

Append to `backend/tests/admin.workspaces.test.ts`:

```ts
describe('PATCH /admin/workspaces/:id', () => {
  it('renames a workspace, leaving its slug untouched', async () => {
    const workspaceId = await seedWorkspace({ name: 'Old Name', slug: 'stays-put' });
    const token = await adminToken(workspaceId);

    const res = await request(app)
      .patch(`/admin/workspaces/${workspaceId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name' })
      .expect(200);

    expect(res.body).toMatchObject({ name: 'New Name', slug: 'stays-put' });
  });

  it('returns 404 for an unknown workspace id', async () => {
    const workspaceId = await seedWorkspace();
    const token = await adminToken(workspaceId);

    await request(app)
      .patch(`/admin/workspaces/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name' })
      .expect(404);
  });
});
```

Add `import { randomUUID } from 'node:crypto'` to the top of the file.

- [ ] **Step 5: Run and commit**

Run: `pnpm --filter @support/api test admin.workspaces.test.ts`
Expected: PASS.

```bash
git add backend/src/admin backend/tests/admin.workspaces.test.ts
git commit -m "Add PATCH /admin/workspaces/:id (name-only rename)"
```

---

### Task 14: Workspace members — list, add, change/remove

**Files:**

- Create: `backend/src/admin/services/membersService.ts`
- Create: `backend/src/admin/controllers/membersController.ts`
- Modify: `backend/src/admin/routers/workspacesRouter.ts`
- Test: `backend/tests/admin.members.test.ts`

**Interfaces:**

- Produces: `listMembers(workspaceId: string): Promise<MemberSummary[]>`, `addMember(args: { workspaceId: string; email: string; role: 'agent' | 'team_lead' }): Promise<MemberSummary>`, `updateMember(args: { workspaceId: string; agentId: string; role?: 'agent' | 'team_lead'; remove?: boolean }): Promise<MemberSummary | null>`.

- [ ] **Step 1: `membersService.ts`**

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { adminDb } from '../../shared/db/adminClient.ts';
import { agent, workspaceMember } from '../../shared/db/schema/index.ts';

export type MemberSummary = {
  agent_id: string;
  email: string;
  display_name: string;
  status: string;
  role: 'agent' | 'team_lead';
};

export async function listMembers(workspaceId: string): Promise<MemberSummary[]> {
  const rows = await adminDb
    .select({
      agentId: agent.id,
      email: agent.email,
      displayName: agent.displayName,
      status: agent.status,
      role: workspaceMember.role,
    })
    .from(workspaceMember)
    .innerJoin(agent, eq(agent.id, workspaceMember.agentId))
    .where(and(eq(workspaceMember.workspaceId, workspaceId), isNull(workspaceMember.deactivatedAt)))
    .orderBy(agent.displayName);

  return rows.map((row) => ({
    agent_id: row.agentId,
    email: row.email,
    display_name: row.displayName,
    status: row.status,
    role: row.role,
  }));
}

/** Upsert: granting access to an email already invited/active in this workspace updates the role instead of erroring. */
export async function addMember(args: {
  workspaceId: string;
  email: string;
  role: 'agent' | 'team_lead';
}): Promise<MemberSummary> {
  // onConflictDoNothing + a defensive re-select, not onConflictDoUpdate with an
  // empty SET (invalid SQL) — mirrors the exact upsert-or-fetch pattern
  // playerTokenRoute.ts already uses for the player upsert, for the same reason:
  // a conflict returns nothing from RETURNING, so the existing row must be
  // fetched explicitly rather than assumed absent.
  const [inserted] = await adminDb
    .insert(agent)
    .values({ email: args.email, displayName: args.email, status: 'invited' })
    .onConflictDoNothing({ target: agent.email })
    .returning({
      id: agent.id,
      email: agent.email,
      displayName: agent.displayName,
      status: agent.status,
    });

  const agentRow =
    inserted ??
    (
      await adminDb
        .select({
          id: agent.id,
          email: agent.email,
          displayName: agent.displayName,
          status: agent.status,
        })
        .from(agent)
        .where(eq(agent.email, args.email))
        .limit(1)
    )[0];
  if (!agentRow) throw new Error('agent upsert-or-fetch returned nothing');

  await adminDb
    .insert(workspaceMember)
    .values({ workspaceId: args.workspaceId, agentId: agentRow.id, role: args.role })
    .onConflictDoUpdate({
      target: [workspaceMember.workspaceId, workspaceMember.agentId],
      set: { role: args.role, deactivatedAt: null },
    });

  return {
    agent_id: agentRow.id,
    email: agentRow.email,
    display_name: agentRow.displayName,
    status: agentRow.status,
    role: args.role,
  };
}

export async function updateMember(args: {
  workspaceId: string;
  agentId: string;
  role?: 'agent' | 'team_lead';
  remove?: boolean;
}): Promise<MemberSummary | null> {
  const [existing] = await adminDb
    .select({ status: agent.status })
    .from(agent)
    .innerJoin(workspaceMember, eq(workspaceMember.agentId, agent.id))
    .where(
      and(
        eq(workspaceMember.workspaceId, args.workspaceId),
        eq(workspaceMember.agentId, args.agentId),
      ),
    )
    .limit(1);
  if (!existing) return null;

  // An invited agent has never signed in — removing them deletes the pending
  // row outright rather than soft-deactivating a membership that never became real.
  if (args.remove && existing.status === 'invited') {
    await adminDb
      .delete(workspaceMember)
      .where(
        and(
          eq(workspaceMember.workspaceId, args.workspaceId),
          eq(workspaceMember.agentId, args.agentId),
        ),
      );
    return null;
  }

  const [row] = await adminDb
    .update(workspaceMember)
    .set({
      role: args.role,
      deactivatedAt: args.remove ? new Date() : undefined,
    })
    .where(
      and(
        eq(workspaceMember.workspaceId, args.workspaceId),
        eq(workspaceMember.agentId, args.agentId),
      ),
    )
    .returning({ role: workspaceMember.role });
  if (!row) return null;

  const [agentRow] = await adminDb
    .select({ email: agent.email, displayName: agent.displayName, status: agent.status })
    .from(agent)
    .where(eq(agent.id, args.agentId))
    .limit(1);

  return {
    agent_id: args.agentId,
    email: agentRow!.email,
    display_name: agentRow!.displayName,
    status: agentRow!.status,
    role: row.role,
  };
}
```

- [ ] **Step 2: `membersController.ts`**

```ts
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import { addMember, listMembers, updateMember } from '../services/membersService.ts';

export const listMembersHandler: RequestHandler = async (req, res) => {
  const members = await listMembers(req.params.id!);
  res.status(200).json({ members });
};

const AddMemberBody = z.object({
  email: z.email(),
  role: z.enum(['agent', 'team_lead']),
});

export const addMemberHandler: RequestHandler = async (req, res) => {
  const body = AddMemberBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'email or role is missing or malformed.');
    return;
  }
  const member = await addMember({
    workspaceId: req.params.id!,
    email: body.data.email,
    role: body.data.role,
  });
  res.status(201).json(member);
};

const UpdateMemberBody = z.object({
  role: z.enum(['agent', 'team_lead']).optional(),
  remove: z.boolean().optional(),
});

export const updateMemberHandler: RequestHandler = async (req, res) => {
  const body = UpdateMemberBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'role or remove is malformed.');
    return;
  }
  const result = await updateMember({
    workspaceId: req.params.id!,
    agentId: req.params.agentId!,
    role: body.data.role,
    remove: body.data.remove,
  });
  if (result === null && !body.data.remove) {
    sendError(res, 404, 'not_found', 'Member not found in this workspace.');
    return;
  }
  res.status(200).json(result ?? { removed: true });
};
```

- [ ] **Step 3: Wire the routes**

In `workspacesRouter.ts`, add:

```ts
import {
  addMemberHandler,
  listMembersHandler,
  updateMemberHandler,
} from '../controllers/membersController.ts';
```

```ts
workspacesRouter.get('/workspaces/:id/members', listMembersHandler);
workspacesRouter.post('/workspaces/:id/members', addMemberHandler);
workspacesRouter.patch('/workspaces/:id/members/:agentId', updateMemberHandler);
```

- [ ] **Step 4: `admin.members.test.ts`**

```ts
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { adminRouter } from '../src/admin/router.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function adminToken(workspaceId: string): Promise<string> {
  const agentId = await seedAgent(undefined, { isAdmin: true });
  return signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
}

describe('POST /admin/workspaces/:id/members', () => {
  it('invites a brand-new email, creating a pending agent row', async () => {
    const workspaceId = await seedWorkspace();
    const token = await adminToken(workspaceId);

    const res = await request(app)
      .post(`/admin/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'new-hire@mindstormstudios.com', role: 'agent' })
      .expect(201);

    expect(res.body).toMatchObject({
      email: 'new-hire@mindstormstudios.com',
      role: 'agent',
      status: 'invited',
    });
    const { rows } = await ownerPool.query(
      `select status from agent where email = 'new-hire@mindstormstudios.com'`,
    );
    expect(rows[0].status).toBe('invited');
  });

  it('upserts the role when the email is already a member', async () => {
    const workspaceId = await seedWorkspace();
    const existing = await seedAgent('already-here@mindstormstudios.com');
    await seedWorkspaceMember({ workspaceId, agentId: existing, role: 'agent' });
    const token = await adminToken(workspaceId);

    const res = await request(app)
      .post(`/admin/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'already-here@mindstormstudios.com', role: 'team_lead' })
      .expect(201);

    expect(res.body.role).toBe('team_lead');
    const { rows } = await ownerPool.query(
      `select role from workspace_member where workspace_id = $1 and agent_id = $2`,
      [workspaceId, existing],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('team_lead');
  });
});

describe('GET /admin/workspaces/:id/members', () => {
  it('lists active members with their role', async () => {
    const workspaceId = await seedWorkspace();
    const leadId = await seedAgent('lead@mindstormstudios.com');
    await seedWorkspaceMember({ workspaceId, agentId: leadId, role: 'team_lead' });
    const token = await adminToken(workspaceId);

    const res = await request(app)
      .get(`/admin/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.members).toEqual([
      expect.objectContaining({
        agent_id: leadId,
        role: 'team_lead',
        email: 'lead@mindstormstudios.com',
      }),
    ]);
  });
});

describe('PATCH /admin/workspaces/:id/members/:agentId', () => {
  it('changes a member role', async () => {
    const workspaceId = await seedWorkspace();
    const memberId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: memberId, role: 'agent' });
    const token = await adminToken(workspaceId);

    const res = await request(app)
      .patch(`/admin/workspaces/${workspaceId}/members/${memberId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'team_lead' })
      .expect(200);

    expect(res.body.role).toBe('team_lead');
  });

  it('removes access by setting deactivated_at, not deleting the row, for an already-active member', async () => {
    const workspaceId = await seedWorkspace();
    const memberId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: memberId, role: 'agent' });
    const token = await adminToken(workspaceId);

    await request(app)
      .patch(`/admin/workspaces/${workspaceId}/members/${memberId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ remove: true })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select deactivated_at from workspace_member where workspace_id = $1 and agent_id = $2`,
      [workspaceId, memberId],
    );
    expect(rows[0].deactivated_at).not.toBeNull();
  });

  it('deletes the pending row outright when removing an invited (never-logged-in) member', async () => {
    const workspaceId = await seedWorkspace();
    const token = await adminToken(workspaceId);
    const created = await request(app)
      .post(`/admin/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'pending@mindstormstudios.com', role: 'agent' })
      .expect(201);

    await request(app)
      .patch(`/admin/workspaces/${workspaceId}/members/${created.body.agent_id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ remove: true })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select * from workspace_member where workspace_id = $1 and agent_id = $2`,
      [workspaceId, created.body.agent_id],
    );
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 5: Run and commit**

Run: `pnpm --filter @support/api test admin.members.test.ts`
Expected: PASS.

```bash
git add backend/src/admin backend/tests/admin.members.test.ts
git commit -m "Add /admin/workspaces/:id/members list/add/update"
```

---

### Task 15: Workspace secret — view metadata, rotate

**Files:**

- Create: `backend/src/admin/services/secretService.ts`
- Create: `backend/src/admin/controllers/secretController.ts`
- Modify: `backend/src/admin/routers/workspacesRouter.ts`
- Test: `backend/tests/admin.secret.test.ts`

**Interfaces:**

- Consumes: `generateWorkspaceSecret` (existing, `shared/auth/workspaceSecret.ts`).
- Produces: `getSecretMetadata(workspaceId: string): Promise<{ created_at: Date; expires_at: Date | null }[]>`, `rotateSecret(workspaceId: string, slug: string): Promise<{ secret: string; created_at: Date }>`.

- [ ] **Step 1: `secretService.ts`**

```ts
import { and, desc, eq, isNull } from 'drizzle-orm';
import { adminDb } from '../../shared/db/adminClient.ts';
import { workspaceSecret } from '../../shared/db/schema/index.ts';
import { generateWorkspaceSecret } from '../../shared/auth/workspaceSecret.ts';

const GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SecretMetadata = { created_at: Date; expires_at: Date | null };

export async function getSecretMetadata(workspaceId: string): Promise<SecretMetadata[]> {
  const rows = await adminDb
    .select({ createdAt: workspaceSecret.createdAt, expiresAt: workspaceSecret.expiresAt })
    .from(workspaceSecret)
    .where(and(eq(workspaceSecret.workspaceId, workspaceId), isNull(workspaceSecret.revokedAt)))
    .orderBy(desc(workspaceSecret.createdAt));

  return rows.map((row) => ({ created_at: row.createdAt, expires_at: row.expiresAt }));
}

/**
 * Inserts the new secret and gives the previous active row a 24h grace window
 * rather than invalidating it immediately, so a game studio can redeploy its
 * backend with the new secret without an outage. Returns the raw secret exactly
 * once — it is never retrievable again after this call returns.
 */
export async function rotateSecret(
  workspaceId: string,
  slug: string,
): Promise<{ secret: string; created_at: Date }> {
  const { secret, secretHash } = generateWorkspaceSecret(slug);

  await adminDb
    .update(workspaceSecret)
    .set({ expiresAt: new Date(Date.now() + GRACE_WINDOW_MS) })
    .where(
      and(
        eq(workspaceSecret.workspaceId, workspaceId),
        isNull(workspaceSecret.expiresAt),
        isNull(workspaceSecret.revokedAt),
      ),
    );

  const [row] = await adminDb
    .insert(workspaceSecret)
    .values({ workspaceId, secretHash })
    .returning({ createdAt: workspaceSecret.createdAt });
  if (!row) throw new Error('workspace_secret insert returned nothing');

  return { secret, created_at: row.createdAt };
}
```

- [ ] **Step 2: `secretController.ts`**

```ts
import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { sendError } from '../../errors.ts';
import { adminDb } from '../../shared/db/adminClient.ts';
import { workspace } from '../../shared/db/schema/index.ts';
import { getSecretMetadata, rotateSecret } from '../services/secretService.ts';

export const getSecretHandler: RequestHandler = async (req, res) => {
  const metadata = await getSecretMetadata(req.params.id!);
  res.status(200).json({ secrets: metadata });
};

export const rotateSecretHandler: RequestHandler = async (req, res) => {
  const [ws] = await adminDb
    .select({ slug: workspace.slug })
    .from(workspace)
    .where(eq(workspace.id, req.params.id!))
    .limit(1);
  if (!ws) {
    sendError(res, 404, 'not_found', 'Workspace not found.');
    return;
  }
  const rotated = await rotateSecret(req.params.id!, ws.slug);
  res.status(201).json(rotated);
};
```

- [ ] **Step 3: Wire the routes**

In `workspacesRouter.ts`:

```ts
import { getSecretHandler, rotateSecretHandler } from '../controllers/secretController.ts';
```

```ts
workspacesRouter.get('/workspaces/:id/secret', getSecretHandler);
workspacesRouter.post('/workspaces/:id/secret/rotate', rotateSecretHandler);
```

- [ ] **Step 4: `admin.secret.test.ts`**

```ts
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { adminRouter } from '../src/admin/router.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import {
  hashSecret,
  parseWorkspaceSecret,
  secretMatches,
} from '../src/shared/auth/workspaceSecret.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedWorkspace,
  seedWorkspaceSecret,
  truncateAll,
} from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function adminToken(workspaceId: string): Promise<string> {
  const agentId = await seedAgent(undefined, { isAdmin: true });
  return signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
}

describe('POST /admin/workspaces/:id/secret/rotate', () => {
  it('returns a new raw secret once and gives the old row a 24h expiry', async () => {
    const workspaceId = await seedWorkspace({ slug: 'rotate-me' });
    await seedWorkspaceSecret({ workspaceId, secretHash: hashSecret('old-raw-secret') });
    const token = await adminToken(workspaceId);

    const res = await request(app)
      .post(`/admin/workspaces/${workspaceId}/secret/rotate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    const parsed = parseWorkspaceSecret(res.body.secret);
    expect(parsed?.slug).toBe('rotate-me');
    expect(secretMatches(parsed!.raw, hashSecret(parsed!.raw))).toBe(true);

    const { rows } = await ownerPool.query(
      `select expires_at from workspace_secret where workspace_id = $1 and secret_hash = $2`,
      [workspaceId, hashSecret('old-raw-secret')],
    );
    expect(rows[0].expires_at).not.toBeNull();
  });
});

describe('GET /admin/workspaces/:id/secret', () => {
  it('never returns the raw secret, only metadata', async () => {
    const workspaceId = await seedWorkspace();
    await seedWorkspaceSecret({ workspaceId, secretHash: hashSecret('some-secret') });
    const token = await adminToken(workspaceId);

    const res = await request(app)
      .get(`/admin/workspaces/${workspaceId}/secret`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.secrets).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('some-secret');
    expect(res.body.secrets[0]).not.toHaveProperty('secret_hash');
  });
});
```

- [ ] **Step 5: Run and commit**

Run: `pnpm --filter @support/api test admin.secret.test.ts`
Expected: PASS.

```bash
git add backend/src/admin backend/tests/admin.secret.test.ts
git commit -m "Add /admin/workspaces/:id/secret get and rotate (24h grace window)"
```

---

### Task 16: Agent directory, admin/super-admin grant

**Files:**

- Create: `backend/src/admin/services/agentsService.ts`
- Create: `backend/src/admin/controllers/agentsController.ts`
- Create: `backend/src/admin/routers/agentsRouter.ts`
- Modify: `backend/src/admin/router.ts`
- Test: `backend/tests/admin.agents.test.ts`

**Interfaces:**

- Produces: `listAgents(query?: string): Promise<AgentSummary[]>`, `setAdminFlag(args: { targetAgentId: string; callerAgentId: string; isAdmin: boolean }): Promise<AgentSummary>` (throws `SelfDemotion`), `setSuperAdminFlag(args: { targetAgentId: string; callerAgentId: string; isSuperAdmin: boolean }): Promise<AgentSummary>` (throws `SelfDemotion` or `LastSuperAdmin`).

- [ ] **Step 1: `agentsService.ts`**

```ts
import { count, eq, ilike, or } from 'drizzle-orm';
import { adminDb } from '../../shared/db/adminClient.ts';
import { agent } from '../../shared/db/schema/index.ts';

export type AgentSummary = {
  id: string;
  email: string;
  display_name: string;
  status: string;
  is_admin: boolean;
  is_super_admin: boolean;
};

function toSummary(row: {
  id: string;
  email: string;
  displayName: string;
  status: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}): AgentSummary {
  return {
    id: row.id,
    email: row.email,
    display_name: row.displayName,
    status: row.status,
    is_admin: row.isAdmin,
    is_super_admin: row.isSuperAdmin,
  };
}

export async function listAgents(query?: string): Promise<AgentSummary[]> {
  const rows = await adminDb
    .select({
      id: agent.id,
      email: agent.email,
      displayName: agent.displayName,
      status: agent.status,
      isAdmin: agent.isAdmin,
      isSuperAdmin: agent.isSuperAdmin,
    })
    .from(agent)
    .where(
      query
        ? or(ilike(agent.email, `%${query}%`), ilike(agent.displayName, `%${query}%`))
        : undefined,
    )
    .orderBy(agent.displayName);

  return rows.map(toSummary);
}

export class SelfDemotion extends Error {}
export class LastSuperAdmin extends Error {}

export async function setAdminFlag(args: {
  targetAgentId: string;
  callerAgentId: string;
  isAdmin: boolean;
}): Promise<AgentSummary> {
  if (!args.isAdmin && args.targetAgentId === args.callerAgentId) {
    throw new SelfDemotion();
  }
  const [row] = await adminDb
    .update(agent)
    .set({ isAdmin: args.isAdmin })
    .where(eq(agent.id, args.targetAgentId))
    .returning({
      id: agent.id,
      email: agent.email,
      displayName: agent.displayName,
      status: agent.status,
      isAdmin: agent.isAdmin,
      isSuperAdmin: agent.isSuperAdmin,
    });
  if (!row) throw new Error('agent not found');
  return toSummary(row);
}

export async function setSuperAdminFlag(args: {
  targetAgentId: string;
  callerAgentId: string;
  isSuperAdmin: boolean;
}): Promise<AgentSummary> {
  if (!args.isSuperAdmin && args.targetAgentId === args.callerAgentId) {
    throw new SelfDemotion();
  }
  if (!args.isSuperAdmin) {
    const [{ remaining }] = await adminDb
      .select({ remaining: count() })
      .from(agent)
      .where(eq(agent.isSuperAdmin, true));
    if (remaining <= 1) throw new LastSuperAdmin();
  }
  const [row] = await adminDb
    .update(agent)
    .set({ isSuperAdmin: args.isSuperAdmin })
    .where(eq(agent.id, args.targetAgentId))
    .returning({
      id: agent.id,
      email: agent.email,
      displayName: agent.displayName,
      status: agent.status,
      isAdmin: agent.isAdmin,
      isSuperAdmin: agent.isSuperAdmin,
    });
  if (!row) throw new Error('agent not found');
  return toSummary(row);
}
```

- [ ] **Step 2: `agentsController.ts`**

```ts
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import {
  LastSuperAdmin,
  listAgents,
  SelfDemotion,
  setAdminFlag,
  setSuperAdminFlag,
} from '../services/agentsService.ts';

export const listAgentsHandler: RequestHandler = async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q : undefined;
  const agents = await listAgents(query);
  res.status(200).json({ agents });
};

export const setAdminHandler: RequestHandler = async (req, res) => {
  const body = z.object({ is_admin: z.boolean() }).safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'is_admin is missing or malformed.');
    return;
  }
  try {
    const updated = await setAdminFlag({
      targetAgentId: req.params.id!,
      callerAgentId: req.agent!.agentId,
      isAdmin: body.data.is_admin,
    });
    res.status(200).json(updated);
  } catch (error) {
    if (error instanceof SelfDemotion) {
      sendError(res, 422, 'invalid_value', 'A super admin cannot revoke their own admin access.');
      return;
    }
    throw error;
  }
};

export const setSuperAdminHandler: RequestHandler = async (req, res) => {
  const body = z.object({ is_super_admin: z.boolean() }).safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'is_super_admin is missing or malformed.');
    return;
  }
  try {
    const updated = await setSuperAdminFlag({
      targetAgentId: req.params.id!,
      callerAgentId: req.agent!.agentId,
      isSuperAdmin: body.data.is_super_admin,
    });
    res.status(200).json(updated);
  } catch (error) {
    if (error instanceof SelfDemotion) {
      sendError(
        res,
        422,
        'invalid_value',
        'A super admin cannot revoke their own super admin access.',
      );
      return;
    }
    if (error instanceof LastSuperAdmin) {
      sendError(res, 422, 'invalid_value', 'Cannot remove the last super admin.');
      return;
    }
    throw error;
  }
};
```

- [ ] **Step 3: `agentsRouter.ts`**

```ts
import { Router } from 'express';
import { requireSuperAdminAccess } from '../../shared/middleware/requireSuperAdminAccess.ts';
import {
  listAgentsHandler,
  setAdminHandler,
  setSuperAdminHandler,
} from '../controllers/agentsController.ts';

export const agentsRouter = Router();
agentsRouter.get('/agents', listAgentsHandler);
agentsRouter.patch('/agents/:id/admin', requireSuperAdminAccess, setAdminHandler);
agentsRouter.patch('/agents/:id/super-admin', requireSuperAdminAccess, setSuperAdminHandler);
```

- [ ] **Step 4: Wire into `admin/router.ts`**

Add `import { agentsRouter } from './routers/agentsRouter.ts'` and `adminRouter.use(agentsRouter)` after the existing `adminRouter.use(workspacesRouter)` line.

- [ ] **Step 5: `admin.agents.test.ts`**

```ts
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { adminRouter } from '../src/admin/router.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeOwnerPool, seedAgent, seedWorkspace, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('GET /admin/agents', () => {
  it('lists the directory, filterable by email/name', async () => {
    const workspaceId = await seedWorkspace();
    const admin = await seedAgent('super@mindstormstudios.com', {
      isAdmin: true,
      isSuperAdmin: true,
    });
    await seedAgent('nomatch@mindstormstudios.com');
    const token = await signAgentSession({ agent_id: admin, workspace_id: workspaceId });

    const res = await request(app)
      .get('/admin/agents?q=super')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0]).toMatchObject({
      email: 'super@mindstormstudios.com',
      is_admin: true,
      is_super_admin: true,
    });
  });
});

describe('PATCH /admin/agents/:id/admin', () => {
  it('super admin grants admin to another agent', async () => {
    const workspaceId = await seedWorkspace();
    const superAdmin = await seedAgent('super@mindstormstudios.com', {
      isAdmin: true,
      isSuperAdmin: true,
    });
    const target = await seedAgent('target@mindstormstudios.com');
    const token = await signAgentSession({ agent_id: superAdmin, workspace_id: workspaceId });

    const res = await request(app)
      .patch(`/admin/agents/${target}/admin`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_admin: true })
      .expect(200);

    expect(res.body.is_admin).toBe(true);
  });

  it('refuses a plain admin (not super admin) with 403', async () => {
    const workspaceId = await seedWorkspace();
    const plainAdmin = await seedAgent('admin@mindstormstudios.com', { isAdmin: true });
    const target = await seedAgent('target@mindstormstudios.com');
    const token = await signAgentSession({ agent_id: plainAdmin, workspace_id: workspaceId });

    await request(app)
      .patch(`/admin/agents/${target}/admin`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_admin: true })
      .expect(403);
  });
});

describe('PATCH /admin/agents/:id/super-admin', () => {
  it('blocks a super admin from revoking their own flag', async () => {
    const workspaceId = await seedWorkspace();
    const superAdmin = await seedAgent('super@mindstormstudios.com', {
      isAdmin: true,
      isSuperAdmin: true,
    });
    // A second super admin so "last super admin" is not the reason for the 422.
    await seedAgent('other-super@mindstormstudios.com', { isAdmin: true, isSuperAdmin: true });
    const token = await signAgentSession({ agent_id: superAdmin, workspace_id: workspaceId });

    await request(app)
      .patch(`/admin/agents/${superAdmin}/super-admin`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_super_admin: false })
      .expect(422);
  });

  it('blocks revoking the last super admin', async () => {
    const workspaceId = await seedWorkspace();
    const onlySuperAdmin = await seedAgent('only-super@mindstormstudios.com', {
      isAdmin: true,
      isSuperAdmin: true,
    });
    const otherAdmin = await seedAgent('admin2@mindstormstudios.com', {
      isAdmin: true,
      isSuperAdmin: true,
    });
    const token = await signAgentSession({ agent_id: otherAdmin, workspace_id: workspaceId });

    await request(app)
      .patch(`/admin/agents/${onlySuperAdmin}/super-admin`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_super_admin: false })
      .expect(200); // otherAdmin revoking onlySuperAdmin is fine — two exist before this call

    // Now only `otherAdmin` remains a super admin — revoking them must be blocked.
    await request(app)
      .patch(`/admin/agents/${otherAdmin}/super-admin`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_super_admin: false })
      .expect(422);
  });
});
```

- [ ] **Step 6: Run and commit**

Run: `pnpm --filter @support/api test admin.agents.test.ts`
Expected: PASS. Note the second test in the `super-admin` block asserts a 422 on an agent revoking their own flag as the SECOND call — re-check against `setSuperAdminFlag`'s ordering (self-demotion is checked before the last-super-admin count), so that call correctly 422s on `SelfDemotion` rather than `LastSuperAdmin`; both map to 422 so the test's `.expect(422)` holds either way, but if a future change makes the two distinguishable at the HTTP layer, update this test's expected error code accordingly.

```bash
git add backend/src/admin backend/tests/admin.agents.test.ts
git commit -m "Add agent directory and admin/super-admin grant endpoints"
```

---

### Task 17: Mount `/admin` in `app.ts`, register everything in `openapi.ts`

**Files:**

- Modify: `backend/src/app.ts`
- Modify: `backend/src/docs/openapi.ts`

**Interfaces:**

- Consumes: `adminRouter` (Task 12).

- [ ] **Step 1: Mount the router**

In `backend/src/app.ts`, add the import alongside the existing router imports:

```ts
import { adminRouter } from './admin/router.ts';
```

and mount it alongside the existing `app.use('/agent', agentRouter)` line:

```ts
app.use('/admin', adminRouter);
```

- [ ] **Step 2: Register OpenAPI schemas**

In `backend/src/docs/openapi.ts`, add near the other component schema definitions:

```ts
const WorkspaceSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  member_count: z.number().int().nonnegative(),
  created_at: z.string(),
});

const CreateWorkspaceBodySchema = z.object({
  name: z.string().min(1).max(200).openapi({ example: 'My New Game' }),
  slug: z.string().min(1).max(63).openapi({ example: 'my-new-game' }),
});

const RenameWorkspaceBodySchema = z.object({ name: z.string().min(1).max(200) });

const MemberSummarySchema = z.object({
  agent_id: z.uuid(),
  email: z.string(),
  display_name: z.string(),
  status: z.enum(['active', 'on_leave', 'deactivated', 'invited']),
  role: z.enum(['agent', 'team_lead']),
});

const AddMemberBodySchema = z.object({
  email: z.email().openapi({ example: 'new-hire@mindstormstudios.com' }),
  role: z.enum(['agent', 'team_lead']),
});

const UpdateMemberBodySchema = z.object({
  role: z.enum(['agent', 'team_lead']).optional(),
  remove: z.boolean().optional(),
});

const SecretMetadataSchema = z.object({
  created_at: z.string(),
  expires_at: z.string().nullable(),
});

const RotatedSecretSchema = z.object({
  secret: z.string().openapi({ description: 'Raw secret — shown exactly once.' }),
  created_at: z.string(),
});

const AgentSummarySchema = z.object({
  id: z.uuid(),
  email: z.string(),
  display_name: z.string(),
  status: z.enum(['active', 'on_leave', 'deactivated', 'invited']),
  is_admin: z.boolean(),
  is_super_admin: z.boolean(),
});

const bearerAgentSession = registry.registerComponent('securitySchemes', 'AgentSessionAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description:
    'Agent session JWT — the caller must additionally have agent.is_admin = true for every /admin/* route.',
});

registry.registerPath({
  method: 'get',
  path: '/admin/workspaces',
  summary: 'List All Workspaces',
  security: [{ [bearerAgentSession.name]: [] }],
  responses: {
    200: {
      description: 'Every workspace with its member count',
      content: {
        'application/json': { schema: z.object({ workspaces: z.array(WorkspaceSummarySchema) }) },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/admin/workspaces',
  summary: 'Create Workspace',
  security: [{ [bearerAgentSession.name]: [] }],
  request: { body: { content: { 'application/json': { schema: CreateWorkspaceBodySchema } } } },
  responses: {
    201: {
      description: 'Workspace created',
      content: { 'application/json': { schema: WorkspaceSummarySchema } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/admin/workspaces/{id}',
  summary: 'Rename Workspace',
  security: [{ [bearerAgentSession.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: RenameWorkspaceBodySchema } } },
  },
  responses: {
    200: {
      description: 'Workspace renamed',
      content: { 'application/json': { schema: WorkspaceSummarySchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/admin/workspaces/{id}/members',
  summary: 'List Workspace Members',
  security: [{ [bearerAgentSession.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'Active members',
      content: {
        'application/json': { schema: z.object({ members: z.array(MemberSummarySchema) }) },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/admin/workspaces/{id}/members',
  summary: 'Grant Workspace Access',
  security: [{ [bearerAgentSession.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: AddMemberBodySchema } } },
  },
  responses: {
    201: {
      description: 'Member granted',
      content: { 'application/json': { schema: MemberSummarySchema } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/admin/workspaces/{id}/members/{agentId}',
  summary: 'Change Or Remove Member Access',
  security: [{ [bearerAgentSession.name]: [] }],
  request: {
    params: z.object({ id: z.uuid(), agentId: z.uuid() }),
    body: { content: { 'application/json': { schema: UpdateMemberBodySchema } } },
  },
  responses: {
    200: {
      description: 'Member updated or removed',
      content: { 'application/json': { schema: MemberSummarySchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/admin/workspaces/{id}/secret',
  summary: 'Get Workspace Secret Metadata',
  security: [{ [bearerAgentSession.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'Metadata only — never the raw secret',
      content: {
        'application/json': { schema: z.object({ secrets: z.array(SecretMetadataSchema) }) },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/admin/workspaces/{id}/secret/rotate',
  summary: 'Rotate Workspace Secret',
  description:
    'The old secret keeps working for a 24h grace window. The raw new secret is returned exactly once, here.',
  security: [{ [bearerAgentSession.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    201: {
      description: 'New secret minted',
      content: { 'application/json': { schema: RotatedSecretSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/admin/agents',
  summary: 'Agent Directory',
  security: [{ [bearerAgentSession.name]: [] }],
  request: { query: z.object({ q: z.string().optional() }) },
  responses: {
    200: {
      description: 'Every agent, admin flags included',
      content: {
        'application/json': { schema: z.object({ agents: z.array(AgentSummarySchema) }) },
      },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/admin/agents/{id}/admin',
  summary: 'Grant Or Revoke Admin (super admin only)',
  security: [{ [bearerAgentSession.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: z.object({ is_admin: z.boolean() }) } } },
  },
  responses: {
    200: {
      description: 'Flag updated',
      content: { 'application/json': { schema: AgentSummarySchema } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/admin/agents/{id}/super-admin',
  summary: 'Grant Or Revoke Super Admin (super admin only)',
  security: [{ [bearerAgentSession.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: { 'application/json': { schema: z.object({ is_super_admin: z.boolean() }) } },
    },
  },
  responses: {
    200: {
      description: 'Flag updated',
      content: { 'application/json': { schema: AgentSummarySchema } },
    },
  },
});
```

(Place these `registry.registerPath` calls after the file's existing ones, and the schema/component definitions above them alongside the file's existing schema definitions — follow the file's existing top-to-bottom ordering: schemas, then components, then paths.)

- [ ] **Step 3: Verify and commit**

Run: `pnpm dev` (or `pnpm --filter @support/api dev`), then open `http://localhost:4000/docs` and confirm every `/admin/*` path listed above renders with no console error; also `curl -s http://localhost:4000/docs/json | jq '.paths | keys' | grep admin` shows all ten paths.

```bash
git add backend/src/app.ts backend/src/docs/openapi.ts
git commit -m "Mount /admin router and register its OpenAPI paths"
```

---

### Task 18: Cross-workspace isolation test

**Files:**

- Modify: `backend/tests/admin.isolation.test.ts`

**Interfaces:**

- Consumes: `adminRouter` (Task 12), `listWorkspaces` (Task 12).

- [ ] **Step 1: Add the cross-workspace and role-boundary assertions**

Append to `backend/tests/admin.isolation.test.ts` (reusing the file's existing `app`/`beforeEach`/`afterAll`, but mounting the real `adminRouter` this time — add a second Express app instance in this file rather than modifying the Task 11 probe app):

```ts
import { adminRouter } from '../src/admin/router.ts';

const fullApp = express();
fullApp.use(express.json());
fullApp.use('/admin', adminRouter);
fullApp.use(errorMiddleware);

describe('admin cross-workspace isolation', () => {
  it('a single admin request reads across every workspace, unlike a normal RLS-scoped request', async () => {
    const workspaceA = await seedWorkspace({ name: 'Isolated A' });
    const workspaceB = await seedWorkspace({ name: 'Isolated B' });
    const adminId = await seedAgent(undefined, { isAdmin: true });
    // Session names workspace A; the admin endpoint must still see workspace B.
    const token = await signAgentSession({ agent_id: adminId, workspace_id: workspaceA });

    const res = await request(fullApp)
      .get('/admin/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const names = res.body.workspaces.map((w: any) => w.name);
    expect(names).toContain('Isolated A');
    expect(names).toContain('Isolated B');
  });

  it('a non-admin session is refused by the real admin router at 403, not merely the probe', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId });

    await request(fullApp)
      .get('/admin/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
```

- [ ] **Step 2: Run and commit**

Run: `pnpm --filter @support/api test admin.isolation.test.ts`
Expected: PASS.

```bash
git add backend/tests/admin.isolation.test.ts
git commit -m "Add cross-workspace isolation test for the admin router"
```

---

### Task 19: Full suite green

**Files:** none (verification only).

- [ ] **Step 1: Run the entire backend suite**

Run: `pnpm --filter @support/api test`
Expected: every test file passes, including every file touched in Tasks 1–18 and every pre-existing file that referenced `workspace_role = 'admin'` or `workspace.secret_hash`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @support/api typecheck`
Expected: no errors.

- [ ] **Step 3: Full monorepo check**

Run: `pnpm typecheck && pnpm test`
Expected: both pass (confirms nothing in `frontend/` or `packages/types/` broke — none should have, since this plan never touched either, but this is the cheap final confirmation before calling the backend plan done).

No commit for this task — it's verification of everything already committed in Tasks 1–18.
