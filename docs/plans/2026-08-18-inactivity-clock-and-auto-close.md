# Inactivity Clock & Auto-Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `resolution_cycle` table and the two background jobs that close the last two
status-transition gaps: `open`/`awaiting_player` → `resolved` via a two-stage inactivity clock, and
`resolved` → `closed` via a per-workspace auto-close window.

**Architecture:** One mutable projection row per resolution attempt (`resolution_cycle`) carries an
indexable `inactivity_due_at`. `postMessage` — already the single choke point every message goes
through — bumps that column, so every existing reply path feeds the clock for free. Two BullMQ
repeatable jobs scan the column: `inactivityClock` (stage 1 asks "Did this solve it?", stage 2 times
out to `resolved`) and `autoClose` (`resolved` → `closed` after `workspace.auto_close_days`).

**Tech Stack:** TypeScript, Express 5, Drizzle ORM + drizzle-kit, PostgreSQL 17 with RLS, BullMQ,
Vitest, React + TanStack Query (frontend, two small consumer changes).

**Source spec:** `docs/specs/2026-08-18-inactivity-clock-and-auto-close-design.md`

---

## Global Constraints

- **Never bypass RLS in a job.** Every job loops `withoutWorkspace` (to list workspaces) then
  `withWorkspace(ws.id, tx => …)` per tenant, exactly like `closeStaleSessions` and
  `sweepAbandonedForms`. No `BYPASSRLS`.
- **No hard deletes anywhere.** Every FK is `ON DELETE RESTRICT`.
- **All state changes write `conversation` and `event` in one transaction.** Never an ad-hoc update.
- **Event payload values are snapshotted, never live pointers.**
- **Never `console.*`** — use `logger` from `backend/src/shared/logging/logger.ts`
  (`logger.info|warn|error(tag, message, meta?)`).
- **Socket emits happen only after the transaction commits**, never inside it.
- **Inactivity window: 24 hours**, both stages. One exported constant, no env var, no schema column.
- **Auto-close window: `workspace.auto_close_days`, default 7.**
- **Migrations:** edit `backend/src/shared/db/schema/**`, then `pnpm db:generate`, then commit the
  generated SQL. Never hand-write a migration from scratch; hand-_edit_ the generated one only where
  this plan says so.
- **Commit message trailers:** do **not** add a `Co-Authored-By: Claude` trailer.
- Run all backend commands from `backend/` unless stated otherwise. Postgres and Redis must be up
  (`docker compose up -d`) for the API suite.

---

## Execution Order & Parallelism

```
Task 1  (foundation: schema, enums, types, migration, test helpers)
   │
Task 2  (resolution-cycle domain helper + tryIo)
   │
Task 3  (postMessage clock touch)          ← the shared mechanism Wave A relies on
   │
   ├─────────────── WAVE A — run all six in parallel, disjoint files ───────────────┐
   │  Task 4  ticket-path cycle open/close     surface/services/*                   │
   │  Task 5  escalate/unescalate pause+resume agent/services/escalationService.ts  │
   │  Task 6  resolve-path cycle close + the   domain/bot/applyBotTurn.ts,          │
   │          new inactivity_ask branch        domain/conversations/resolutionAnswer│
   │  Task 7  inactivityClock job              shared/jobs/inactivityClock.ts (new) │
   │  Task 8  autoClose job                    shared/jobs/autoClose.ts (new)       │
   │  Task 9  frontend banner + labels         frontend/src/surfaces/**             │
   └────────────────────────────────────────────────────────────────────────────────┘
   │
   ├──────────── WAVE B — run both in parallel ────────────┐
   │  Task 10  job registration   shared/jobs/queue.ts     │
   │  Task 11  cross-path integration test + docs          │
   └───────────────────────────────────────────────────────┘
```

**No two tasks in the same wave touch the same file.** Wave A tasks each branch from the Task 3 tip.
Task 10 needs Tasks 7 and 8 merged; Task 11 needs all of Wave A merged.

## File Structure

**Created**

| File                                                   | Responsibility                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `backend/src/domain/conversations/resolutionCycle.ts`  | Every read/write of a `resolution_cycle` row. The only module that knows the 24h window.   |
| `backend/src/shared/realtime/tryIo.ts`                 | `getIo()` that returns `null` instead of throwing, for job contexts with no socket server. |
| `backend/src/shared/jobs/inactivityClock.ts`           | `runInactivityClock` — stage 1 (ask) and stage 2 (timeout).                                |
| `backend/src/shared/jobs/autoClose.ts`                 | `runAutoClose` — `resolved` → `closed` past the window.                                    |
| `backend/tests/domain.resolutionCycle.test.ts`         | Unit coverage for the helper.                                                              |
| `backend/tests/jobs.inactivityClock.test.ts`           | Both stages, skips, multi-workspace isolation.                                             |
| `backend/tests/jobs.autoClose.test.ts`                 | Window, per-workspace setting, superseded cycles.                                          |
| `backend/tests/resolution.inactivityLifecycle.test.ts` | End-to-end open → ask → timeout → auto-close → reopen.                                     |

**Modified**

| File                                                                         | Change                                                                                 |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `backend/src/shared/db/schema/conversations.ts`                              | `resolutionCycle` table.                                                               |
| `backend/src/shared/db/schema/identity.ts`                                   | `workspace.auto_close_days`.                                                           |
| `backend/src/shared/db/schema/enums.ts`                                      | `confirm_phase += inactivity_ask`; `resolution_source += player_confirmed, timed_out`. |
| `packages/types/src/chat.ts`                                                 | `ConfirmPhaseValue` union.                                                             |
| `packages/types/src/agent-context.ts`                                        | `ResolutionSourceValue` union.                                                         |
| `backend/src/domain/conversations/index.ts`                                  | Re-export the new helper.                                                              |
| `backend/src/domain/conversations/postMessage.ts`                            | Clock touch + optional `now`.                                                          |
| `backend/src/surface/services/messagesService.ts`                            | Open cycle on create/reopen; widen reopen-owner rule.                                  |
| `backend/src/surface/services/newTicketService.ts`                           | Stamp `closed_at`; open cycle for the replacement.                                     |
| `backend/src/agent/services/escalationService.ts`                            | Pause/resume the clock.                                                                |
| `backend/src/domain/bot/applyBotTurn.ts`                                     | Close cycle on bot resolve.                                                            |
| `backend/src/domain/conversations/resolutionAnswer.ts`                       | Close cycle on agent resolve; new `inactivity_ask` branch.                             |
| `backend/src/shared/jobs/queue.ts`                                           | Register both schedulers.                                                              |
| `backend/tests/helpers/db.ts`                                                | `resolution_cycle` in `SCOPED_TABLES`; new/extended seeders.                           |
| `frontend/src/surfaces/webview/pages/SupportChat.tsx`                        | Banner renders for `inactivity_ask`.                                                   |
| `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx` | `waiting` + `resolverLabel`.                                                           |
| `backend/src/docs/openapi.ts`                                                | Description text for the two affected routes.                                          |
| `docs/status-transitions.md`                                                 | Move two rows out of "Not implemented".                                                |

## Two deviations from the spec, and why

Both are stated up front so no task implementer has to re-derive them.

1. **`ConfirmPhaseValue` and the webview banner are in scope, not out of it.** The spec lists only
   `resolverLabel()` as deferred frontend work. But `SupportChat.tsx:214-215` computes
   `confirmPending = phase === 'bot_article' || phase === 'agent_ask'` — an explicit allowlist,
   deliberately not `!== 'none'`. Without adding `inactivity_ask` to it the player is never shown a
   Yes/No banner, so stage 1 asks a question nothing can answer and every conversation reaches
   stage 2. That is the feature not working, not a label. Task 9 covers it (three lines).
2. **Stage 2's "support owed" check ignores `system` and `internal` messages.** The spec says "check
   the conversation's last message `author_type` — if it is not `'agent'`". Taken literally the flag
   is always `true`, because stage 1's own `RESOLUTION_CHECK_MESSAGE` is a `system` message and is
   always the last one. Task 7 implements the intent: the last **public, non-system** message being
   the player's means support owed the reply.

A third consequence the spec does not mention, handled in Task 4: `sendPlayerMessage`'s reopen branch
keeps the previous owner only when `resolutionSource === 'agent'`. `player_confirmed` and `timed_out`
both arise on conversations a human already owns (status was `open`/`awaiting_player`), so they must
keep the owner too — otherwise shipping this plan silently starts dumping owned conversations back
into Unassigned on reopen.

---

### Task 1: Foundation — schema, enums, shared types, migration, test seeders

Everything else depends on this task. Nothing may run in parallel with it.

**Files:**

- Modify: `backend/src/shared/db/schema/enums.ts:35-36`
- Modify: `backend/src/shared/db/schema/identity.ts:11-28`
- Modify: `backend/src/shared/db/schema/conversations.ts` (append after `message`)
- Modify: `packages/types/src/chat.ts:115`
- Modify: `packages/types/src/agent-context.ts:6`
- Modify: `backend/tests/helpers/db.ts:17-36, 46-56, 110-130`
- Create: `backend/drizzle/00NN_<generated>.sql` (via `pnpm db:generate`)
- Test: `backend/tests/schema.test.ts` (extend)

**Interfaces:**

- Consumes: nothing.
- Produces: the Drizzle table `resolutionCycle` (exported from
  `backend/src/shared/db/schema/index.ts` via the existing `export * from './conversations.ts'`),
  the column `workspace.autoCloseDays`, the enum values `'inactivity_ask'`, `'player_confirmed'`,
  `'timed_out'`, and these test seeders:
  `seedWorkspace({ autoCloseDays?: number })`,
  `seedConversation({ status?, confirmPhase?, assignedAgentId?, resolutionSource? })`,
  `seedResolutionCycle({ workspaceId, conversationId, cycleNo?, openedAt?, inactivityDueAt?, resolvedAt?, resolutionKind?, closedAt?, supportOwedFlag? }): Promise<string>`.

- [ ] **Step 1: Write the failing schema test**

Append to `backend/tests/schema.test.ts` (keep the file's existing imports; add `ownerPool` if it is
not already imported from `./helpers/db.ts`):

```ts
describe('resolution_cycle', () => {
  it('has the columns, partial indexes and composite FK the design requires', async () => {
    const { rows: cols } = await ownerPool.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_name = 'resolution_cycle' order by column_name`,
    );
    const names = cols.map((c) => c.column_name);
    expect(names).toEqual([
      'closed_at',
      'conversation_id',
      'cycle_no',
      'first_human_reply_at',
      'id',
      'inactivity_due_at',
      'opened_at',
      'resolution_kind',
      'resolved_at',
      'support_owed_flag',
      'workspace_id',
    ]);
    expect(cols.find((c) => c.column_name === 'support_owed_flag')!.is_nullable).toBe('NO');

    const { rows: idx } = await ownerPool.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where tablename = 'resolution_cycle'`,
    );
    const open = idx.find((i) => i.indexname === 'resolution_cycle_open_uk')!;
    expect(open.indexdef).toContain('UNIQUE');
    expect(open.indexdef).toContain('resolved_at IS NULL');
    expect(idx.find((i) => i.indexname === 'resolution_cycle_due_idx')!.indexdef).toContain(
      'resolved_at IS NULL',
    );
    expect(idx.find((i) => i.indexname === 'resolution_cycle_autoclose_idx')!.indexdef).toContain(
      'closed_at IS NULL',
    );

    const { rows: fks } = await ownerPool.query<{ conname: string }>(
      `select conname from pg_constraint
        where conrelid = 'resolution_cycle'::regclass and contype = 'f'`,
    );
    expect(fks.map((f) => f.conname)).toContain('resolution_cycle_conversation_fk');
  });

  it('is covered by the generic tenant RLS policy', async () => {
    const { rows } = await ownerPool.query<{ policyname: string }>(
      `select policyname from pg_policies where tablename = 'resolution_cycle'`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('extends the two enums', async () => {
    const { rows } = await ownerPool.query<{ typname: string; labels: string[] }>(
      `select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
         from pg_type t join pg_enum e on e.enumtypid = t.oid
        where t.typname in ('confirm_phase', 'resolution_source')
        group by t.typname`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.typname, r.labels]));
    expect(byName.confirm_phase).toEqual([
      'none',
      'bot_article',
      'agent_ask',
      'form',
      'inactivity_ask',
    ]);
    expect(byName.resolution_source).toEqual(['bot', 'agent', 'player_confirmed', 'timed_out']);
  });

  it('gives workspace an auto_close_days default of 7', async () => {
    const { rows } = await ownerPool.query<{ column_default: string; is_nullable: string }>(
      `select column_default, is_nullable from information_schema.columns
        where table_name = 'workspace' and column_name = 'auto_close_days'`,
    );
    expect(rows[0]!.is_nullable).toBe('NO');
    expect(rows[0]!.column_default).toContain('7');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && pnpm vitest run tests/schema.test.ts`
Expected: FAIL — `relation "resolution_cycle" does not exist` / empty column list.

- [ ] **Step 3: Extend the two enums**

In `backend/src/shared/db/schema/enums.ts`, replace lines 30-36 with:

```ts
// `bot_article` is set by the bot's answer_from_article, `agent_ask` by
// POST /agent/conversations/:id/ask-resolved, `inactivity_ask` by the inactivity
// clock's stage 1 — all three mean a yes/no question is on the player's screen.
// The clock gets its own value rather than reusing `agent_ask` so the answer can
// be attributed to the right resolution kind: a Yes on `agent_ask` is
// 'agent', a Yes on `inactivity_ask` is 'player_confirmed'. `form` means the
// pinned form card is up instead: not a yes/no, and the reason the webview must
// branch on the value rather than test it against 'none'.
// See docs/specs/2026-08-17-player-side-forms-design.md §2.4 and
// docs/specs/2026-08-18-inactivity-clock-and-auto-close-design.md §2.
export const confirmPhase = pgEnum('confirm_phase', [
  'none',
  'bot_article',
  'agent_ask',
  'form',
  'inactivity_ask',
]);
/**
 * Also the type of `resolution_cycle.resolution_kind`, deliberately one
 * vocabulary rather than two enums that could drift. `player_confirmed` (the
 * player answered Yes to the clock's ask) and `timed_out` (nobody answered)
 * are separate values because metrics must report them separately.
 */
export const resolutionSource = pgEnum('resolution_source', [
  'bot',
  'agent',
  'player_confirmed',
  'timed_out',
]);
```

- [ ] **Step 4: Add `workspace.auto_close_days`**

In `backend/src/shared/db/schema/identity.ts`, insert after the `ticketSeq` column (line 24):

```ts
  /**
   * How many days a `resolved` conversation waits before runAutoClose flips it
   * to `closed`. Per-workspace because support cadences differ per game; a
   * column rather than an env var so one noisy tenant can be tuned alone.
   */
  autoCloseDays: integer('auto_close_days').notNull().default(7),
```

- [ ] **Step 5: Add the `resolution_cycle` table**

In `backend/src/shared/db/schema/conversations.ts`, change line 1 to import `boolean` and add the
`sql` import, then append the table after `message`:

```ts
// line 1 — add `boolean` to the existing import list:
import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
// new import directly below it:
import { sql } from 'drizzle-orm';
```

```ts
/**
 * One row per resolution attempt. Cycle 1 opens with the conversation; every
 * reopen opens the next, so `reopen_count = cycle_no - 1` and no counter column
 * exists.
 *
 * A mutable projection, not an append-only log: `inactivity_due_at` ticks
 * forward on every public message for the life of the cycle. That is why there
 * is no REVOKE UPDATE on it, unlike `event`/`change_log`/`form_answer`.
 *
 * `first_human_reply_at` ships unpopulated on purpose — it belongs to the
 * metrics slice ("time to first reply"), not to either clock.
 */
export const resolutionCycle = pgTable(
  'resolution_cycle',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').notNull(),
    /** 1-based. */
    cycleNo: integer('cycle_no').notNull(),
    openedAt: timestamp('opened_at', tz).notNull().defaultNow(),
    /** Column ships now, population is the metrics slice. */
    firstHumanReplyAt: timestamp('first_human_reply_at', tz),
    /** NULL means the clock is not running: bot_active, escalated, or resolved. */
    inactivityDueAt: timestamp('inactivity_due_at', tz),
    resolvedAt: timestamp('resolved_at', tz),
    resolutionKind: resolutionSource('resolution_kind'),
    closedAt: timestamp('closed_at', tz),
    /** Set by the clock's stage 2 when the last public word was the player's. */
    supportOwedFlag: boolean('support_owed_flag').notNull().default(false),
  },
  (t) => [
    // Same composite-FK pattern as subintent/form_submission: a cycle can never
    // name another workspace's conversation.
    foreignKey({
      name: 'resolution_cycle_conversation_fk',
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversation.workspaceId, conversation.id],
    }).onDelete('restrict'),
    // "At most one open cycle per conversation", enforced by the database rather
    // than by every writer remembering to check.
    uniqueIndex('resolution_cycle_open_uk')
      .on(t.conversationId)
      .where(sql`resolved_at is null`),
    // The inactivity worker's stage 1 + stage 2 scan.
    index('resolution_cycle_due_idx')
      .on(t.workspaceId, t.inactivityDueAt)
      .where(sql`resolved_at is null`),
    // The auto-close worker's scan.
    index('resolution_cycle_autoclose_idx')
      .on(t.workspaceId, t.resolvedAt)
      .where(sql`closed_at is null and resolved_at is not null`),
  ],
);
```

- [ ] **Step 6: Widen the two shared type unions**

`packages/types/src/chat.ts:115`:

```ts
export type ConfirmPhaseValue = 'none' | 'bot_article' | 'agent_ask' | 'form' | 'inactivity_ask';
```

`packages/types/src/agent-context.ts:6`:

```ts
export type ResolutionSourceValue = 'bot' | 'agent' | 'player_confirmed' | 'timed_out';
```

- [ ] **Step 7: Generate and inspect the migration**

Run: `cd backend && pnpm db:generate`
Then open the generated `backend/drizzle/00NN_*.sql` and confirm it contains, in this order:

```sql
ALTER TYPE "public"."confirm_phase" ADD VALUE 'inactivity_ask';
ALTER TYPE "public"."resolution_source" ADD VALUE 'player_confirmed';
ALTER TYPE "public"."resolution_source" ADD VALUE 'timed_out';
CREATE TABLE "resolution_cycle" ( … );
ALTER TABLE "workspace" ADD COLUMN "auto_close_days" integer DEFAULT 7 NOT NULL;
ALTER TABLE "resolution_cycle" ADD CONSTRAINT "resolution_cycle_conversation_fk" …;
CREATE UNIQUE INDEX "resolution_cycle_open_uk" ON "resolution_cycle" ("conversation_id") WHERE resolved_at is null;
CREATE INDEX "resolution_cycle_due_idx" ON "resolution_cycle" ("workspace_id","inactivity_due_at") WHERE resolved_at is null;
CREATE INDEX "resolution_cycle_autoclose_idx" ON "resolution_cycle" ("workspace_id","resolved_at") WHERE closed_at is null and resolved_at is not null;
```

If any of the three `WHERE` predicates is missing from the generated SQL, hand-edit that
`CREATE INDEX` line in the generated file to add it verbatim as shown. Do not change anything else.

- [ ] **Step 8: Apply it**

Run: `cd backend && pnpm db:setup`
Expected: migrations apply, then the `002_rls.sql` generic loop grants a tenant policy to
`resolution_cycle` automatically because it has a `workspace_id` column.

- [ ] **Step 9: Add the test seeders**

In `backend/tests/helpers/db.ts`, add `'resolution_cycle'` as the **first** entry of `SCOPED_TABLES`
(it is a child of `conversation`; `truncate … cascade` needs it listed, and listing it first keeps
the array in dependency order):

```ts
const SCOPED_TABLES = [
  'resolution_cycle',
  'form_answer',
  // … rest unchanged
];
```

Extend `seedWorkspace`'s overrides and insert:

```ts
export async function seedWorkspace(
  overrides: {
    id?: string;
    slug?: string;
    name?: string;
    secretHash?: string;
    disabledAt?: Date | null;
    autoCloseDays?: number;
  } = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const slug = overrides.slug ?? `ws-${id.slice(0, 8)}`;
  await ownerPool.query(
    `insert into workspace (id, name, slug, secret_hash, disabled_at, auto_close_days)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      overrides.name ?? slug,
      slug,
      overrides.secretHash ?? 'unset',
      overrides.disabledAt ?? null,
      overrides.autoCloseDays ?? 7,
    ],
  );
  return id;
}
```

Extend `seedConversation` (every existing call site keeps working — all four new fields are
optional and default to today's behaviour):

```ts
export async function seedConversation(args: {
  workspaceId: string;
  playerId: string;
  sessionId?: string | null;
  createdAt?: Date;
  status?: 'new' | 'bot_active' | 'open' | 'awaiting_player' | 'escalated' | 'resolved' | 'closed';
  confirmPhase?: 'none' | 'bot_article' | 'agent_ask' | 'form' | 'inactivity_ask';
  assignedAgentId?: string | null;
  resolutionSource?: 'bot' | 'agent' | 'player_confirmed' | 'timed_out' | null;
}): Promise<string> {
  const id = randomUUID();
  const { rows } = await ownerPool.query<{ ticket_seq: number }>(
    `update workspace set ticket_seq = ticket_seq + 1 where id = $1 returning ticket_seq`,
    [args.workspaceId],
  );
  const number = rows[0]!.ticket_seq;
  await ownerPool.query(
    `insert into conversation
       (id, workspace_id, player_id, session_id, number, created_at, status, confirm_phase, assigned_agent_id, resolution_source)
     values ($1, $2, $3, $4, $5, coalesce($6, now()), coalesce($7, 'bot_active'), coalesce($8, 'none'), $9, $10)`,
    [
      id,
      args.workspaceId,
      args.playerId,
      args.sessionId ?? null,
      number,
      args.createdAt ?? null,
      args.status ?? null,
      args.confirmPhase ?? null,
      args.assignedAgentId ?? null,
      args.resolutionSource ?? null,
    ],
  );
  return id;
}
```

And add the new seeder at the end of the file:

```ts
export async function seedResolutionCycle(args: {
  workspaceId: string;
  conversationId: string;
  cycleNo?: number;
  openedAt?: Date;
  inactivityDueAt?: Date | null;
  resolvedAt?: Date | null;
  resolutionKind?: 'bot' | 'agent' | 'player_confirmed' | 'timed_out' | null;
  closedAt?: Date | null;
  supportOwedFlag?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into resolution_cycle
       (id, workspace_id, conversation_id, cycle_no, opened_at, inactivity_due_at,
        resolved_at, resolution_kind, closed_at, support_owed_flag)
     values ($1, $2, $3, $4, coalesce($5, now()), $6, $7, $8, $9, $10)`,
    [
      id,
      args.workspaceId,
      args.conversationId,
      args.cycleNo ?? 1,
      args.openedAt ?? null,
      args.inactivityDueAt ?? null,
      args.resolvedAt ?? null,
      args.resolutionKind ?? null,
      args.closedAt ?? null,
      args.supportOwedFlag ?? false,
    ],
  );
  return id;
}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `cd backend && pnpm vitest run tests/schema.test.ts`
Expected: PASS.

Run: `cd .. && pnpm typecheck`
Expected: PASS — note this may report errors in `ThreadPanel.tsx` only if it exhaustively switches on
`ResolutionSourceValue`; it does not (it uses `if` chains with a fallback), so a clean pass is
expected. Any other new error means a consumer of the widened unions was missed — fix it here.

Run: `cd backend && pnpm vitest run` (full backend suite — this is the regression gate for a schema
change)
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add backend/src/shared/db/schema backend/drizzle packages/types/src backend/tests
git commit -m "feat(db): add resolution_cycle, auto_close_days and the two new enum values"
```

---

### Task 2: The `resolutionCycle` domain helper

**Depends on:** Task 1. **Blocks:** everything after it.

**Files:**

- Create: `backend/src/domain/conversations/resolutionCycle.ts`
- Create: `backend/src/shared/realtime/tryIo.ts`
- Modify: `backend/src/domain/conversations/index.ts`
- Test: `backend/tests/domain.resolutionCycle.test.ts`

**Interfaces:**

- Consumes: `resolutionCycle` table and the widened enums from Task 1; `Tx` from
  `backend/src/shared/db/withWorkspace.ts`.
- Produces — re-exported from `backend/src/domain/conversations/index.ts`, so every later task
  imports from `'../../domain/conversations/index.ts'`:

  ```ts
  export const INACTIVITY_WINDOW_HOURS = 24;
  export type ResolutionKind = 'bot' | 'agent' | 'player_confirmed' | 'timed_out';
  export function nextInactivityDueAt(from: Date): Date;
  export function openResolutionCycle(
    tx: Tx,
    args: { workspaceId: string; conversationId: string },
  ): Promise<{ id: string; cycleNo: number }>;
  export function touchInactivityClock(
    tx: Tx,
    args: { conversationId: string; now: Date },
  ): Promise<void>;
  export function pauseInactivityClock(tx: Tx, args: { conversationId: string }): Promise<void>;
  export function resumeInactivityClock(
    tx: Tx,
    args: { conversationId: string; now: Date },
  ): Promise<void>;
  export function closeResolutionCycle(
    tx: Tx,
    args: { conversationId: string; kind: ResolutionKind; now: Date },
  ): Promise<void>;
  export function stampCycleClosed(
    tx: Tx,
    args: { conversationId: string; now: Date },
  ): Promise<void>;
  ```

  And from `backend/src/shared/realtime/tryIo.ts`:

  ```ts
  export function tryIo(tag: string, meta?: Record<string, unknown>): Server | null;
  ```

- [ ] **Step 1: Write the failing test**

Create `backend/tests/domain.resolutionCycle.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { resolutionCycle } from '../src/shared/db/schema/index.ts';
import {
  INACTIVITY_WINDOW_HOURS,
  closeResolutionCycle,
  nextInactivityDueAt,
  openResolutionCycle,
  pauseInactivityClock,
  resumeInactivityClock,
  stampCycleClosed,
  touchInactivityClock,
} from '../src/domain/conversations/index.ts';
import {
  closeOwnerPool,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

const NOW = new Date('2026-08-18T12:00:00Z');
const plus24h = new Date(NOW.getTime() + 24 * 3_600_000);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function fixture() {
  const workspaceId = await seedWorkspace({ slug: 'demo-game' });
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({ workspaceId, playerId });
  return { workspaceId, playerId, conversationId };
}

const cycles = (workspaceId: string, conversationId: string) =>
  withWorkspace(workspaceId, async (tx) =>
    tx
      .select()
      .from(resolutionCycle)
      .where(eq(resolutionCycle.conversationId, conversationId))
      .orderBy(desc(resolutionCycle.cycleNo)),
  );

describe('resolutionCycle helper', () => {
  it('exposes a 24 hour window', () => {
    expect(INACTIVITY_WINDOW_HOURS).toBe(24);
    expect(nextInactivityDueAt(NOW).toISOString()).toBe(plus24h.toISOString());
  });

  it('opens cycle 1 with a null clock, then cycle 2 on the next open', async () => {
    const { workspaceId, conversationId } = await fixture();

    const first = await withWorkspace(workspaceId, (tx) =>
      openResolutionCycle(tx, { workspaceId, conversationId }),
    );
    expect(first.cycleNo).toBe(1);

    await withWorkspace(workspaceId, (tx) =>
      closeResolutionCycle(tx, { conversationId, kind: 'bot', now: NOW }),
    );
    const second = await withWorkspace(workspaceId, (tx) =>
      openResolutionCycle(tx, { workspaceId, conversationId }),
    );
    expect(second.cycleNo).toBe(2);

    const rows = await cycles(workspaceId, conversationId);
    expect(rows.map((r) => r.cycleNo)).toEqual([2, 1]);
    expect(rows[0]!.inactivityDueAt).toBeNull();
    expect(rows[1]!.resolutionKind).toBe('bot');
  });

  it('refuses a second open cycle on the same conversation', async () => {
    const { workspaceId, conversationId } = await fixture();
    await withWorkspace(workspaceId, (tx) =>
      openResolutionCycle(tx, { workspaceId, conversationId }),
    );
    await expect(
      withWorkspace(workspaceId, (tx) => openResolutionCycle(tx, { workspaceId, conversationId })),
    ).rejects.toThrow();
  });

  it('touch sets the due date 24h out, pause nulls it, resume sets it again', async () => {
    const { workspaceId, conversationId } = await fixture();
    await withWorkspace(workspaceId, (tx) =>
      openResolutionCycle(tx, { workspaceId, conversationId }),
    );

    await withWorkspace(workspaceId, (tx) =>
      touchInactivityClock(tx, { conversationId, now: NOW }),
    );
    expect((await cycles(workspaceId, conversationId))[0]!.inactivityDueAt!.toISOString()).toBe(
      plus24h.toISOString(),
    );

    await withWorkspace(workspaceId, (tx) => pauseInactivityClock(tx, { conversationId }));
    expect((await cycles(workspaceId, conversationId))[0]!.inactivityDueAt).toBeNull();

    await withWorkspace(workspaceId, (tx) =>
      resumeInactivityClock(tx, { conversationId, now: NOW }),
    );
    expect((await cycles(workspaceId, conversationId))[0]!.inactivityDueAt!.toISOString()).toBe(
      plus24h.toISOString(),
    );
  });

  it('close stamps resolved_at and kind and stops the clock', async () => {
    const { workspaceId, conversationId } = await fixture();
    await withWorkspace(workspaceId, (tx) =>
      openResolutionCycle(tx, { workspaceId, conversationId }),
    );
    await withWorkspace(workspaceId, (tx) =>
      touchInactivityClock(tx, { conversationId, now: NOW }),
    );

    await withWorkspace(workspaceId, (tx) =>
      closeResolutionCycle(tx, { conversationId, kind: 'timed_out', now: NOW }),
    );

    const [row] = await cycles(workspaceId, conversationId);
    expect(row!.resolvedAt!.toISOString()).toBe(NOW.toISOString());
    expect(row!.resolutionKind).toBe('timed_out');
    expect(row!.inactivityDueAt).toBeNull();
  });

  it('never touches or closes an already-resolved cycle', async () => {
    const { workspaceId, conversationId } = await fixture();
    await withWorkspace(workspaceId, (tx) =>
      openResolutionCycle(tx, { workspaceId, conversationId }),
    );
    await withWorkspace(workspaceId, (tx) =>
      closeResolutionCycle(tx, { conversationId, kind: 'bot', now: NOW }),
    );

    const later = new Date(NOW.getTime() + 3_600_000);
    await withWorkspace(workspaceId, (tx) =>
      touchInactivityClock(tx, { conversationId, now: later }),
    );
    await withWorkspace(workspaceId, (tx) =>
      closeResolutionCycle(tx, { conversationId, kind: 'agent', now: later }),
    );

    const [row] = await cycles(workspaceId, conversationId);
    expect(row!.inactivityDueAt).toBeNull();
    expect(row!.resolutionKind).toBe('bot');
    expect(row!.resolvedAt!.toISOString()).toBe(NOW.toISOString());
  });

  it('stampCycleClosed marks the newest cycle closed and is write-once', async () => {
    const { workspaceId, conversationId } = await fixture();
    await withWorkspace(workspaceId, (tx) =>
      openResolutionCycle(tx, { workspaceId, conversationId }),
    );

    await withWorkspace(workspaceId, (tx) => stampCycleClosed(tx, { conversationId, now: NOW }));
    const later = new Date(NOW.getTime() + 3_600_000);
    await withWorkspace(workspaceId, (tx) => stampCycleClosed(tx, { conversationId, now: later }));

    const [row] = await cycles(workspaceId, conversationId);
    expect(row!.closedAt!.toISOString()).toBe(NOW.toISOString());
  });

  it('does nothing when the conversation has no open cycle', async () => {
    const { workspaceId, conversationId } = await fixture();
    await withWorkspace(workspaceId, (tx) =>
      touchInactivityClock(tx, { conversationId, now: NOW }),
    );
    await withWorkspace(workspaceId, (tx) =>
      closeResolutionCycle(tx, { conversationId, kind: 'bot', now: NOW }),
    );
    await withWorkspace(workspaceId, (tx) => stampCycleClosed(tx, { conversationId, now: NOW }));
    expect(await cycles(workspaceId, conversationId)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && pnpm vitest run tests/domain.resolutionCycle.test.ts`
Expected: FAIL — `Failed to resolve import` / `openResolutionCycle is not a function`.

- [ ] **Step 3: Write the helper**

Create `backend/src/domain/conversations/resolutionCycle.ts`:

```ts
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { resolutionCycle } from '../../shared/db/schema/index.ts';
import type { Tx } from '../../shared/db/withWorkspace.ts';

/**
 * Both stages of the clock use the same window: 24h of silence before the ask,
 * 24h more before the timeout. A constant in one file — a per-workspace setting
 * would be a schema change and nobody has asked for one.
 */
export const INACTIVITY_WINDOW_HOURS = 24;

/** The four terminal outcomes a cycle can record. Mirrors the resolution_source enum. */
export type ResolutionKind = 'bot' | 'agent' | 'player_confirmed' | 'timed_out';

export function nextInactivityDueAt(from: Date): Date {
  return new Date(from.getTime() + INACTIVITY_WINDOW_HOURS * 3_600_000);
}

/**
 * Opens the next cycle. `inactivity_due_at` is always NULL here even on a reopen,
 * where the conversation goes straight to `open`: the player's own message is
 * posted immediately after, and postMessage's touch starts the clock. One writer
 * of that column beats two.
 *
 * Throws on a second open cycle — `resolution_cycle_open_uk` is the guard, and a
 * caller that double-opens is a bug that must not be swallowed.
 */
export async function openResolutionCycle(
  tx: Tx,
  args: { workspaceId: string; conversationId: string },
): Promise<{ id: string; cycleNo: number }> {
  const [prev] = await tx
    .select({ maxNo: sql<number | null>`max(${resolutionCycle.cycleNo})` })
    .from(resolutionCycle)
    .where(eq(resolutionCycle.conversationId, args.conversationId));

  const cycleNo = Number(prev?.maxNo ?? 0) + 1;
  const [created] = await tx
    .insert(resolutionCycle)
    .values({ workspaceId: args.workspaceId, conversationId: args.conversationId, cycleNo })
    .returning({ id: resolutionCycle.id, cycleNo: resolutionCycle.cycleNo });

  if (!created) throw new Error('openResolutionCycle: insert returned nothing');
  return created;
}

/**
 * Pushes the due date one window out on whichever cycle is currently open. The
 * `resolved_at IS NULL` filter is what makes every one of these a no-op on a
 * conversation with nothing running — no caller has to check first.
 */
export async function touchInactivityClock(
  tx: Tx,
  args: { conversationId: string; now: Date },
): Promise<void> {
  await tx
    .update(resolutionCycle)
    .set({ inactivityDueAt: nextInactivityDueAt(args.now) })
    .where(
      and(
        eq(resolutionCycle.conversationId, args.conversationId),
        isNull(resolutionCycle.resolvedAt),
      ),
    );
}

/** On escalated: NULL so the worker skips it entirely rather than filtering on status alone. */
export async function pauseInactivityClock(
  tx: Tx,
  args: { conversationId: string },
): Promise<void> {
  await tx
    .update(resolutionCycle)
    .set({ inactivityDueAt: null })
    .where(
      and(
        eq(resolutionCycle.conversationId, args.conversationId),
        isNull(resolutionCycle.resolvedAt),
      ),
    );
}

/** On unescalated: a fresh full window, not the remainder of the one that was paused. */
export async function resumeInactivityClock(
  tx: Tx,
  args: { conversationId: string; now: Date },
): Promise<void> {
  await touchInactivityClock(tx, args);
}

export async function closeResolutionCycle(
  tx: Tx,
  args: { conversationId: string; kind: ResolutionKind; now: Date },
): Promise<void> {
  await tx
    .update(resolutionCycle)
    .set({ resolvedAt: args.now, resolutionKind: args.kind, inactivityDueAt: null })
    .where(
      and(
        eq(resolutionCycle.conversationId, args.conversationId),
        isNull(resolutionCycle.resolvedAt),
      ),
    );
}

/**
 * Stamps `closed_at` on the newest cycle — the auto-close semantic, reached
 * either by runAutoClose or by openNewTicket force-closing the old conversation.
 * Write-once: a cycle already stamped keeps its original timestamp, because the
 * first close is the one that happened.
 */
export async function stampCycleClosed(
  tx: Tx,
  args: { conversationId: string; now: Date },
): Promise<void> {
  const [latest] = await tx
    .select({ id: resolutionCycle.id })
    .from(resolutionCycle)
    .where(eq(resolutionCycle.conversationId, args.conversationId))
    .orderBy(desc(resolutionCycle.cycleNo))
    .limit(1);

  if (!latest) return;

  await tx
    .update(resolutionCycle)
    .set({ closedAt: args.now })
    .where(and(eq(resolutionCycle.id, latest.id), isNull(resolutionCycle.closedAt)));
}
```

- [ ] **Step 4: Write `tryIo`**

Create `backend/src/shared/realtime/tryIo.ts`:

```ts
import type { Server } from 'socket.io';
import { getIo } from './socketServer.ts';
import { logger } from '../logging/logger.ts';

/**
 * `getIo()` throws when no socket server exists — correct for a request path,
 * wrong for a background job, which must still commit its work in a worker
 * process (or a test) that never started one. Same shape as
 * domain/forms/emitFormTerminated.ts, lifted out so both jobs share it.
 */
export function tryIo(tag: string, meta?: Record<string, unknown>): Server | null {
  try {
    return getIo();
  } catch (err) {
    logger.warn(tag, 'skipping realtime emit: socket server not initialised', {
      ...meta,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
```

- [ ] **Step 5: Re-export the helper**

In `backend/src/domain/conversations/index.ts`, add after the `postMessage` line:

```ts
export * from './resolutionCycle.ts';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && pnpm vitest run tests/domain.resolutionCycle.test.ts`
Expected: PASS (8 tests).

Run: `cd .. && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/domain/conversations backend/src/shared/realtime/tryIo.ts backend/tests/domain.resolutionCycle.test.ts
git commit -m "feat(conversations): add the resolution-cycle helper and tryIo"
```

---

### Task 3: `postMessage` touches the clock

**Depends on:** Task 2. **Blocks:** Wave A.

This is the whole reason the design chose a column over a computed check: one hook here covers agent
replies, player replies, the bot's handoff line, the clock's own ask and the decline message, and no
other call site ever has to know a clock exists.

**Files:**

- Modify: `backend/src/domain/conversations/postMessage.ts:7-35, 62-115`
- Test: `backend/tests/domain.postMessage.test.ts` (extend)

**Interfaces:**

- Consumes: `touchInactivityClock`, `nextInactivityDueAt` from Task 2.
- Produces: `PostMessageInput` gains `now?: Date` — the timestamp the clock touch is computed from,
  defaulting to `new Date()`. Every later caller that owns a deterministic clock (both jobs) passes it.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/domain.postMessage.test.ts` (reuse the file's existing imports; add
`resolutionCycle`, `seedResolutionCycle` and `nextInactivityDueAt` as needed):

```ts
describe('postMessage inactivity clock touch', () => {
  const NOW = new Date('2026-08-18T12:00:00Z');

  async function fixture(status: 'open' | 'awaiting_player' | 'bot_active' | 'escalated') {
    const workspaceId = await seedWorkspace({ slug: `ws-${status}` });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status });
    await seedResolutionCycle({ workspaceId, conversationId });
    return { workspaceId, playerId, conversationId };
  }

  const due = (workspaceId: string, conversationId: string) =>
    withWorkspace(workspaceId, async (tx) => {
      const [row] = await tx
        .select({ dueAt: resolutionCycle.inactivityDueAt })
        .from(resolutionCycle)
        .where(eq(resolutionCycle.conversationId, conversationId));
      return row!.dueAt;
    });

  it('pushes the due date one window out on a public message in open', async () => {
    const { workspaceId, playerId, conversationId } = await fixture('open');
    await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'player',
        actorId: playerId,
        body: 'still broken',
        now: NOW,
      }),
    );
    expect((await due(workspaceId, conversationId))!.toISOString()).toBe(
      nextInactivityDueAt(NOW).toISOString(),
    );
  });

  it('touches on awaiting_player too', async () => {
    const { workspaceId, conversationId } = await fixture('awaiting_player');
    await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'system',
        actorId: null,
        body: 'Did this solve it?',
        now: NOW,
      }),
    );
    expect((await due(workspaceId, conversationId))!.toISOString()).toBe(
      nextInactivityDueAt(NOW).toISOString(),
    );
  });

  it('does not touch while the bot owns the conversation', async () => {
    const { workspaceId, playerId, conversationId } = await fixture('bot_active');
    await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'player',
        actorId: playerId,
        body: 'hi',
        now: NOW,
      }),
    );
    expect(await due(workspaceId, conversationId)).toBeNull();
  });

  it('does not touch while escalated', async () => {
    const { workspaceId, conversationId } = await fixture('escalated');
    await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'system',
        actorId: null,
        body: 'note',
        now: NOW,
      }),
    );
    expect(await due(workspaceId, conversationId)).toBeNull();
  });

  it('does not touch on an internal note', async () => {
    const { workspaceId, conversationId } = await fixture('open');
    await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'agent',
        actorId: null,
        body: 'internal only',
        visibility: 'internal',
        now: NOW,
      }),
    );
    expect(await due(workspaceId, conversationId)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && pnpm vitest run tests/domain.postMessage.test.ts`
Expected: FAIL — the first two cases return `null`; `now` is not a known property of
`PostMessageInput`.

- [ ] **Step 3: Add the touch**

In `backend/src/domain/conversations/postMessage.ts`, add the import:

```ts
import { touchInactivityClock } from './resolutionCycle.ts';
```

Add to `PostMessageInput`, after `articleId`:

```ts
  /**
   * The timestamp the inactivity-clock touch below is computed from. Defaults to
   * wall-clock now. Only the background jobs pass it, and only so their tests can
   * assert an exact due date instead of a range.
   */
  now?: Date
```

Change the seq bump to also return the status (no extra query — the row is already being updated):

```ts
const [bumped] = await tx
  .update(conversation)
  .set({ messageSeq: sql`${conversation.messageSeq} + 1` })
  .where(eq(conversation.id, input.conversationId))
  .returning({ seq: conversation.messageSeq, status: conversation.status });
```

And append, immediately before `return inserted`:

```ts
// The one place the inactivity clock is wound. Every message path — agent
// reply, player reply, the bot's handoff line, the clock's own ask, the
// decline — already funnels through here, so no other call site needs to know
// a clock exists.
//
// Public only: an internal note is a conversation between agents, and letting
// it reset the player's clock would hide a ticket nobody had actually replied
// to. Status-gated because the clock does not run under the bot (`bot_active`)
// or while escalated, and never after `resolved`/`closed`.
const visibility = input.visibility ?? 'public';
if (visibility === 'public' && (bumped.status === 'open' || bumped.status === 'awaiting_player')) {
  await touchInactivityClock(tx, {
    conversationId: input.conversationId,
    now: input.now ?? new Date(),
  });
}

return inserted;
```

Reuse that `visibility` local in the insert and the event payload rather than repeating
`input.visibility ?? 'public'` three times.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && pnpm vitest run tests/domain.postMessage.test.ts`
Expected: PASS.

Run: `cd backend && pnpm vitest run` (full suite — `postMessage` is on every path)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/conversations/postMessage.ts backend/tests/domain.postMessage.test.ts
git commit -m "feat(conversations): wind the inactivity clock from postMessage"
```

---

## WAVE A — Tasks 4 through 9 run in parallel

Each branches from the Task 3 tip. No two touch the same file.

---

### Task 4: Cycle open on the ticket paths, and the reopen-owner rule

**Depends on:** Task 3. **Parallel with:** 5, 6, 7, 8, 9.

**Files:**

- Modify: `backend/src/surface/services/messagesService.ts:92-98, 126-163`
- Modify: `backend/src/surface/services/newTicketService.ts:70-88`
- Test: `backend/tests/surface.resolutionCycleLifecycle.test.ts` (create)

**Interfaces:**

- Consumes: `openResolutionCycle`, `stampCycleClosed` from Task 2 (import from
  `'../../domain/conversations/index.ts'`, which `messagesService.ts` already imports from).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/surface.resolutionCycleLifecycle.test.ts`. Mirror the request-level setup used
by `backend/tests/sdk.unread.test.ts` / `backend/tests/agent.messages.test.ts` — read one of them
first for how a player token is minted and how `request(app)` is built, and reuse that helper
verbatim rather than inventing a second one.

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { conversation, resolutionCycle } from '../src/shared/db/schema/index.ts';
import { sendPlayerMessage } from '../src/surface/services/messagesService.ts';
import { openNewTicket } from '../src/surface/services/newTicketService.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

const cyclesFor = (workspaceId: string, conversationId: string) =>
  withWorkspace(workspaceId, async (tx) =>
    tx
      .select()
      .from(resolutionCycle)
      .where(eq(resolutionCycle.conversationId, conversationId))
      .orderBy(desc(resolutionCycle.cycleNo)),
  );

describe('resolution cycles on the surface ticket paths', () => {
  it('opens cycle 1 when a player starts their first conversation', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId);

    const { conversation_id } = await sendPlayerMessage({ workspaceId, playerId } as never, {
      body: 'my gems vanished',
    });

    const rows = await cyclesFor(workspaceId, conversation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cycleNo).toBe(1);
    // bot_active: the clock does not run under the bot.
    expect(rows[0]!.inactivityDueAt).toBeNull();
    expect(rows[0]!.resolvedAt).toBeNull();
  });

  it('opens cycle 2 on reopen, with the clock already running', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId);
    const { conversation_id } = await sendPlayerMessage({ workspaceId, playerId } as never, {
      body: 'first',
    });

    await withWorkspace(workspaceId, async (tx) => {
      await tx
        .update(conversation)
        .set({ status: 'resolved', resolutionSource: 'bot' })
        .where(eq(conversation.id, conversation_id));
      await tx
        .update(resolutionCycle)
        .set({ resolvedAt: new Date(), resolutionKind: 'bot' })
        .where(eq(resolutionCycle.conversationId, conversation_id));
    });

    await sendPlayerMessage({ workspaceId, playerId } as never, { body: 'it came back' });

    const rows = await cyclesFor(workspaceId, conversation_id);
    expect(rows.map((r) => r.cycleNo)).toEqual([2, 1]);
    // The player's own message ran through postMessage while status was `open`.
    expect(rows[0]!.inactivityDueAt).not.toBeNull();
  });

  it('keeps the previous owner when the last resolution was player_confirmed or timed_out', async () => {
    for (const source of ['player_confirmed', 'timed_out'] as const) {
      await truncateAll();
      const workspaceId = await seedWorkspace({ slug: `ws-${source}` });
      const agentId = await seedAgent();
      await seedWorkspaceMember({ workspaceId, agentId });
      const playerId = await seedPlayer(workspaceId);
      const { conversation_id } = await sendPlayerMessage({ workspaceId, playerId } as never, {
        body: 'first',
      });

      await withWorkspace(workspaceId, async (tx) => {
        await tx
          .update(conversation)
          .set({ status: 'resolved', resolutionSource: source, assignedAgentId: agentId })
          .where(eq(conversation.id, conversation_id));
        await tx
          .update(resolutionCycle)
          .set({ resolvedAt: new Date(), resolutionKind: source })
          .where(eq(resolutionCycle.conversationId, conversation_id));
      });

      await sendPlayerMessage({ workspaceId, playerId } as never, { body: 'again' });

      const [row] = await withWorkspace(workspaceId, (tx) =>
        tx.select().from(conversation).where(eq(conversation.id, conversation_id)),
      );
      expect(row!.assignedAgentId, source).toBe(agentId);
    }
  });

  it('stamps closed_at on the old cycle and opens cycle 1 on the replacement ticket', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId);
    const { conversation_id: oldId } = await sendPlayerMessage({ workspaceId, playerId } as never, {
      body: 'first',
    });
    await withWorkspace(workspaceId, (tx) =>
      tx.update(conversation).set({ status: 'resolved' }).where(eq(conversation.id, oldId)),
    );

    const result = await openNewTicket({ workspaceId, playerId } as never, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect((await cyclesFor(workspaceId, oldId))[0]!.closedAt).not.toBeNull();
    const fresh = await cyclesFor(workspaceId, result.conversationId);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.cycleNo).toBe(1);
  });
});
```

> The `{ workspaceId, playerId } as never` cast stands in for a full `PlayerContext`. If the file you
> copied the setup from builds a real context object, use that instead and drop the cast.

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && pnpm vitest run tests/surface.resolutionCycleLifecycle.test.ts`
Expected: FAIL — every cycle assertion sees an empty array.

- [ ] **Step 3: Open the cycle on creation and on reopen**

In `backend/src/surface/services/messagesService.ts`, extend the existing import from
`'../../domain/conversations/index.ts'` (line 13) with `openResolutionCycle`.

In the new-conversation branch, immediately after the `conversation_assigned_bot` event
(currently ends line 123), add:

```ts
// Cycle 1 opens with the conversation, per spec §1. `inactivity_due_at`
// stays NULL: the bot owns this conversation and the clock does not run
// under the bot.
await openResolutionCycle(tx, { workspaceId: ctx.workspaceId, conversationId });
```

In the reopen branch, immediately after the `conversation_reopened` event
(currently ends line 162, before `inboxStatus = 'open'`), add:

```ts
// The next cycle. Deliberately opened before the player's message is
// posted below: postMessage's touch needs an open cycle to find, and
// that touch is what starts this cycle's clock — a reopen lands in
// `open`, where the clock does run.
await openResolutionCycle(tx, { workspaceId: ctx.workspaceId, conversationId });
```

- [ ] **Step 4: Widen the reopen-owner rule**

Still in `messagesService.ts`, add below `REOPENABLE_STATUSES` (line 32):

```ts
/**
 * Resolutions that happened while a human owned the conversation. All three
 * reach `resolved` from `open`/`awaiting_player`, so the agent who was handling
 * it stays the owner on reopen; only a bot resolve goes back through
 * assignOnHandoff. Widened from a bare `=== 'agent'` when the inactivity clock
 * added its two kinds — without this, shipping the clock quietly started
 * dumping owned conversations into Unassigned.
 */
const AGENT_OWNED_RESOLUTIONS = new Set(['agent', 'player_confirmed', 'timed_out']);
```

and change line 134 from

```ts
        if (prior?.resolutionSource === 'agent' && prior.assignedAgentId) {
```

to

```ts
        if (prior?.resolutionSource && AGENT_OWNED_RESOLUTIONS.has(prior.resolutionSource) && prior.assignedAgentId) {
```

- [ ] **Step 5: Wire the new-ticket path**

In `backend/src/surface/services/newTicketService.ts`, extend the import on line 5:

```ts
import {
  allocateTicketNumber,
  openResolutionCycle,
  stampCycleClosed,
} from '../../domain/conversations/index.ts';
```

After the `conversation_closed` event (currently ends line 81), add:

```ts
// The force-close is a close in the auto-close sense, so it stamps the same
// column runAutoClose would have. `resolved_at` is deliberately left as-is:
// this conversation may never have been resolved, and inventing a resolution
// to satisfy a column would put a fiction in the reporting spine. The cycle
// stays open-but-closed, which no worker will ever pick up — both scan on
// conversation status, and this conversation is `closed` forever (a
// replacement is inserted below, so it can never be the player's latest again).
await stampCycleClosed(tx, { conversationId: latest.id, now: new Date() });
```

After the `conversation_assigned_bot` event for the new conversation (currently ends line 108), add:

```ts
await openResolutionCycle(tx, { workspaceId: ctx.workspaceId, conversationId: created.id });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && pnpm vitest run tests/surface.resolutionCycleLifecycle.test.ts`
Expected: PASS.

Run: `cd backend && pnpm vitest run tests/bot.reopen.test.ts tests/sdk.unread.test.ts tests/resolution.crossPath.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/surface/services backend/tests/surface.resolutionCycleLifecycle.test.ts
git commit -m "feat(surface): open a resolution cycle on create, reopen and new-ticket"
```

---

### Task 5: Escalate pauses the clock, unescalate resumes it

**Depends on:** Task 3. **Parallel with:** 4, 6, 7, 8, 9.

**Files:**

- Modify: `backend/src/agent/services/escalationService.ts:34-68`
- Test: `backend/tests/agent.escalate.test.ts` (extend)

**Interfaces:**

- Consumes: `pauseInactivityClock`, `resumeInactivityClock` from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/agent.escalate.test.ts`, reusing that file's existing fixture helpers for
seeding an authenticated agent and an `open` conversation (read the top of the file first — do not
introduce a second setup style):

```ts
describe('escalation and the inactivity clock', () => {
  it('nulls inactivity_due_at on escalate and sets a fresh window on unescalate', async () => {
    const { workspaceId, agentId, conversationId } = await openConversationFixture();
    const dueAt = new Date('2026-08-18T12:00:00Z');
    await seedResolutionCycle({ workspaceId, conversationId, inactivityDueAt: dueAt });

    const ctx = { workspaceId, agentId } as never;

    expect(await escalateConversation(ctx, conversationId)).toEqual({ ok: true });
    const paused = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(resolutionCycle).where(eq(resolutionCycle.conversationId, conversationId)),
    );
    expect(paused[0]!.inactivityDueAt).toBeNull();

    expect(await unescalateConversation(ctx, conversationId)).toEqual({ ok: true });
    const resumed = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(resolutionCycle).where(eq(resolutionCycle.conversationId, conversationId)),
    );
    expect(resumed[0]!.inactivityDueAt).not.toBeNull();
    // A fresh full window, not the remainder of the paused one.
    expect(resumed[0]!.inactivityDueAt!.getTime()).toBeGreaterThan(dueAt.getTime());
  });

  it('leaves a resolved cycle untouched when the toggle is rejected', async () => {
    const { workspaceId, agentId, conversationId } = await openConversationFixture();
    await seedResolutionCycle({
      workspaceId,
      conversationId,
      inactivityDueAt: null,
      resolvedAt: new Date('2026-08-17T00:00:00Z'),
      resolutionKind: 'agent',
    });

    // Wrong status for unescalate — the guard rejects before any clock write.
    expect(await unescalateConversation({ workspaceId, agentId } as never, conversationId)).toEqual(
      {
        ok: false,
        reason: 'wrong_status',
      },
    );
    const rows = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(resolutionCycle).where(eq(resolutionCycle.conversationId, conversationId)),
    );
    expect(rows[0]!.inactivityDueAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && pnpm vitest run tests/agent.escalate.test.ts`
Expected: FAIL — `inactivityDueAt` is still the seeded date after escalate.

- [ ] **Step 3: Wire the pause and resume**

In `backend/src/agent/services/escalationService.ts`, add the import:

```ts
import { pauseInactivityClock, resumeInactivityClock } from '../../domain/conversations/index.ts';
```

Widen the `toggle` options type and pass the clock action from each caller:

```ts
export async function escalateConversation(ctx: AgentContext, conversationId: string): Promise<EscalationOutcome> {
  return toggle(ctx, conversationId, {
    allowedFrom: ESCALATABLE_STATUSES,
    next: 'escalated',
    eventType: 'conversation_escalated',
    clock: 'pause',
  })
}

export async function unescalateConversation(ctx: AgentContext, conversationId: string): Promise<EscalationOutcome> {
  return toggle(ctx, conversationId, {
    allowedFrom: new Set(['escalated']),
    next: 'open',
    eventType: 'conversation_unescalated',
    clock: 'resume',
  })
}

async function toggle(
  ctx: AgentContext,
  conversationId: string,
  opts: {
    allowedFrom: Set<string>
    next: 'escalated' | 'open'
    eventType: 'conversation_escalated' | 'conversation_unescalated'
    clock: 'pause' | 'resume'
  },
): Promise<EscalationOutcome> {
```

Inside the transaction, after the `conversation` UPDATE and before `appendEvent`:

```ts
// No message carries an escalation, so the clock cannot ride on
// postMessage's touch here — these two calls are the only direct writers of
// inactivity_due_at outside that hook. Pausing (rather than filtering on
// status in the worker) is what the design requires: an escalated
// conversation must be invisible to the scan, not merely skipped by it.
// Resume grants a fresh full window rather than the remainder of the paused
// one — the escalation, however long it ran, is not silence from the player.
if (opts.clock === 'pause') {
  await pauseInactivityClock(tx, { conversationId });
} else {
  await resumeInactivityClock(tx, { conversationId, now: new Date() });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && pnpm vitest run tests/agent.escalate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/services/escalationService.ts backend/tests/agent.escalate.test.ts
git commit -m "feat(agent): pause and resume the inactivity clock on escalate"
```

---

### Task 6: Close the cycle on every resolve path, and add the `inactivity_ask` branch

**Depends on:** Task 3. **Parallel with:** 4, 5, 7, 8, 9.

**Files:**

- Modify: `backend/src/domain/bot/applyBotTurn.ts:74-89`
- Modify: `backend/src/domain/conversations/resolutionAnswer.ts:17-25, 73-126`
- Test: `backend/tests/domain.resolutionAnswer.test.ts` (extend)

**Interfaces:**

- Consumes: `closeResolutionCycle` from Task 2.
- Produces: `ResolutionAnswerOutcome`'s `resolved` variant widens its `source` field to
  `'bot' | 'agent' | 'player_confirmed'`. Task 11's integration test and any route that narrows on it
  must accept the new value; check `backend/src/surface/controllers/` for a switch on
  `outcome.source` before finishing this task and widen it if one exists.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/domain.resolutionAnswer.test.ts`, reusing its existing fixture style:

```ts
describe('applyResolutionAnswer — inactivity_ask', () => {
  it('resolves as player_confirmed on Yes and closes the cycle', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'awaiting_player',
      confirmPhase: 'inactivity_ask',
    });
    await seedResolutionCycle({ workspaceId, conversationId, inactivityDueAt: new Date() });

    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, true),
    );
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved') expect(outcome.source).toBe('player_confirmed');

    const [conv] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    );
    expect(conv!.status).toBe('resolved');
    expect(conv!.confirmPhase).toBe('none');
    expect(conv!.resolutionSource).toBe('player_confirmed');

    const [cycle] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(resolutionCycle).where(eq(resolutionCycle.conversationId, conversationId)),
    );
    expect(cycle!.resolutionKind).toBe('player_confirmed');
    expect(cycle!.resolvedAt).not.toBeNull();
    expect(cycle!.inactivityDueAt).toBeNull();

    const events = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.type, 'conversation_resolved')),
    );
    expect(events[0]!.payload).toMatchObject({ source: 'inactivity', confirmed_by: 'player' });
  });

  it('on No, clears the phase, posts the decline and restarts the clock', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'awaiting_player',
      confirmPhase: 'inactivity_ask',
    });
    const past = new Date('2026-08-01T00:00:00Z');
    await seedResolutionCycle({ workspaceId, conversationId, inactivityDueAt: past });

    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, false),
    );
    expect(outcome.kind).toBe('declined');

    const [conv] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    );
    expect(conv!.status).toBe('awaiting_player');
    expect(conv!.confirmPhase).toBe('none');

    const [cycle] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(resolutionCycle).where(eq(resolutionCycle.conversationId, conversationId)),
    );
    expect(cycle!.resolvedAt).toBeNull();
    // Spec step 3: "clock restarts". The decline message's own postMessage did it.
    expect(cycle!.inactivityDueAt!.getTime()).toBeGreaterThan(past.getTime());

    const events = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.type, 'resolution_check_declined')),
    );
    expect(events[0]!.payload).toMatchObject({ source: 'inactivity' });
  });

  it('closes the cycle on the agent_ask Yes path too', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      confirmPhase: 'agent_ask',
    });
    await seedResolutionCycle({ workspaceId, conversationId, inactivityDueAt: new Date() });

    await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, true),
    );

    const [cycle] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(resolutionCycle).where(eq(resolutionCycle.conversationId, conversationId)),
    );
    expect(cycle!.resolutionKind).toBe('agent');
    expect(cycle!.resolvedAt).not.toBeNull();
  });

  it('closes the cycle on the bot_article Yes path', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'bot_active',
      confirmPhase: 'bot_article',
    });
    await seedResolutionCycle({ workspaceId, conversationId });

    await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, true),
    );

    const [cycle] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(resolutionCycle).where(eq(resolutionCycle.conversationId, conversationId)),
    );
    expect(cycle!.resolutionKind).toBe('bot');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && pnpm vitest run tests/domain.resolutionAnswer.test.ts`
Expected: FAIL — the `inactivity_ask` cases fall into the `agent_ask` branch and record `'agent'`;
`resolutionKind` is `null` everywhere.

- [ ] **Step 3: Close the cycle on the bot resolve**

In `backend/src/domain/bot/applyBotTurn.ts`, add to the import from
`'../conversations/postMessage.ts'` a second import line:

```ts
import { closeResolutionCycle } from '../conversations/resolutionCycle.ts';
```

(Import the file directly, not `../conversations/index.ts` — that barrel re-exports
`resolutionAnswer.ts`, which imports `applyBotTurn`, and going through it would create a cycle.)

In the `resolve` case, between the `conversation` UPDATE and the `conversation_resolved` event:

```ts
await closeResolutionCycle(tx, {
  conversationId: ctx.conversationId,
  kind: 'bot',
  now: new Date(),
});
```

- [ ] **Step 4: Rework `resolutionAnswer.ts`**

Add the import:

```ts
import { closeResolutionCycle } from './resolutionCycle.ts';
```

Widen the outcome type (line 23):

```ts
  | { kind: 'resolved'; source: 'bot' | 'agent' | 'player_confirmed'; posted: PostedMessageRow | null }
```

Replace everything from the `// agent_ask.` comment (line 73) to the end of the function with:

```ts
// agent_ask and inactivity_ask share this code: the two differ only in who
// asked, and the player's client cannot tell them apart — the banner is the
// same, the route is the same, and `helped` means the same thing. What differs
// is attribution, so the kind and the event's `source` are derived from the
// phase rather than duplicated into a second branch.
const askedBy = found.confirmPhase === 'inactivity_ask' ? 'inactivity' : 'agent';
const resolutionKind = askedBy === 'inactivity' ? 'player_confirmed' : 'agent';

if (helped) {
  // Posted before the status flip so the transcript reads in the order it
  // happened: the player answers, then the conversation resolves.
  const confirmed = await postMessage(tx, {
    workspaceId: ctx.workspaceId,
    conversationId: ctx.conversationId,
    authorType: 'player',
    actorId: ctx.playerId,
    sessionId: ctx.sessionId,
    body: RESOLUTION_CONFIRM_MESSAGE,
  });
  await tx
    .update(conversation)
    // resolution_source is what reopen reads to keep the previous owner
    // (spec 4 §10) — the event payload is the audit trail, not the signal.
    .set({ status: 'resolved', confirmPhase: 'none', resolutionSource: resolutionKind })
    .where(eq(conversation.id, ctx.conversationId));
  await closeResolutionCycle(tx, {
    conversationId: ctx.conversationId,
    kind: resolutionKind,
    now: new Date(),
  });
  await appendEvent(tx, {
    workspaceId: ctx.workspaceId,
    type: 'conversation_resolved',
    conversationId: ctx.conversationId,
    sessionId: ctx.sessionId,
    actorId: ctx.playerId,
    actorType: 'player',
    payload: { source: askedBy, confirmed_by: 'player' },
  });
  return { kind: 'resolved', source: resolutionKind, posted: confirmed };
}

// A decline touches no status: on agent_ask a human already owns this
// conversation, and on inactivity_ask the clock simply starts over — which is
// spec step 3 exactly. The restart needs no code here: the decline message
// below runs through postMessage, whose touch pushes inactivity_due_at a fresh
// window out. The post is not cosmetic either — without it the phase flipped
// back and the agent's transcript read as if the question had gone unanswered.
const declined = await postMessage(tx, {
  workspaceId: ctx.workspaceId,
  conversationId: ctx.conversationId,
  authorType: 'player',
  actorId: ctx.playerId,
  sessionId: ctx.sessionId,
  body: RESOLUTION_DECLINE_MESSAGE,
});
await tx
  .update(conversation)
  .set({ confirmPhase: 'none' })
  .where(eq(conversation.id, ctx.conversationId));
await appendEvent(tx, {
  workspaceId: ctx.workspaceId,
  type: 'resolution_check_declined',
  conversationId: ctx.conversationId,
  sessionId: ctx.sessionId,
  actorId: ctx.playerId,
  actorType: 'player',
  payload: { source: askedBy },
});
return { kind: 'declined', posted: declined };
```

Also update the function's doc comment (lines 27-39) — replace "The only place a player's Yes/No is
applied, for both sources" with "for all three sources (bot_article, agent_ask, inactivity_ask)".

> **Ordering note:** the decline's `postMessage` runs while `confirm_phase` is still
> `inactivity_ask` and the status is still `open`/`awaiting_player`, which is exactly what the touch
> needs. Do not reorder the phase reset above the post.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && pnpm vitest run tests/domain.resolutionAnswer.test.ts tests/resolution.crossPath.test.ts tests/bot.phase.test.ts`
Expected: PASS.

Run: `cd .. && pnpm typecheck`
Expected: PASS. If a controller narrows on `outcome.source`, widen it now.

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain backend/tests/domain.resolutionAnswer.test.ts
git commit -m "feat(conversations): close the cycle on resolve and handle the inactivity_ask answer"
```

---

### Task 7: The `inactivityClock` job

**Depends on:** Task 3. **Parallel with:** 4, 5, 6, 8, 9.

**Files:**

- Create: `backend/src/shared/jobs/inactivityClock.ts`
- Test: `backend/tests/jobs.inactivityClock.test.ts`

**Interfaces:**

- Consumes: `postMessage` (with `now`), `RESOLUTION_CHECK_MESSAGE`, `closeResolutionCycle` from
  `'../../domain/conversations/index.ts'`; `tryIo` from Task 2; `withWorkspace`/`withoutWorkspace`.
- Produces:

  ```ts
  export const INACTIVITY_CLOCK_JOB = 'inactivity-clock';
  export type RunInactivityClockOptions = { now?: Date };
  export type InactivityClockResult = { asked: number; timedOut: number };
  export function runInactivityClock(
    options?: RunInactivityClockOptions,
  ): Promise<InactivityClockResult>;
  ```

  Task 10 imports `INACTIVITY_CLOCK_JOB` and `runInactivityClock`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/jobs.inactivityClock.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { conversation, event, message, resolutionCycle } from '../src/shared/db/schema/index.ts';
import { runInactivityClock } from '../src/shared/jobs/inactivityClock.ts';
import {
  RESOLUTION_CHECK_MESSAGE,
  nextInactivityDueAt,
} from '../src/domain/conversations/index.ts';
import {
  closeOwnerPool,
  seedConversation,
  seedMessage,
  seedPlayer,
  seedResolutionCycle,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

const NOW = new Date('2026-08-18T12:00:00Z');
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

type FixtureArgs = {
  status?: 'open' | 'awaiting_player' | 'escalated' | 'bot_active' | 'resolved';
  confirmPhase?: 'none' | 'inactivity_ask' | 'agent_ask';
  dueAt?: Date | null;
  resolvedAt?: Date | null;
  slug?: string;
};

async function fixture(args: FixtureArgs = {}) {
  const workspaceId = await seedWorkspace({ slug: args.slug ?? 'demo-game' });
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({
    workspaceId,
    playerId,
    status: args.status ?? 'open',
    confirmPhase: args.confirmPhase ?? 'none',
  });
  const cycleId = await seedResolutionCycle({
    workspaceId,
    conversationId,
    inactivityDueAt: args.dueAt === undefined ? hoursAgo(1) : args.dueAt,
    resolvedAt: args.resolvedAt ?? null,
  });
  return { workspaceId, playerId, conversationId, cycleId };
}

const readConversation = (workspaceId: string, conversationId: string) =>
  withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx.select().from(conversation).where(eq(conversation.id, conversationId));
    return row!;
  });

const readCycle = (workspaceId: string, conversationId: string) =>
  withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .select()
      .from(resolutionCycle)
      .where(eq(resolutionCycle.conversationId, conversationId));
    return row!;
  });

describe('runInactivityClock — stage 1 (ask)', () => {
  it('posts the check, sets inactivity_ask and pushes the clock a window out', async () => {
    const { workspaceId, conversationId } = await fixture();

    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 1, timedOut: 0 });

    const messages = await withWorkspace(workspaceId, (tx) =>
      tx
        .select()
        .from(message)
        .where(eq(message.conversationId, conversationId))
        .orderBy(asc(message.seq)),
    );
    expect(messages.at(-1)!.body).toBe(RESOLUTION_CHECK_MESSAGE);
    expect(messages.at(-1)!.authorType).toBe('system');
    expect(messages.at(-1)!.visibility).toBe('public');

    expect((await readConversation(workspaceId, conversationId)).confirmPhase).toBe(
      'inactivity_ask',
    );
    expect((await readCycle(workspaceId, conversationId)).inactivityDueAt!.toISOString()).toBe(
      nextInactivityDueAt(NOW).toISOString(),
    );
  });

  it('appends resolution_check_requested with a system actor and source inactivity', async () => {
    const { workspaceId } = await fixture();
    await runInactivityClock({ now: NOW });

    const events = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.type, 'resolution_check_requested')),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.actorType).toBe('system');
    expect(events[0]!.actorId).toBeNull();
    expect(events[0]!.payload).toMatchObject({ source: 'inactivity' });
  });

  it('does not ask before the due date', async () => {
    await fixture({ dueAt: new Date(NOW.getTime() + 3_600_000) });
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });
  });

  it.each(['escalated', 'bot_active', 'resolved'] as const)('skips %s', async (status) => {
    // escalated also has a NULL clock in production; the status filter is the
    // second guard and is asserted here with the clock deliberately left running.
    await fixture({ status });
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });
  });

  it('skips a conversation that already has a question on screen', async () => {
    await fixture({ confirmPhase: 'agent_ask' });
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });
  });

  it('skips a cycle that is already resolved', async () => {
    await fixture({ status: 'open', resolvedAt: hoursAgo(48) });
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });
  });

  it('never asks twice in one tick', async () => {
    const { workspaceId, conversationId } = await fixture();
    await runInactivityClock({ now: NOW });
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });
    const messages = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(message).where(eq(message.conversationId, conversationId)),
    );
    expect(messages.filter((m) => m.body === RESOLUTION_CHECK_MESSAGE)).toHaveLength(1);
  });
});

describe('runInactivityClock — stage 2 (timeout)', () => {
  it('resolves as timed_out and closes the cycle', async () => {
    const { workspaceId, conversationId } = await fixture({ confirmPhase: 'inactivity_ask' });

    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 1 });

    const conv = await readConversation(workspaceId, conversationId);
    expect(conv.status).toBe('resolved');
    expect(conv.confirmPhase).toBe('none');
    expect(conv.resolutionSource).toBe('timed_out');

    const cycle = await readCycle(workspaceId, conversationId);
    expect(cycle.resolutionKind).toBe('timed_out');
    expect(cycle.resolvedAt!.toISOString()).toBe(NOW.toISOString());
    expect(cycle.inactivityDueAt).toBeNull();

    const events = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.type, 'conversation_resolved')),
    );
    expect(events[0]!.actorType).toBe('system');
    expect(events[0]!.payload).toMatchObject({ source: 'inactivity', confirmed_by: 'timeout' });
  });

  it('flags support_owed when the last public word was the player’s', async () => {
    const { workspaceId, conversationId } = await fixture({ confirmPhase: 'inactivity_ask' });
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player' });
    // Stage 1's own ask. It must not be what the flag is computed from.
    await seedMessage({ workspaceId, conversationId, seq: 2, authorType: 'system' });

    await runInactivityClock({ now: NOW });
    expect((await readCycle(workspaceId, conversationId)).supportOwedFlag).toBe(true);
  });

  it('does not flag support_owed when an agent had replied', async () => {
    const { workspaceId, conversationId } = await fixture({ confirmPhase: 'inactivity_ask' });
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player' });
    await seedMessage({ workspaceId, conversationId, seq: 2, authorType: 'agent' });
    await seedMessage({ workspaceId, conversationId, seq: 3, authorType: 'system' });

    await runInactivityClock({ now: NOW });
    expect((await readCycle(workspaceId, conversationId)).supportOwedFlag).toBe(false);
  });

  it('ignores an internal note when deciding support_owed', async () => {
    const { workspaceId, conversationId } = await fixture({ confirmPhase: 'inactivity_ask' });
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player' });
    await seedMessage({
      workspaceId,
      conversationId,
      seq: 2,
      authorType: 'agent',
      visibility: 'internal',
    });

    await runInactivityClock({ now: NOW });
    expect((await readCycle(workspaceId, conversationId)).supportOwedFlag).toBe(true);
  });

  it('does not time out before the second window elapses', async () => {
    await fixture({ confirmPhase: 'inactivity_ask', dueAt: new Date(NOW.getTime() + 3_600_000) });
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });
  });
});

describe('runInactivityClock — both stages in one tick', () => {
  it('never asks and times out the same conversation in one run', async () => {
    const { workspaceId, conversationId } = await fixture();
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 1, timedOut: 0 });
    expect((await readConversation(workspaceId, conversationId)).status).toBe('open');
  });

  it('sweeps every workspace, each in its own tenant scope', async () => {
    for (const slug of ['game-a', 'game-b', 'game-c']) await fixture({ slug });
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 3, timedOut: 0 });
  });

  it('skips a disabled workspace', async () => {
    const workspaceId = await seedWorkspace({
      slug: 'retired',
      disabledAt: new Date('2026-07-01T00:00:00Z'),
    });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    await seedResolutionCycle({ workspaceId, conversationId, inactivityDueAt: hoursAgo(1) });

    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && pnpm vitest run tests/jobs.inactivityClock.test.ts`
Expected: FAIL — `Failed to resolve import ".../inactivityClock.ts"`.

- [ ] **Step 3: Write the job**

Create `backend/src/shared/jobs/inactivityClock.ts`:

```ts
import { and, desc, eq, inArray, isNull, lte, ne } from 'drizzle-orm';
import { conversation, message, resolutionCycle, workspace } from '../db/schema/index.ts';
import { withWorkspace, withoutWorkspace, type Tx } from '../db/withWorkspace.ts';
import { appendEvent } from '../events/appendEvent.ts';
import {
  closeResolutionCycle,
  postMessage,
  RESOLUTION_CHECK_MESSAGE,
  toAgentView,
  toPlayerView,
} from '../../domain/conversations/index.ts';
import { emitInboxChanged, emitMessageToRooms, emitPhaseChanged } from '../realtime/emit.ts';
import { tryIo } from '../realtime/tryIo.ts';
import { logger } from '../logging/logger.ts';

export const INACTIVITY_CLOCK_JOB = 'inactivity-clock';

/** The clock only runs while support owns the conversation. */
const CLOCK_STATUSES = ['open', 'awaiting_player'] as const;

export type RunInactivityClockOptions = { now?: Date };
export type InactivityClockResult = { asked: number; timedOut: number };

/**
 * The two-stage inactivity clock. Stage 1 asks "Did this solve it?" after a
 * window of silence; stage 2 resolves as `timed_out` after a second window with
 * no answer.
 *
 * Both stages run every tick and cannot double-process one conversation, because
 * stage 1's own post runs through postMessage, whose touch pushes
 * inactivity_due_at a full window into the future — which is also what sets the
 * stage 2 deadline, so no code here writes that column directly.
 *
 * Sweeps every workspace by looping one tenant-scoped transaction per workspace
 * rather than by bypassing RLS, following closeStaleSessions. Like
 * sweepAbandonedForms it opens one transaction per conversation: this job posts
 * messages and flips statuses, and a single bad row must not roll back and
 * strand every other player in the workspace.
 */
export async function runInactivityClock(
  options: RunInactivityClockOptions = {},
): Promise<InactivityClockResult> {
  const now = options.now ?? new Date();

  const workspaces = await withoutWorkspace(async (tx) =>
    tx.select({ id: workspace.id }).from(workspace).where(isNull(workspace.disabledAt)),
  );

  let asked = 0;
  let timedOut = 0;
  for (const ws of workspaces) {
    asked += await runAskStage(ws.id, now);
    timedOut += await runTimeoutStage(ws.id, now);
  }
  return { asked, timedOut };
}

/** Candidate rows for a stage. The status join is what keeps escalated, bot_active and resolved out. */
async function candidates(
  workspaceId: string,
  now: Date,
  phase: 'none' | 'inactivity_ask',
): Promise<{ cycleId: string; conversationId: string }[]> {
  return withWorkspace(workspaceId, async (tx) =>
    tx
      .select({ cycleId: resolutionCycle.id, conversationId: resolutionCycle.conversationId })
      .from(resolutionCycle)
      .innerJoin(conversation, eq(conversation.id, resolutionCycle.conversationId))
      .where(
        and(
          isNull(resolutionCycle.resolvedAt),
          lte(resolutionCycle.inactivityDueAt, now),
          inArray(conversation.status, CLOCK_STATUSES),
          eq(conversation.confirmPhase, phase),
        ),
      ),
  );
}

/**
 * Re-reads and locks the conversation inside the write transaction. The
 * candidate list was gathered in an earlier, already-committed transaction, so a
 * player can have answered in between — this lock plus the re-check is what makes
 * that a no-op instead of a second question or a resolve over an answer.
 */
async function lockAndCheck(
  tx: Tx,
  conversationId: string,
  phase: 'none' | 'inactivity_ask',
): Promise<boolean> {
  const [locked] = await tx
    .select({ status: conversation.status, confirmPhase: conversation.confirmPhase })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1)
    .for('update');

  if (!locked) return false;
  if (locked.confirmPhase !== phase) return false;
  return (CLOCK_STATUSES as readonly string[]).includes(locked.status);
}

async function runAskStage(workspaceId: string, now: Date): Promise<number> {
  const rows = await candidates(workspaceId, now, 'none');

  let asked = 0;
  for (const row of rows) {
    try {
      const posted = await withWorkspace(workspaceId, async (tx) => {
        if (!(await lockAndCheck(tx, row.conversationId, 'none'))) return null;

        // `now` is threaded into postMessage so the stage 2 deadline this touch
        // writes is derived from the tick's clock, not from wall time.
        const sent = await postMessage(tx, {
          workspaceId,
          conversationId: row.conversationId,
          authorType: 'system',
          actorId: null,
          body: RESOLUTION_CHECK_MESSAGE,
          visibility: 'public',
          now,
        });

        await tx
          .update(conversation)
          .set({ confirmPhase: 'inactivity_ask' })
          .where(eq(conversation.id, row.conversationId));

        // Same event type the agent's manual ask writes, disambiguated by
        // payload `source` — the pattern conversation_assigned already uses for
        // `via`. Two event types for one fact would split every funnel that
        // counts "questions asked".
        await appendEvent(tx, {
          workspaceId,
          type: 'resolution_check_requested',
          conversationId: row.conversationId,
          actorId: null,
          actorType: 'system',
          payload: { source: 'inactivity' },
        });

        return sent;
      });

      if (!posted) continue;
      asked += 1;

      const io = tryIo('jobs', { workspaceId, conversationId: row.conversationId });
      if (io) {
        emitMessageToRooms(io, row.conversationId, toPlayerView(posted), toAgentView(posted));
        emitPhaseChanged(io, row.conversationId, {
          conversation_id: row.conversationId,
          confirm_phase: 'inactivity_ask',
        });
      }
    } catch (error) {
      logger.error('jobs', `inactivity-clock ask failed for conversation ${row.conversationId}`, {
        workspaceId,
        error: error instanceof Error ? `${error.name} ${error.message}` : String(error),
      });
    }
  }
  return asked;
}

async function runTimeoutStage(workspaceId: string, now: Date): Promise<number> {
  const rows = await candidates(workspaceId, now, 'inactivity_ask');

  let timedOut = 0;
  for (const row of rows) {
    try {
      const done = await withWorkspace(workspaceId, async (tx) => {
        if (!(await lockAndCheck(tx, row.conversationId, 'inactivity_ask'))) return false;

        // "Support owed the reply when the clock fired." System messages are
        // excluded because stage 1's own ask is one and is always last, which
        // would make the flag unconditionally true; internal notes are excluded
        // because a note between agents is not a reply to the player.
        const [last] = await tx
          .select({ authorType: message.authorType })
          .from(message)
          .where(
            and(
              eq(message.conversationId, row.conversationId),
              eq(message.visibility, 'public'),
              ne(message.authorType, 'system'),
            ),
          )
          .orderBy(desc(message.seq))
          .limit(1);
        const supportOwed = last?.authorType === 'player';

        await tx
          .update(conversation)
          .set({ status: 'resolved', confirmPhase: 'none', resolutionSource: 'timed_out' })
          .where(eq(conversation.id, row.conversationId));

        // By id, not by the open-cycle predicate: this runs before the close and
        // must land on the row the candidate scan actually selected.
        await tx
          .update(resolutionCycle)
          .set({ supportOwedFlag: supportOwed })
          .where(eq(resolutionCycle.id, row.cycleId));

        await closeResolutionCycle(tx, {
          conversationId: row.conversationId,
          kind: 'timed_out',
          now,
        });

        await appendEvent(tx, {
          workspaceId,
          type: 'conversation_resolved',
          conversationId: row.conversationId,
          actorId: null,
          actorType: 'system',
          payload: { source: 'inactivity', confirmed_by: 'timeout', support_owed: supportOwed },
        });

        return true;
      });

      if (!done) continue;
      timedOut += 1;

      const io = tryIo('jobs', { workspaceId, conversationId: row.conversationId });
      if (io) {
        emitPhaseChanged(io, row.conversationId, {
          conversation_id: row.conversationId,
          confirm_phase: 'none',
        });
        emitInboxChanged(io, workspaceId, row.conversationId, 'resolved');
      }
    } catch (error) {
      logger.error(
        'jobs',
        `inactivity-clock timeout failed for conversation ${row.conversationId}`,
        {
          workspaceId,
          error: error instanceof Error ? `${error.name} ${error.message}` : String(error),
        },
      );
    }
  }
  return timedOut;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && pnpm vitest run tests/jobs.inactivityClock.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/shared/jobs/inactivityClock.ts backend/tests/jobs.inactivityClock.test.ts
git commit -m "feat(jobs): add the two-stage inactivity clock"
```

---

### Task 8: The `autoClose` job

**Depends on:** Task 3. **Parallel with:** 4, 5, 6, 7, 9.

**Files:**

- Create: `backend/src/shared/jobs/autoClose.ts`
- Test: `backend/tests/jobs.autoClose.test.ts`

**Interfaces:**

- Consumes: `resolutionCycle`, `workspace.autoCloseDays` from Task 1; `tryIo` from Task 2.
- Produces:

  ```ts
  export const AUTO_CLOSE_JOB = 'auto-close';
  export type RunAutoCloseOptions = { now?: Date };
  export function runAutoClose(options?: RunAutoCloseOptions): Promise<number>;
  ```

  Task 10 imports both.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/jobs.autoClose.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { conversation, event, resolutionCycle } from '../src/shared/db/schema/index.ts';
import { runAutoClose } from '../src/shared/jobs/autoClose.ts';
import {
  closeOwnerPool,
  seedConversation,
  seedPlayer,
  seedResolutionCycle,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

const NOW = new Date('2026-08-18T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function resolvedFixture(args: {
  resolvedAt: Date;
  autoCloseDays?: number;
  status?: 'resolved' | 'open' | 'closed';
  slug?: string;
  closedAt?: Date | null;
}) {
  const workspaceId = await seedWorkspace({
    slug: args.slug ?? 'demo-game',
    autoCloseDays: args.autoCloseDays ?? 7,
  });
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({
    workspaceId,
    playerId,
    status: args.status ?? 'resolved',
    resolutionSource: 'agent',
  });
  const cycleId = await seedResolutionCycle({
    workspaceId,
    conversationId,
    resolvedAt: args.resolvedAt,
    resolutionKind: 'agent',
    closedAt: args.closedAt ?? null,
  });
  return { workspaceId, conversationId, cycleId };
}

const read = (workspaceId: string, conversationId: string) =>
  withWorkspace(workspaceId, async (tx) => {
    const [conv] = await tx.select().from(conversation).where(eq(conversation.id, conversationId));
    const [cycle] = await tx
      .select()
      .from(resolutionCycle)
      .where(eq(resolutionCycle.conversationId, conversationId));
    return { conv: conv!, cycle: cycle! };
  });

describe('runAutoClose', () => {
  it('closes a conversation resolved longer ago than the window', async () => {
    const { workspaceId, conversationId } = await resolvedFixture({ resolvedAt: daysAgo(8) });

    expect(await runAutoClose({ now: NOW })).toBe(1);

    const { conv, cycle } = await read(workspaceId, conversationId);
    expect(conv.status).toBe('closed');
    expect(cycle.closedAt!.toISOString()).toBe(NOW.toISOString());
  });

  it('appends conversation_closed with a system actor and the window it used', async () => {
    const { workspaceId } = await resolvedFixture({ resolvedAt: daysAgo(8) });
    await runAutoClose({ now: NOW });

    const events = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.type, 'conversation_closed')),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.actorType).toBe('system');
    expect(events[0]!.actorId).toBeNull();
    expect(events[0]!.payload).toMatchObject({ reason: 'auto_close', days: 7 });
  });

  it('leaves a conversation inside the window alone', async () => {
    const { workspaceId, conversationId } = await resolvedFixture({ resolvedAt: daysAgo(3) });
    expect(await runAutoClose({ now: NOW })).toBe(0);
    expect((await read(workspaceId, conversationId)).conv.status).toBe('resolved');
  });

  it('respects a non-default auto_close_days', async () => {
    const { workspaceId, conversationId } = await resolvedFixture({
      resolvedAt: daysAgo(3),
      autoCloseDays: 2,
    });
    expect(await runAutoClose({ now: NOW })).toBe(1);
    expect((await read(workspaceId, conversationId)).conv.status).toBe('closed');
  });

  it('skips a superseded cycle whose conversation was reopened', async () => {
    // The old cycle keeps resolved_at and a null closed_at forever — correct,
    // "this resolution never got auto-closed because it reopened first". The
    // status join is what stops it being closed under the live conversation.
    const { workspaceId, conversationId } = await resolvedFixture({
      resolvedAt: daysAgo(30),
      status: 'open',
    });
    expect(await runAutoClose({ now: NOW })).toBe(0);
    expect((await read(workspaceId, conversationId)).conv.status).toBe('open');
  });

  it('skips a cycle that is already closed', async () => {
    await resolvedFixture({ resolvedAt: daysAgo(30), closedAt: daysAgo(20), status: 'closed' });
    expect(await runAutoClose({ now: NOW })).toBe(0);
  });

  it('is idempotent across runs', async () => {
    const { workspaceId } = await resolvedFixture({ resolvedAt: daysAgo(8) });
    expect(await runAutoClose({ now: NOW })).toBe(1);
    expect(await runAutoClose({ now: NOW })).toBe(0);
    const events = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.type, 'conversation_closed')),
    );
    expect(events).toHaveLength(1);
  });

  it('sweeps every workspace with its own window', async () => {
    await resolvedFixture({ resolvedAt: daysAgo(8), slug: 'game-a', autoCloseDays: 7 });
    await resolvedFixture({ resolvedAt: daysAgo(8), slug: 'game-b', autoCloseDays: 30 });
    expect(await runAutoClose({ now: NOW })).toBe(1);
  });

  it('skips a disabled workspace', async () => {
    const workspaceId = await seedWorkspace({ slug: 'retired', disabledAt: daysAgo(60) });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'resolved' });
    await seedResolutionCycle({
      workspaceId,
      conversationId,
      resolvedAt: daysAgo(30),
      resolutionKind: 'bot',
    });

    expect(await runAutoClose({ now: NOW })).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && pnpm vitest run tests/jobs.autoClose.test.ts`
Expected: FAIL — `Failed to resolve import ".../autoClose.ts"`.

- [ ] **Step 3: Write the job**

Create `backend/src/shared/jobs/autoClose.ts`:

```ts
import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { conversation, resolutionCycle, workspace } from '../db/schema/index.ts';
import { withWorkspace, withoutWorkspace } from '../db/withWorkspace.ts';
import { appendEvent } from '../events/appendEvent.ts';
import { emitInboxChanged } from '../realtime/emit.ts';
import { tryIo } from '../realtime/tryIo.ts';
import { logger } from '../logging/logger.ts';

export const AUTO_CLOSE_JOB = 'auto-close';

export type RunAutoCloseOptions = { now?: Date };

/**
 * `resolved` → `closed` once the workspace's auto-close window has elapsed.
 *
 * The join to `conversation` filtered on `status = 'resolved'` is required, not
 * decorative. A cycle whose conversation was later reopened keeps its old
 * `resolved_at` and a NULL `closed_at` forever — correct, it records that this
 * resolution never got auto-closed because it reopened first. Without the status
 * filter that stale, superseded cycle would close a conversation that has since
 * moved on.
 *
 * The window is read per workspace, not from an env var: it is a per-tenant
 * product setting.
 */
export async function runAutoClose(options: RunAutoCloseOptions = {}): Promise<number> {
  const now = options.now ?? new Date();

  const workspaces = await withoutWorkspace(async (tx) =>
    tx
      .select({ id: workspace.id, autoCloseDays: workspace.autoCloseDays })
      .from(workspace)
      .where(isNull(workspace.disabledAt)),
  );

  let closed = 0;
  for (const ws of workspaces) {
    const cutoff = new Date(now.getTime() - ws.autoCloseDays * 86_400_000);

    const due = await withWorkspace(ws.id, async (tx) =>
      tx
        .select({ cycleId: resolutionCycle.id, conversationId: resolutionCycle.conversationId })
        .from(resolutionCycle)
        .innerJoin(conversation, eq(conversation.id, resolutionCycle.conversationId))
        .where(
          and(
            isNotNull(resolutionCycle.resolvedAt),
            isNull(resolutionCycle.closedAt),
            lte(resolutionCycle.resolvedAt, cutoff),
            eq(conversation.status, 'resolved'),
          ),
        ),
    );

    for (const row of due) {
      try {
        const done = await withWorkspace(ws.id, async (tx) => {
          // The status is repeated in the UPDATE's WHERE rather than trusted from
          // the select — the same claim-race pattern conversationsService uses.
          // A player who reopened between the scan and here wins, and this
          // becomes a no-op instead of closing a live conversation.
          const updated = await tx
            .update(conversation)
            .set({ status: 'closed' })
            .where(
              and(eq(conversation.id, row.conversationId), eq(conversation.status, 'resolved')),
            )
            .returning({ id: conversation.id });

          if (updated.length === 0) return false;

          await tx
            .update(resolutionCycle)
            .set({ closedAt: now })
            .where(and(eq(resolutionCycle.id, row.cycleId), isNull(resolutionCycle.closedAt)));

          await appendEvent(tx, {
            workspaceId: ws.id,
            type: 'conversation_closed',
            conversationId: row.conversationId,
            actorId: null,
            actorType: 'system',
            // Snapshotted: the window is a mutable per-workspace setting, and an
            // event that only said "auto_close" could never say after what.
            payload: { reason: 'auto_close', days: ws.autoCloseDays },
          });

          return true;
        });

        if (!done) continue;
        closed += 1;

        const io = tryIo('jobs', { workspaceId: ws.id, conversationId: row.conversationId });
        if (io) emitInboxChanged(io, ws.id, row.conversationId, 'closed');
      } catch (error) {
        logger.error('jobs', `auto-close failed for conversation ${row.conversationId}`, {
          workspaceId: ws.id,
          error: error instanceof Error ? `${error.name} ${error.message}` : String(error),
        });
      }
    }
  }

  return closed;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && pnpm vitest run tests/jobs.autoClose.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/shared/jobs/autoClose.ts backend/tests/jobs.autoClose.test.ts
git commit -m "feat(jobs): auto-close resolved conversations past the workspace window"
```

---

### Task 9: Frontend — the banner and the two labels

**Depends on:** Task 3 (only for the merge base; the union it needs landed in Task 1).
**Parallel with:** 4, 5, 6, 7, 8.

Without the first change the player is never shown a Yes/No for a clock-triggered ask, so stage 1
asks a question nothing can answer and every conversation reaches stage 2. See "Two deviations from
the spec" above.

**Files:**

- Modify: `frontend/src/surfaces/webview/pages/SupportChat.tsx:208-216`
- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx:45-49, 159-160`

**Interfaces:**

- Consumes: `ConfirmPhaseValue` and `ResolutionSourceValue` widened in Task 1.
- Produces: nothing.

- [ ] **Step 1: Render the banner for a clock-triggered ask**

In `SupportChat.tsx`, change line 215 and extend the comment above it:

```tsx
// Explicit, not `!== 'none'`. The old check made every future enum value render
// the yes/no banner by default, and 'form' is the value that proved it: the
// banner would have appeared underneath the form card asking about an article
// nobody had offered. So every new phase that IS a yes/no has to be added here
// by hand — 'inactivity_ask' is one, and the inactivity clock's stage 1 is
// unanswerable without it.
const phase = messagesQuery.data?.confirm_phase ?? 'none';
const confirmPending =
  phase === 'bot_article' || phase === 'agent_ask' || phase === 'inactivity_ask';
```

- [ ] **Step 2: Show the agent that a question is outstanding**

In `ThreadPanel.tsx`, change line 160:

```tsx
// Either ask puts the same question on the player's screen; the agent's panel
// must read "waiting" for both, or a clock-triggered ask looks like no ask.
const waiting = confirmPhase === 'agent_ask' || confirmPhase === 'inactivity_ask';
```

- [ ] **Step 3: Name the two new resolvers**

In `ThreadPanel.tsx`, replace `resolverLabel` (lines 45-49):

```tsx
function resolverLabel(
  source: ResolutionSourceValue | null | undefined,
  agentName: string | null | undefined,
): string {
  if (source === 'agent') return `Resolved by ${agentName ?? 'an agent'}`;
  if (source === 'bot') return 'Resolved by the bot';
  if (source === 'player_confirmed') return 'Resolved by the player';
  if (source === 'timed_out') return 'Resolved after no reply';
  return 'Closed';
}
```

- [ ] **Step 4: Verify**

Run: `cd frontend && pnpm typecheck && pnpm build`
Expected: PASS.

Run: `cd .. && pnpm test`
Expected: PASS (frontend suite; the backend suite needs Postgres up).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces
git commit -m "feat(frontend): render the banner for inactivity_ask and label the new resolvers"
```

---

## WAVE B — Tasks 10 and 11 run in parallel

---

### Task 10: Register both schedulers

**Depends on:** Tasks 7 and 8 merged. **Parallel with:** 11.

**Files:**

- Modify: `backend/src/shared/jobs/queue.ts:1-57`

**Interfaces:**

- Consumes: `INACTIVITY_CLOCK_JOB`, `runInactivityClock` (Task 7); `AUTO_CLOSE_JOB`, `runAutoClose`
  (Task 8).
- Produces: nothing.

- [ ] **Step 1: Add the imports and the two schedulers**

In `backend/src/shared/jobs/queue.ts`, add after line 6:

```ts
import { INACTIVITY_CLOCK_JOB, runInactivityClock } from './inactivityClock.ts';
import { AUTO_CLOSE_JOB, runAutoClose } from './autoClose.ts';
```

Leave the existing local `SESSION_TIMEOUT_JOB` / `FORM_TIMEOUT_JOB` constants exactly as they are —
do not add two more beside them. The new job names are exported by the modules that own them, so the
name and the function that runs it can never drift apart.

After the `FORM_TIMEOUT_JOB` scheduler (line 41), add:

```ts
// Same five-minute cadence and stable-jobId rule as the two above. Five
// minutes is granular enough for a 24-hour window and cheap enough to run on
// an empty queue.
await queue.upsertJobScheduler(
  INACTIVITY_CLOCK_JOB,
  { pattern: '*/5 * * * *' },
  { name: INACTIVITY_CLOCK_JOB, opts: { removeOnComplete: 50, removeOnFail: 100 } },
);

await queue.upsertJobScheduler(
  AUTO_CLOSE_JOB,
  { pattern: '*/5 * * * *' },
  { name: AUTO_CLOSE_JOB, opts: { removeOnComplete: 50, removeOnFail: 100 } },
);
```

- [ ] **Step 2: Dispatch them in the worker handler**

Inside the `Worker` handler, after the `FORM_TIMEOUT_JOB` block (line 54), add:

```ts
if (job.name === INACTIVITY_CLOCK_JOB) {
  const { asked, timedOut } = await runInactivityClock();
  if (asked > 0 || timedOut > 0) {
    logger.info('jobs', `inactivity clock asked ${asked}, timed out ${timedOut}`);
  }
  return;
}
if (job.name === AUTO_CLOSE_JOB) {
  const closed = await runAutoClose();
  if (closed > 0) logger.info('jobs', `auto-closed ${closed} conversation(s)`);
}
```

Add `return` to the end of the existing `FORM_TIMEOUT_JOB` block so the chain reads consistently.

- [ ] **Step 3: Verify**

Run: `cd .. && pnpm typecheck`
Expected: PASS.

Run: `cd backend && pnpm vitest run tests/jobs.inactivityClock.test.ts tests/jobs.autoClose.test.ts`
Expected: PASS.

Run (manual smoke, Redis and Postgres up): `pnpm dev`, then confirm the startup logs show no job
registration error and that `jobs` logs appear within five minutes if any conversation is due.

- [ ] **Step 4: Commit**

```bash
git add backend/src/shared/jobs/queue.ts
git commit -m "feat(jobs): register the inactivity-clock and auto-close schedulers"
```

---

### Task 11: End-to-end lifecycle test, API docs and status-transitions doc

**Depends on:** all of Wave A merged. **Parallel with:** 10.

**Files:**

- Create: `backend/tests/resolution.inactivityLifecycle.test.ts`
- Modify: `backend/src/docs/openapi.ts:600, 935`
- Modify: `docs/status-transitions.md`

**Interfaces:**

- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the end-to-end test**

Create `backend/tests/resolution.inactivityLifecycle.test.ts`. Read
`backend/tests/resolution.crossPath.test.ts` first and reuse its fixture style verbatim.

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { conversation, resolutionCycle } from '../src/shared/db/schema/index.ts';
import { applyResolutionAnswer } from '../src/domain/conversations/index.ts';
import { sendPlayerMessage } from '../src/surface/services/messagesService.ts';
import { runInactivityClock } from '../src/shared/jobs/inactivityClock.ts';
import { runAutoClose } from '../src/shared/jobs/autoClose.ts';
import { closeOwnerPool, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts';

const T0 = new Date('2026-08-18T12:00:00Z');
const plusHours = (n: number) => new Date(T0.getTime() + n * 3_600_000);
const plusDays = (n: number) => new Date(T0.getTime() + n * 86_400_000);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

const state = (workspaceId: string, conversationId: string) =>
  withWorkspace(workspaceId, async (tx) => {
    const [conv] = await tx.select().from(conversation).where(eq(conversation.id, conversationId));
    const cycles = await tx
      .select()
      .from(resolutionCycle)
      .where(eq(resolutionCycle.conversationId, conversationId))
      .orderBy(desc(resolutionCycle.cycleNo));
    return { conv: conv!, cycles };
  });

describe('inactivity clock end to end', () => {
  it('runs open → ask → timeout → auto-close → reopen as one cycle chain', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game', autoCloseDays: 7 });
    const playerId = await seedPlayer(workspaceId);
    const ctx = { workspaceId, playerId } as never;

    const { conversation_id } = await sendPlayerMessage(ctx, { body: 'my gems vanished' });
    await withWorkspace(workspaceId, (tx) =>
      tx.update(conversation).set({ status: 'open' }).where(eq(conversation.id, conversation_id)),
    );
    // A public reply is what starts the clock — the same hook every path uses.
    await withWorkspace(workspaceId, (tx) =>
      tx
        .update(resolutionCycle)
        .set({ inactivityDueAt: plusHours(24) })
        .where(eq(resolutionCycle.conversationId, conversation_id)),
    );

    // Stage 1 at T+25h.
    expect(await runInactivityClock({ now: plusHours(25) })).toEqual({ asked: 1, timedOut: 0 });
    expect((await state(workspaceId, conversation_id)).conv.confirmPhase).toBe('inactivity_ask');

    // Stage 2 at T+50h — 24h after the ask, nobody answered.
    expect(await runInactivityClock({ now: plusHours(50) })).toEqual({ asked: 0, timedOut: 1 });
    const timedOut = await state(workspaceId, conversation_id);
    expect(timedOut.conv.status).toBe('resolved');
    expect(timedOut.conv.resolutionSource).toBe('timed_out');
    expect(timedOut.cycles[0]!.resolutionKind).toBe('timed_out');
    expect(timedOut.cycles[0]!.supportOwedFlag).toBe(true);

    // Auto-close seven days after the resolve.
    expect(await runAutoClose({ now: plusDays(10) })).toBe(1);
    const closed = await state(workspaceId, conversation_id);
    expect(closed.conv.status).toBe('closed');
    expect(closed.cycles[0]!.closedAt).not.toBeNull();

    // Reopen opens cycle 2 and leaves cycle 1's record intact.
    await sendPlayerMessage(ctx, { body: 'it happened again' });
    const reopened = await state(workspaceId, conversation_id);
    expect(reopened.conv.status).toBe('open');
    expect(reopened.cycles.map((c) => c.cycleNo)).toEqual([2, 1]);
    expect(reopened.cycles[1]!.resolutionKind).toBe('timed_out');
    expect(reopened.cycles[0]!.inactivityDueAt).not.toBeNull();
  });

  it('a player answering Yes to the clock resolves as player_confirmed and stops the clock', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId);
    const ctx = { workspaceId, playerId } as never;

    const { conversation_id } = await sendPlayerMessage(ctx, { body: 'help' });
    await withWorkspace(workspaceId, async (tx) => {
      await tx
        .update(conversation)
        .set({ status: 'open' })
        .where(eq(conversation.id, conversation_id));
      await tx
        .update(resolutionCycle)
        .set({ inactivityDueAt: plusHours(24) })
        .where(eq(resolutionCycle.conversationId, conversation_id));
    });

    await runInactivityClock({ now: plusHours(25) });
    await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(
        tx,
        { workspaceId, conversationId: conversation_id, playerId, sessionId: null },
        true,
      ),
    );

    const after = await state(workspaceId, conversation_id);
    expect(after.conv.status).toBe('resolved');
    expect(after.conv.resolutionSource).toBe('player_confirmed');
    expect(after.cycles[0]!.inactivityDueAt).toBeNull();

    // Stage 2 must find nothing left to time out.
    expect(await runInactivityClock({ now: plusHours(60) })).toEqual({ asked: 0, timedOut: 0 });
  });

  it('a player answering No restarts the clock instead of resolving', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId);
    const ctx = { workspaceId, playerId } as never;

    const { conversation_id } = await sendPlayerMessage(ctx, { body: 'help' });
    await withWorkspace(workspaceId, async (tx) => {
      await tx
        .update(conversation)
        .set({ status: 'open' })
        .where(eq(conversation.id, conversation_id));
      await tx
        .update(resolutionCycle)
        .set({ inactivityDueAt: plusHours(24) })
        .where(eq(resolutionCycle.conversationId, conversation_id));
    });

    await runInactivityClock({ now: plusHours(25) });
    await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(
        tx,
        { workspaceId, conversationId: conversation_id, playerId, sessionId: null },
        false,
      ),
    );

    const after = await state(workspaceId, conversation_id);
    expect(after.conv.status).toBe('open');
    expect(after.conv.confirmPhase).toBe('none');
    expect(after.cycles[0]!.resolvedAt).toBeNull();
    expect(after.cycles[0]!.inactivityDueAt).not.toBeNull();
  });

  it('an escalated conversation is never asked and never timed out', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId);
    const ctx = { workspaceId, playerId } as never;

    const { conversation_id } = await sendPlayerMessage(ctx, { body: 'help' });
    await withWorkspace(workspaceId, async (tx) => {
      await tx
        .update(conversation)
        .set({ status: 'escalated' })
        .where(eq(conversation.id, conversation_id));
      await tx
        .update(resolutionCycle)
        .set({ inactivityDueAt: plusHours(1) })
        .where(eq(resolutionCycle.conversationId, conversation_id));
    });

    expect(await runInactivityClock({ now: plusHours(100) })).toEqual({ asked: 0, timedOut: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it passes**

Run: `cd backend && pnpm vitest run tests/resolution.inactivityLifecycle.test.ts`
Expected: PASS.

- [ ] **Step 3: Update the API docs text**

In `backend/src/docs/openapi.ts`, line 600, append to the `ask-resolved` description:

```
 The inactivity clock sets confirm_phase = inactivity_ask on the same conversation shape after 24h of silence; the two are distinguished so the resolution can be attributed to `agent` or `player_confirmed`.
```

Line 935, replace the `/resolution-answer` description with:

```
"The banner's Yes/No, for all three sources. Yes resolves the conversation — source `bot` on bot_article, `agent` on agent_ask, `player_confirmed` on inactivity_ask. No hands off to a human on bot_article, and only clears the phase on agent_ask and inactivity_ask (which restarts the inactivity clock). 409 when no check is pending."
```

- [ ] **Step 4: Update `docs/status-transitions.md`**

Move these two rows out of the "Not implemented" table into the implemented table, with the
implementing code named the way the rest of that file names it:

- `open` / `awaiting_player` → `resolved` — `shared/jobs/inactivityClock.ts` stage 2
  (`resolution_source = 'timed_out'`), or `domain/conversations/resolutionAnswer.ts`'s
  `inactivity_ask` Yes branch (`resolution_source = 'player_confirmed'`). Event:
  `conversation_resolved`.
- `resolved` → `closed` — `shared/jobs/autoClose.ts`, after `workspace.auto_close_days`. Event:
  `conversation_closed`, `payload.reason = 'auto_close'`.

Leave the agent-initiated-resolve row where it is — it is explicitly out of scope for this slice.

- [ ] **Step 5: Full verification**

Run: `cd .. && pnpm typecheck`
Expected: PASS.

Run: `cd .. && pnpm test`
Expected: PASS — both suites, with Postgres up.

- [ ] **Step 6: Commit**

```bash
git add backend/tests/resolution.inactivityLifecycle.test.ts backend/src/docs/openapi.ts docs/status-transitions.md
git commit -m "test(resolution): cover the inactivity lifecycle end to end and update the docs"
```

---

## Out of scope (from spec §7, unchanged)

- `first_human_reply_at` population — the column ships, the metrics slice fills it.
- Any queue filter or report column reading `support_owed_flag`.
- Agent-initiated resolve (`open`/`awaiting_player` → `resolved` by an explicit agent action).
