# Agent Player Context Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the agent-side reader for the context rail — a per-workspace ticket number, a conversation detail endpoint, and one context endpoint carrying player state plus the player's ticket history.

**Architecture:** One schema change (`workspace.ticket_seq` + `conversation.number`) allocated at a single choke point mirroring `postMessage`'s `message_seq` bump; two new read endpoints on the existing `agent/routers/conversationsRouter.ts` backed by a new `conversationContextService.ts`. Everything runs inside `withWorkspace`, so RLS scopes every read and a cross-workspace id yields `404`.

**Tech Stack:** Express 5, TypeScript, Zod, Drizzle ORM, PostgreSQL 17 with RLS, Vitest + supertest, `@asteasolutions/zod-to-openapi` registry.

**Source spec:** `docs/specs/2026-08-17-agent-player-context-backend-design.md` (approved).

---

## Deviations from the spec — read before starting

Three things the spec did not account for. Each is resolved below; if you disagree with a resolution, raise it before writing code rather than improvising.

**1. `support_app` cannot write `workspace`.** The spec allocates the number with
`update workspace set ticket_seq = ticket_seq + 1`. But `backend/src/shared/db/sql/002_rls.sql:63` reads:

```sql
REVOKE INSERT, UPDATE ON workspace FROM support_app;
```

The request path connects as `support_app`, so that UPDATE fails with `permission denied for table workspace`. The stated reason for the revoke is narrow and explicit (002_rls.sql:52-56): stop a buggy handler rewriting another game's `secret_hash`. **Resolution: a column-scoped grant**, added to `002_rls.sql` in Task 1:

```sql
GRANT UPDATE (ticket_seq) ON workspace TO support_app;
```

`secret_hash` stays unwritable. The same file already names column-scoped grants as the intended direction for `agent` (002_rls.sql:62), so this is the existing plan applied one table over, not a new idea. The alternative — a separate scoped `workspace_ticket_seq` table — was rejected: it earns an RLS policy automatically but adds a table, a provisioning path, and an upsert for something that is one integer on a row that already exists.

**2. There is no `resolved_by_agent_id` column.** `conversation` has `assignedAgentId` and `resolutionSource`, nothing else. `resolved_by_agent_name` is therefore defined as: **the assigned agent's `display_name` when `resolution_source = 'agent'`, otherwise `null`.** This is what the schema knows, consistent with the spec's own "Only what the schema knows" rule. The more precise source would be the `conversation_resolved` event's `actor_id`, but that is a third query and the spec caps the ticket list at two.

**3. `summary.total_reopened` is unscoped in the spec.** Defined here as: **the sum of `conversation_reopened` events across all of the player's other conversations in this workspace** — the same population as `total_tickets`, not just the 20 returned rows. Computed in the same grouped query, so it stays at two queries.

## Global Constraints

- Every new endpoint MUST be registered in `backend/src/docs/openapi.ts` with its Zod schemas. A route without a Swagger entry is incomplete (CLAUDE.md).
- All four `player_state` branches return `200`. Missing player state is a state, not an error — never reject a conversation because of it (CLAUDE.md).
- `state.raw` is PII by default. It is returned in full, not role-gated, and viewing it writes no event. This is deliberate (spec §`raw` is returned in full).
- No hard deletes. No `DELETE` route, no `ON DELETE CASCADE`.
- Expect `404`, never `403`, for a cross-workspace id.
- Never `console.*` — use `logger` from `backend/src/shared/logging/logger.ts`.
- Every DB read/write goes through `withWorkspace(workspaceId, async (tx) => …)`.
- No message bodies anywhere in these endpoints. `toAgentView` is not involved, and the `message` table is never touched.
- Tests require Postgres up. Run from `backend/`: `pnpm vitest run tests/<file>`.
- After any schema edit: `pnpm db:generate` then `pnpm db:setup`. Commit the generated migration.
- Do not add a `Co-Authored-By` trailer to commits.

---

## File Structure

| Path                                                       | Change                                           |
| ---------------------------------------------------------- | ------------------------------------------------ |
| `backend/src/shared/db/schema/identity.ts`                 | add `workspace.ticketSeq`                        |
| `backend/src/shared/db/schema/conversations.ts`            | add `conversation.number` + unique index         |
| `backend/src/shared/db/sql/002_rls.sql`                    | column-scoped `GRANT UPDATE (ticket_seq)`        |
| `backend/drizzle/0003_ticket_number.sql`                   | hand-ordered migration, five steps               |
| `backend/drizzle/meta/_journal.json`                       | new entry (generated)                            |
| `backend/src/domain/conversations/allocateTicketNumber.ts` | **new** — the one place that bumps `ticket_seq`  |
| `backend/src/domain/conversations/index.ts`                | re-export the allocator                          |
| `backend/src/surface/services/newTicketService.ts`         | allocate number on insert                        |
| `backend/src/surface/services/messagesService.ts`          | allocate number on auto-create                   |
| `backend/src/agent/services/conversationContextService.ts` | **new** — detail + player state + ticket history |
| `backend/src/agent/controllers/conversationsController.ts` | two handlers                                     |
| `backend/src/agent/routers/conversationsRouter.ts`         | two routes                                       |
| `backend/src/docs/openapi.ts`                              | two paths + response schemas                     |
| `packages/types/src/agent-context.ts`                      | **new** — the response types                     |
| `packages/types/src/index.ts`                              | barrel export                                    |
| `backend/tests/helpers/db.ts`                              | `seedConversation` allocates a number            |
| `backend/tests/schema.test.ts`                             | raw insert needs a number                        |
| `backend/tests/rls.test.ts`                                | two raw inserts need a number                    |
| `backend/tests/ticketNumber.test.ts`                       | **new**                                          |
| `backend/tests/agent.conversationDetail.test.ts`           | **new**                                          |
| `backend/tests/agent.conversationContext.test.ts`          | **new**                                          |

A new service file rather than growing `conversationsService.ts`, which is 82 lines of claim/list/messages and would roughly double with unrelated concerns.

---

## Task 1: Schema, grant, and migration for ticket numbers

**Files:**

- Modify: `backend/src/shared/db/schema/identity.ts:11-20`
- Modify: `backend/src/shared/db/schema/conversations.ts:24-67`
- Modify: `backend/src/shared/db/sql/002_rls.sql:63`
- Create: `backend/drizzle/0003_ticket_number.sql` (via `db:generate`, then hand-edited)
- Test: `backend/tests/ticketNumber.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `workspace.ticketSeq` (`integer('ticket_seq').notNull().default(0)`), `conversation.number` (`integer('number').notNull()`), unique index `conversation_workspace_number_uk` on `(workspace_id, number)`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/ticketNumber.test.ts`. This task's tests cover the schema and the backfill only; allocation-on-create is Task 2.

```typescript
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeOwnerPool, ownerPool, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts';

afterAll(async () => {
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('ticket number schema', () => {
  it('has ticket_seq on workspace defaulting to 0', async () => {
    const workspaceId = await seedWorkspace();
    const { rows } = await ownerPool.query<{ ticket_seq: number }>(
      `select ticket_seq from workspace where id = $1`,
      [workspaceId],
    );
    expect(rows[0]!.ticket_seq).toBe(0);
  });

  it('rejects a second conversation with the same number in one workspace', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    await ownerPool.query(
      `insert into conversation (workspace_id, player_id, number) values ($1, $2, 7)`,
      [workspaceId, playerId],
    );
    await expect(
      ownerPool.query(
        `insert into conversation (workspace_id, player_id, number) values ($1, $2, 7)`,
        [workspaceId, playerId],
      ),
    ).rejects.toThrow(/conversation_workspace_number_uk/);
  });

  it('allows the same number in two different workspaces', async () => {
    const wsA = await seedWorkspace();
    const wsB = await seedWorkspace();
    const playerA = await seedPlayer(wsA);
    const playerB = await seedPlayer(wsB);
    await ownerPool.query(
      `insert into conversation (workspace_id, player_id, number) values ($1, $2, 1)`,
      [wsA, playerA],
    );
    await expect(
      ownerPool.query(
        `insert into conversation (workspace_id, player_id, number) values ($1, $2, 1)`,
        [wsB, playerB],
      ),
    ).resolves.toBeDefined();
  });

  it('rejects a conversation with no number', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    await expect(
      ownerPool.query(`insert into conversation (workspace_id, player_id) values ($1, $2)`, [
        workspaceId,
        playerId,
      ]),
    ).rejects.toThrow(/not-null/i);
  });

  it('grants support_app UPDATE on ticket_seq but not on secret_hash', async () => {
    const { rows: allowed } = await ownerPool.query<{ ok: boolean }>(
      `select has_column_privilege('support_app', 'workspace', 'ticket_seq', 'UPDATE') as ok`,
    );
    expect(allowed[0]!.ok).toBe(true);

    const { rows: denied } = await ownerPool.query<{ ok: boolean }>(
      `select has_column_privilege('support_app', 'workspace', 'secret_hash', 'UPDATE') as ok`,
    );
    expect(denied[0]!.ok).toBe(false);
  });
});

// The migration's backfill, replayed against rows that were numbered before it
// ran. NOT NULL is already on the column by the time tests run, so the
// constraint is dropped for the duration and restored in a finally — this
// exercises the real statements from the shipped migration file rather than a
// paraphrase of them.
describe('ticket number backfill', () => {
  it('numbers each workspace contiguously from 1 by created_at and leaves ticket_seq at the max', async () => {
    const wsA = await seedWorkspace();
    const wsB = await seedWorkspace();
    const playerA = await seedPlayer(wsA);
    const playerB = await seedPlayer(wsB);

    const mk = async (workspaceId: string, playerId: string, createdAt: string) => {
      const id = randomUUID();
      await ownerPool.query(
        `insert into conversation (id, workspace_id, player_id, number, created_at) values ($1, $2, $3, 999, $4)`,
        [id, workspaceId, playerId, createdAt],
      );
      return id;
    };

    const a1 = await mk(wsA, playerA, '2026-01-01T00:00:00Z');
    const a2 = await mk(wsA, playerA, '2026-01-02T00:00:00Z');
    const a3 = await mk(wsA, playerA, '2026-01-03T00:00:00Z');
    const b1 = await mk(wsB, playerB, '2026-01-05T00:00:00Z');

    await ownerPool.query(`alter table conversation alter column number drop not null`);
    try {
      await ownerPool.query(`update conversation set number = null`);
      await ownerPool.query(`update workspace set ticket_seq = 0`);

      const sql = readFileSync(
        new URL('../drizzle/0003_ticket_number.sql', import.meta.url),
        'utf8',
      );
      const backfill = sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s.includes('BACKFILL'));
      expect(backfill).toHaveLength(2);
      for (const statement of backfill) await ownerPool.query(statement);

      const { rows } = await ownerPool.query<{ id: string; number: number }>(
        `select id, number from conversation order by workspace_id, number`,
      );
      const byId = new Map(rows.map((r) => [r.id, r.number]));
      expect(byId.get(a1)).toBe(1);
      expect(byId.get(a2)).toBe(2);
      expect(byId.get(a3)).toBe(3);
      expect(byId.get(b1)).toBe(1);

      const { rows: seqs } = await ownerPool.query<{ id: string; ticket_seq: number }>(
        `select id, ticket_seq from workspace`,
      );
      const seqById = new Map(seqs.map((r) => [r.id, r.ticket_seq]));
      expect(seqById.get(wsA)).toBe(3);
      expect(seqById.get(wsB)).toBe(1);
    } finally {
      await ownerPool.query(`update conversation set number = 0 where number is null`);
      await ownerPool.query(`alter table conversation alter column number set not null`);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && pnpm vitest run tests/ticketNumber.test.ts`
Expected: FAIL — `column "ticket_seq" does not exist`.

- [ ] **Step 3: Add `ticket_seq` to the workspace schema**

In `backend/src/shared/db/schema/identity.ts`, add the column to `workspace` (currently lines 11-20). `integer` must be added to the `drizzle-orm/pg-core` import list at the top of the file.

```typescript
export const workspace = pgTable('workspace', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  secretHash: text('secret_hash').notNull(),
  /**
   * The per-workspace ticket counter. Bumped inside the conversation-insert
   * transaction by allocateTicketNumber(), exactly as message_seq is bumped by
   * postMessage(). Not a bigserial: a global sequence would make #1042 a count
   * of every ticket across every tenant, so each workspace would see a sparse
   * sequence and could infer its neighbours' volume from the gaps.
   */
  ticketSeq: integer('ticket_seq').notNull().default(0),
  disabledAt: timestamp('disabled_at', tz),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});
```

- [ ] **Step 4: Add `number` to the conversation schema**

In `backend/src/shared/db/schema/conversations.ts`, add the column after `messageSeq` (line 55) and the unique index to the index array (lines 58-66).

```typescript
    messageSeq: integer('message_seq').notNull().default(0),
    /**
     * The per-workspace ticket number the agent console displays as #1042.
     * No default: it is allocated by allocateTicketNumber() in the same
     * transaction as this insert, and a default would hide a creation path
     * that forgot to.
     */
    number: integer('number').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    index('conversation_workspace_player_idx').on(t.workspaceId, t.playerId),
    index('conversation_workspace_subintent_idx').on(t.workspaceId, t.subintentId),
    uniqueIndex('conversation_workspace_number_uk').on(t.workspaceId, t.number),
    foreignKey({
      name: 'conversation_subintent_fk',
      columns: [t.workspaceId, t.subintentId],
      foreignColumns: [subintent.workspaceId, subintent.id],
    }).onDelete('restrict'),
  ],
)
```

- [ ] **Step 5: Add the column-scoped grant**

In `backend/src/shared/db/sql/002_rls.sql`, immediately after line 63 (`REVOKE INSERT, UPDATE ON workspace FROM support_app;`), append:

```sql
-- ...with one column-scoped exception. conversation.number is allocated on the
-- request path (allocateTicketNumber), which needs to bump this counter and
-- nothing else on the row. Granting the column rather than the table keeps
-- secret_hash unwritable by support_app, which is the whole point of the
-- REVOKE above. This is the same narrowing named as future work for `agent`,
-- applied one table over.
GRANT UPDATE (ticket_seq) ON workspace TO support_app;
```

- [ ] **Step 6: Generate the migration**

Run: `cd backend && pnpm db:generate`
Expected: a new `backend/drizzle/0003_*.sql` plus a `meta/0003_snapshot.json` and a new `_journal.json` entry.

Rename the generated SQL file to `backend/drizzle/0003_ticket_number.sql` and update the `tag` field of the last entry in `backend/drizzle/meta/_journal.json` to `"0003_ticket_number"` to match. Leave `idx`, `when` and `version` as generated.

- [ ] **Step 7: Hand-edit the migration into the five ordered steps**

Drizzle generates `ADD COLUMN "number" integer NOT NULL` in one shot, which fails on any database that already holds conversations. Replace the whole body of `backend/drizzle/0003_ticket_number.sql` with:

```sql
-- Five steps, in this order, because the backfill runs against databases that
-- already hold conversations. A NOT NULL column added in one step would abort
-- on every one of them. The end state matches meta/0003_snapshot.json.

-- 1. the counter
ALTER TABLE "workspace" ADD COLUMN "ticket_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- 2. the column, nullable for now
ALTER TABLE "conversation" ADD COLUMN "number" integer;--> statement-breakpoint

-- 3. BACKFILL — number each workspace's conversations from 1 by created_at.
--    Ties broken by id so a re-run is deterministic.
UPDATE "conversation" AS c
   SET "number" = n.rn
  FROM (
    SELECT id,
           row_number() OVER (PARTITION BY workspace_id ORDER BY created_at, id) AS rn
      FROM "conversation"
  ) AS n
 WHERE c.id = n.id
   AND c."number" IS NULL;--> statement-breakpoint

-- 4. BACKFILL — park each workspace's counter on its own max, so the next
--    allocation continues the sequence instead of colliding with it.
UPDATE "workspace" AS w
   SET "ticket_seq" = COALESCE(m.max_number, 0)
  FROM (
    SELECT ws.id, MAX(c."number") AS max_number
      FROM "workspace" ws
      LEFT JOIN "conversation" c ON c.workspace_id = ws.id
     GROUP BY ws.id
  ) AS m
 WHERE w.id = m.id;--> statement-breakpoint

-- 5. now the constraint holds, so state it
ALTER TABLE "conversation" ALTER COLUMN "number" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_workspace_number_uk" ON "conversation" USING btree ("workspace_id","number");
```

The `BACKFILL` marker in the comments on steps 3 and 4 is what the test selects on — keep it.

- [ ] **Step 8: Fix the raw-SQL conversation inserts in existing tests**

Three existing call sites insert a conversation without a number and will now fail. Update each:

`backend/tests/helpers/db.ts:100-111` — allocate from the counter so seeded conversations behave like real ones:

```typescript
export async function seedConversation(args: {
  workspaceId: string;
  playerId: string;
  sessionId?: string | null;
  createdAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  // Bumped the same way the request path bumps it, so a test that seeds three
  // conversations sees #1, #2, #3 rather than three rows fighting over one number.
  const { rows } = await ownerPool.query<{ ticket_seq: number }>(
    `update workspace set ticket_seq = ticket_seq + 1 where id = $1 returning ticket_seq`,
    [args.workspaceId],
  );
  const number = rows[0]!.ticket_seq;
  await ownerPool.query(
    `insert into conversation (id, workspace_id, player_id, session_id, number, created_at)
     values ($1, $2, $3, $4, $5, coalesce($6, now()))`,
    [id, args.workspaceId, args.playerId, args.sessionId ?? null, number, args.createdAt ?? null],
  );
  return id;
}
```

`backend/tests/schema.test.ts:221` — add the column:

```typescript
      `insert into conversation (workspace_id, player_id, number) values ($1, $2, 1) returning id, confirm_phase`,
```

`backend/tests/rls.test.ts:275` — add the column:

```typescript
      `insert into conversation (workspace_id, player_id, session_id, number) values ($1, $2, $3, 1) returning id`,
```

`backend/tests/rls.test.ts:296` — this one asserts an RLS _denial_, so the number just has to be present and not collide:

```typescript
        sql: `insert into conversation (workspace_id, player_id, number) values ($1, $2, 1)`,
```

- [ ] **Step 9: Apply the migration and run the tests**

Run: `cd backend && pnpm db:setup && pnpm vitest run tests/ticketNumber.test.ts tests/schema.test.ts tests/rls.test.ts`
Expected: PASS on all three files.

- [ ] **Step 10: Commit**

```bash
git add backend/src/shared/db/schema/identity.ts \
        backend/src/shared/db/schema/conversations.ts \
        backend/src/shared/db/sql/002_rls.sql \
        backend/drizzle/ \
        backend/tests/ticketNumber.test.ts \
        backend/tests/helpers/db.ts \
        backend/tests/schema.test.ts \
        backend/tests/rls.test.ts
git commit -m "feat(db): per-workspace ticket numbers on conversation"
```

---

## Task 2: Allocate the number on both creation paths

**Files:**

- Create: `backend/src/domain/conversations/allocateTicketNumber.ts`
- Modify: `backend/src/domain/conversations/index.ts`
- Modify: `backend/src/surface/services/newTicketService.ts:82-86`
- Modify: `backend/src/surface/services/messagesService.ts:77-81`
- Test: `backend/tests/ticketNumber.test.ts` (append a describe block)

**Interfaces:**

- Consumes: `workspace.ticketSeq` and `conversation.number` from Task 1.
- Produces: `allocateTicketNumber(tx: Tx, workspaceId: string): Promise<number>` — exported from `backend/src/domain/conversations/index.ts`. Must be called inside the caller's transaction, immediately before the conversation insert.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/ticketNumber.test.ts`. Add these imports to the file's existing import block:

```typescript
import { createServer } from 'node:http';
import { req as request } from './helpers/http.ts';
import { app, mintToken } from './helpers/app.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { seedBotConfig, seedSession } from './helpers/db.ts';
import { vi, beforeAll } from 'vitest';
```

Add the bot-turn mock at the top level of the file, alongside the other imports — `POST /surface/messages` enqueues a bot turn and this suite has no worker:

```typescript
vi.mock('../src/shared/jobs/botTurns.ts', () => ({
  enqueueBotTurn: vi.fn().mockResolvedValue(undefined),
}));
```

Widen the existing `afterAll` to also close the db and socket server, and add a `beforeAll` that creates one:

```typescript
beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeDb();
  await closeOwnerPool();
});
```

Then append:

```typescript
describe('ticket number allocation', () => {
  async function setupPlayer() {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    await seedSession({ workspaceId, playerId });
    await seedBotConfig({ workspaceId, isProvisioned: false });
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p1',
    });
    return { workspaceId, playerId, token };
  }

  async function numberOf(conversationId: string): Promise<number> {
    const { rows } = await ownerPool.query<{ number: number }>(
      `select number from conversation where id = $1`,
      [conversationId],
    );
    return rows[0]!.number;
  }

  it('numbers the auto-created conversation from the first message', async () => {
    const { token } = await setupPlayer();
    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello' })
      .expect(200);
    expect(await numberOf(res.body.conversation_id)).toBe(1);
  });

  it('numbers a new ticket, continuing the same workspace sequence', async () => {
    const { workspaceId, token } = await setupPlayer();
    const first = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello' })
      .expect(200);

    await ownerPool.query(`update conversation set status = 'resolved' where id = $1`, [
      first.body.conversation_id,
    ]);

    const second = await request(app)
      .post('/surface/new-ticket')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);

    expect(await numberOf(second.body.conversation_id)).toBe(2);

    const { rows } = await ownerPool.query<{ ticket_seq: number }>(
      `select ticket_seq from workspace where id = $1`,
      [workspaceId],
    );
    expect(rows[0]!.ticket_seq).toBe(2);
  });

  it('numbers two workspaces independently from 1', async () => {
    const a = await setupPlayer();
    const b = await setupPlayer();

    const resA = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ body: 'from a' })
      .expect(200);
    const resB = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ body: 'from b' })
      .expect(200);

    expect(await numberOf(resA.body.conversation_id)).toBe(1);
    expect(await numberOf(resB.body.conversation_id)).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && pnpm vitest run tests/ticketNumber.test.ts -t "ticket number allocation"`
Expected: FAIL — the conversation insert violates the `number` NOT NULL constraint.

- [ ] **Step 3: Write the allocator**

Create `backend/src/domain/conversations/allocateTicketNumber.ts`:

```typescript
import { eq, sql } from 'drizzle-orm';
import { workspace } from '../../shared/db/schema/index.ts';
import type { Tx } from '../../shared/db/withWorkspace.ts';

/**
 * The one place that bumps `workspace.ticket_seq`. Always in the caller's
 * transaction, always immediately before the conversation insert that consumes
 * the number — exactly the shape of postMessage()'s message_seq bump.
 *
 * The UPDATE takes a row lock on the workspace row, so a second concurrent
 * creation in the same workspace blocks until this one commits. That lock, not
 * any application-level retry, is what makes the sequence gap-free of
 * duplicates. It serialises conversation creation per workspace; at this scale
 * that is free, and it is the price of a number an agent can read aloud.
 *
 * support_app holds a column-scoped GRANT UPDATE (ticket_seq) on workspace and
 * nothing else on that table — see sql/002_rls.sql. Do not widen this function
 * to write any other workspace column; the grant will refuse it.
 */
export async function allocateTicketNumber(tx: Tx, workspaceId: string): Promise<number> {
  const [bumped] = await tx
    .update(workspace)
    .set({ ticketSeq: sql`${workspace.ticketSeq} + 1` })
    .where(eq(workspace.id, workspaceId))
    .returning({ number: workspace.ticketSeq });

  if (!bumped) {
    throw new Error(`allocateTicketNumber: workspace ${workspaceId} not found`);
  }
  return bumped.number;
}
```

If `Tx` is not exported from `backend/src/shared/db/withWorkspace.ts`, export the existing type alias there rather than redefining it — check how `backend/src/domain/conversations/postMessage.ts` imports its own `Tx` and copy that import verbatim.

- [ ] **Step 4: Re-export it**

Add to `backend/src/domain/conversations/index.ts`, following the export style already in that file:

```typescript
export { allocateTicketNumber } from './allocateTicketNumber.ts';
```

- [ ] **Step 5: Allocate in `newTicketService.ts`**

Replace lines 82-86 of `backend/src/surface/services/newTicketService.ts`:

```typescript
const number = await allocateTicketNumber(tx, ctx.workspaceId);
const [created] = await tx
  .insert(conversation)
  .values({ workspaceId: ctx.workspaceId, playerId: ctx.playerId, sessionId, number })
  .returning({ id: conversation.id, status: conversation.status });
if (!created) throw new Error('openNewTicket: conversation insert returned nothing');
```

Add to that file's imports:

```typescript
import { allocateTicketNumber } from '../../domain/conversations/index.ts';
```

- [ ] **Step 6: Allocate in `messagesService.ts`**

Replace lines 77-81 of `backend/src/surface/services/messagesService.ts`:

```typescript
const number = await allocateTicketNumber(tx, ctx.workspaceId);
const [created] = await tx
  .insert(conversation)
  .values({
    workspaceId: ctx.workspaceId,
    playerId: ctx.playerId,
    sessionId: originatingSessionId,
    number,
  })
  .returning({ id: conversation.id });
if (!created) throw new Error('conversation insert returned nothing');
```

Add `allocateTicketNumber` to that file's existing import from `../../domain/conversations/index.ts` if one is present; otherwise add the import line.

- [ ] **Step 7: Run the tests**

Run: `cd backend && pnpm vitest run tests/ticketNumber.test.ts`
Expected: PASS, all describes.

- [ ] **Step 8: Run the full surface suite for regressions**

Run: `cd backend && pnpm vitest run tests/surface.messages.test.ts tests/surface.newTicket.test.ts tests/bot.reopen.test.ts`
Expected: PASS. These are the suites that create conversations through the real paths.

- [ ] **Step 9: Commit**

```bash
git add backend/src/domain/conversations/ \
        backend/src/surface/services/newTicketService.ts \
        backend/src/surface/services/messagesService.ts \
        backend/tests/ticketNumber.test.ts
git commit -m "feat(surface): allocate a ticket number on both creation paths"
```

---

## Task 3: Shared types and `GET /agent/conversations/:id`

**Files:**

- Create: `packages/types/src/agent-context.ts`
- Modify: `packages/types/src/index.ts`
- Create: `backend/src/agent/services/conversationContextService.ts`
- Modify: `backend/src/agent/controllers/conversationsController.ts`
- Modify: `backend/src/agent/routers/conversationsRouter.ts:9-13`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.conversationDetail.test.ts`

**Interfaces:**

- Consumes: `conversation.number` (Task 1).
- Produces:
  - `AgentConversationDetail`, `AgentPlayerStateView`, `AgentTicketSummary`, `AgentConversationContextResponse` from `@support/types`.
  - `getConversationDetail(ctx: AgentContext, conversationId: string): Promise<AgentConversationDetail | null>` from `conversationContextService.ts`. `null` means not found or not this workspace — the caller cannot tell the difference, by design.

- [ ] **Step 1: Write the shared types**

Create `packages/types/src/agent-context.ts`. All four types land here now so later tasks import rather than redefine.

```typescript
import type { ConversationStatusValue } from './chat.ts';
import type { DeclaredFieldType } from './player-state.ts';

/** The resolving side. Mirrors the `resolution_source` pg enum. */
export type ResolutionSourceValue = 'bot' | 'agent';

/**
 * The header row for one conversation, fetched by id.
 *
 * This exists because Inbox.tsx finds the selected conversation by searching
 * the `unassigned` and `mine` lists. An older ticket — resolved, owned by
 * another agent — is in neither list and never will be, so opening one by URL
 * yields no header data at all.
 */
export type AgentConversationDetail = {
  id: string;
  number: number;
  player: { id: string; external_player_id: string };
  status: ConversationStatusValue;
  subintent: { intent_name: string; subintent_name: string } | null;
  assigned_agent: { id: string; display_name: string } | null;
  resolution_source: ResolutionSourceValue | null;
  /**
   * The assigned agent's display name when `resolution_source` is 'agent',
   * null otherwise. There is no resolved_by column — this is what the schema
   * knows.
   */
  resolved_by_agent_name: string | null;
  created_at: string;
};

/**
 * Four distinguishable cases, not one nullable object. A single nullable field
 * would collapse "the SDK never delivered a session" and "the game had nothing
 * to say" into one blank panel, and those are different bugs. None of the four
 * is an error: all return 200.
 */
export type AgentPlayerStateView =
  | { status: 'no_session' }
  | { status: 'not_captured' }
  | { status: 'missing' }
  | {
      status: 'captured';
      declared: { key: string; label: string; type: DeclaredFieldType; value: unknown }[];
      /** PII by default. Returned in full, not role-gated; the frontend renders it collapsed. */
      raw: Record<string, unknown>;
      degraded_reason: string | null;
      captured_at: string;
    };

/** One row of the player's ticket history. No message bodies, ever. */
export type AgentTicketSummary = {
  id: string;
  number: number;
  created_at: string;
  status: ConversationStatusValue;
  subintent: { intent_name: string; subintent_name: string } | null;
  resolution_source: ResolutionSourceValue | null;
  resolved_by_agent_name: string | null;
  reopen_count: number;
};

/**
 * The whole context rail in one payload — one endpoint rather than two, because
 * the rail is one thing, always fetched together, and its two halves have the
 * same cache lifetime.
 */
export type AgentConversationContextResponse = {
  player_state: AgentPlayerStateView;
  tickets: AgentTicketSummary[];
  summary: {
    /** Excludes the current conversation. */
    total_tickets: number;
    /** Reopens summed across that same population, not just the returned page. */
    total_reopened: number;
    /** player.first_seen_at, ISO 8601. */
    first_contact_at: string;
  };
};
```

- [ ] **Step 2: Export from the barrel**

Add to `packages/types/src/index.ts`, after the existing lines:

```typescript
export * from './agent-context.ts';
```

- [ ] **Step 3: Write the failing test**

Create `backend/tests/agent.conversationDetail.test.ts`:

```typescript
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedIntent,
  seedPlayer,
  seedSubintent,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

// A standalone app carrying just this router, gated by the real middleware —
// the same pattern agent.conversations.test.ts uses.
const app = express();
app.use(express.json());
app.use(requireAgentSession, conversationsRouter);
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

async function setupAgent(workspaceId: string, displayName = 'Sam Rivera') {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, $2) returning id`,
    [`a-${Math.abs(displayName.length)}-${workspaceId.slice(0, 8)}@example.test`, displayName],
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  );
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
  return { agentId, token };
}

describe('GET /agent/conversations/:id', () => {
  it('returns the header row for a conversation in this workspace', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId, 'player-77');
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toMatchObject({
      id: conversationId,
      number: 1,
      player: { id: playerId, external_player_id: 'player-77' },
      status: 'bot_active',
      subintent: null,
      assigned_agent: null,
      resolution_source: null,
      resolved_by_agent_name: null,
    });
    expect(typeof res.body.created_at).toBe('string');
  });

  it('names the intent and subintent when the conversation is classified', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const intentId = await seedIntent(workspaceId, 'Billing');
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Refund request' });
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set subintent_id = $1 where id = $2`, [
      subintentId,
      conversationId,
    ]);
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.subintent).toEqual({
      intent_name: 'Billing',
      subintent_name: 'Refund request',
    });
  });

  it('names the resolving agent only when resolution_source is agent', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAgent(workspaceId, 'Sam Rivera');
    await ownerPool.query(
      `update conversation set assigned_agent_id = $1, status = 'resolved', resolution_source = 'agent' where id = $2`,
      [agentId, conversationId],
    );

    const res = await request(app)
      .get(`/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.assigned_agent).toEqual({ id: agentId, display_name: 'Sam Rivera' });
    expect(res.body.resolved_by_agent_name).toBe('Sam Rivera');
  });

  it('leaves resolved_by_agent_name null when the bot resolved it', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAgent(workspaceId, 'Sam Rivera');
    await ownerPool.query(
      `update conversation set assigned_agent_id = $1, status = 'resolved', resolution_source = 'bot' where id = $2`,
      [agentId, conversationId],
    );

    const res = await request(app)
      .get(`/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.resolution_source).toBe('bot');
    expect(res.body.resolved_by_agent_name).toBeNull();
  });

  it('returns 404 for a conversation in another workspace', async () => {
    const mine = await seedWorkspace();
    const theirs = await seedWorkspace();
    const theirPlayer = await seedPlayer(theirs);
    const theirConversation = await seedConversation({
      workspaceId: theirs,
      playerId: theirPlayer,
    });
    const { token } = await setupAgent(mine);

    await request(app)
      .get(`/conversations/${theirConversation}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('returns 422 for an id that is not a uuid', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAgent(workspaceId);
    await request(app)
      .get('/conversations/not-a-uuid')
      .set('Authorization', `Bearer ${token}`)
      .expect(422);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd backend && pnpm vitest run tests/agent.conversationDetail.test.ts`
Expected: FAIL — 404 on every case, because no such route is registered.

- [ ] **Step 5: Write the service**

Create `backend/src/agent/services/conversationContextService.ts`:

```typescript
import { eq } from 'drizzle-orm';
import type { AgentConversationDetail } from '@support/types';
import { agent, conversation, intent, player, subintent } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';

/**
 * One conversation's header row, by id.
 *
 * `null` covers both "no such conversation" and "not this workspace" — RLS
 * makes the two indistinguishable, which is the point. The controller turns it
 * into a 404 either way.
 */
export async function getConversationDetail(
  ctx: AgentContext,
  conversationId: string,
): Promise<AgentConversationDetail | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .select({
        id: conversation.id,
        number: conversation.number,
        status: conversation.status,
        resolutionSource: conversation.resolutionSource,
        createdAt: conversation.createdAt,
        playerId: player.id,
        externalPlayerId: player.externalId,
        intentName: intent.name,
        subintentName: subintent.name,
        assignedAgentId: agent.id,
        assignedAgentName: agent.displayName,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(subintent, eq(subintent.id, conversation.subintentId))
      .leftJoin(intent, eq(intent.id, subintent.intentId))
      .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
      .where(eq(conversation.id, conversationId))
      .limit(1);

    if (!row) return null;

    return {
      id: row.id,
      number: row.number,
      player: { id: row.playerId, external_player_id: row.externalPlayerId },
      status: row.status,
      subintent:
        row.subintentName && row.intentName
          ? { intent_name: row.intentName, subintent_name: row.subintentName }
          : null,
      assigned_agent:
        row.assignedAgentId && row.assignedAgentName
          ? { id: row.assignedAgentId, display_name: row.assignedAgentName }
          : null,
      resolution_source: row.resolutionSource,
      // There is no resolved_by column. The assigned agent is who resolved it
      // when the source says an agent did; a bot resolution names nobody.
      resolved_by_agent_name: row.resolutionSource === 'agent' ? row.assignedAgentName : null,
      created_at: row.createdAt.toISOString(),
    };
  });
}
```

`agent` and `intent`/`subintent` must be exported from `backend/src/shared/db/schema/index.ts` — confirm before importing, and add the re-export if either is missing.

- [ ] **Step 6: Write the controller handler**

Add to `backend/src/agent/controllers/conversationsController.ts`. Extend the existing import from the services directory with a new line — do not touch the `conversationsService.ts` import:

```typescript
import { getConversationDetail } from '../services/conversationContextService.ts';
```

Append the handler at the end of the file. It reuses the file's existing `ConversationIdParams` schema (line 11):

```typescript
export const getConversationDetailHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const params = ConversationIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const detail = await getConversationDetail(ctx, params.data.id);
  if (!detail) {
    sendError(res, 404, 'not_found', 'Conversation not found.');
    return;
  }
  res.status(200).json(detail);
};
```

- [ ] **Step 7: Register the route**

In `backend/src/agent/routers/conversationsRouter.ts`, add `getConversationDetailHandler` to the import list and register the route. Order matters: `/conversations/:id` must come **after** `/conversations`, and Express will not confuse it with `/conversations/:id/messages`, but keep the detail route adjacent to its siblings for readability.

```typescript
import { Router } from 'express';
import {
  askResolvedHandler,
  claimConversationHandler,
  getConversationDetailHandler,
  getConversationMessagesHandler,
  listConversationsHandler,
} from '../controllers/conversationsController.ts';

export const conversationsRouter = Router();
conversationsRouter.get('/conversations', listConversationsHandler);
conversationsRouter.get('/conversations/:id', getConversationDetailHandler);
conversationsRouter.post('/conversations/:id/claim', claimConversationHandler);
conversationsRouter.get('/conversations/:id/messages', getConversationMessagesHandler);
conversationsRouter.post('/conversations/:id/ask-resolved', askResolvedHandler);
```

- [ ] **Step 8: Register in the OpenAPI document**

In `backend/src/docs/openapi.ts`, add after the existing `/agent/conversations` registration (around line 430). Define the response schema alongside, following the file's existing style:

```typescript
const AgentSubintentSchema = z
  .object({ intent_name: z.string(), subintent_name: z.string() })
  .nullable();

const AgentConversationDetailSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  player: z.object({ id: z.uuid(), external_player_id: z.string() }),
  status: z.enum([
    'new',
    'bot_active',
    'open',
    'awaiting_player',
    'escalated',
    'resolved',
    'closed',
  ]),
  subintent: AgentSubintentSchema,
  assigned_agent: z.object({ id: z.uuid(), display_name: z.string() }).nullable(),
  resolution_source: z.enum(['bot', 'agent']).nullable(),
  resolved_by_agent_name: z.string().nullable(),
  created_at: z.string(),
});

registry.registerPath({
  method: 'get',
  path: '/agent/conversations/{id}',
  summary: 'Agent Get Conversation',
  description:
    'One conversation header row by id. Serves tickets that are in neither the unassigned nor the mine list — resolved, or owned by another agent — which the inbox lists can never supply.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: {
      description: 'Conversation header',
      content: { 'application/json': { schema: AgentConversationDetailSchema } },
    },
    404: { description: 'Not found, or not in this workspace' },
  },
});
```

`AgentSubintentSchema` is reused by Task 6 — leave it at module scope.

- [ ] **Step 9: Run the tests and typecheck**

Run: `cd backend && pnpm vitest run tests/agent.conversationDetail.test.ts`
Expected: PASS, all six cases.

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/types/src/agent-context.ts \
        packages/types/src/index.ts \
        backend/src/agent/services/conversationContextService.ts \
        backend/src/agent/controllers/conversationsController.ts \
        backend/src/agent/routers/conversationsRouter.ts \
        backend/src/docs/openapi.ts \
        backend/tests/agent.conversationDetail.test.ts
git commit -m "feat(agent): GET /agent/conversations/:id header endpoint"
```

---

## Task 4: The player-state reader

**Files:**

- Modify: `backend/src/agent/services/conversationContextService.ts`
- Test: `backend/tests/agent.conversationContext.test.ts` (created here, extended in Task 6)

**Interfaces:**

- Consumes: `withWorkspace`, `AgentPlayerStateView` from Task 3.
- Produces: `getPlayerStateView(tx: Tx, workspaceId: string, sessionId: string | null): Promise<AgentPlayerStateView>` — **not exported from the module's public surface**, but exported for the test. Takes an open `tx` so Task 6 can call it inside the context endpoint's single transaction.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/agent.conversationContext.test.ts`. This file grows in Task 6; the shared harness goes in now.

```typescript
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { getPlayerStateView } from '../src/agent/services/conversationContextService.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedDeclaredFields,
  seedPlayer,
  seedSession,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function seedSnapshot(args: {
  workspaceId: string;
  sessionId: string;
  declared?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  isMissing?: boolean;
  degradedReason?: string | null;
  capturedAt?: Date;
}): Promise<void> {
  await ownerPool.query(
    `insert into player_state_snapshot (id, workspace_id, session_id, declared, raw, is_missing, degraded_reason, captured_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      args.workspaceId,
      args.sessionId,
      JSON.stringify(args.declared ?? {}),
      JSON.stringify(args.raw ?? {}),
      args.isMissing ?? false,
      args.degradedReason ?? null,
      args.capturedAt ?? new Date('2026-08-17T10:00:00Z'),
    ],
  );
}

describe('getPlayerStateView', () => {
  it('reports no_session when the conversation carries no session', async () => {
    const workspaceId = await seedWorkspace();
    const view = await withWorkspace(workspaceId, (tx) =>
      getPlayerStateView(tx, workspaceId, null),
    );
    expect(view).toEqual({ status: 'no_session' });
  });

  it('reports not_captured when the session exists but wrote no snapshot', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const sessionId = await seedSession({ workspaceId, playerId });
    const view = await withWorkspace(workspaceId, (tx) =>
      getPlayerStateView(tx, workspaceId, sessionId),
    );
    expect(view).toEqual({ status: 'not_captured' });
  });

  it('reports missing when the snapshot says the provider returned nothing usable', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const sessionId = await seedSession({ workspaceId, playerId });
    await seedSnapshot({ workspaceId, sessionId, isMissing: true });
    const view = await withWorkspace(workspaceId, (tx) =>
      getPlayerStateView(tx, workspaceId, sessionId),
    );
    expect(view).toEqual({ status: 'missing' });
  });

  it('labels and orders declared fields by joining declared_field', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const sessionId = await seedSession({ workspaceId, playerId });
    await seedDeclaredFields(workspaceId, ['player_level', 'platform']);
    await seedSnapshot({
      workspaceId,
      sessionId,
      declared: { platform: 'ios', player_level: 42 },
      raw: { fps: 58 },
    });

    const view = await withWorkspace(workspaceId, (tx) =>
      getPlayerStateView(tx, workspaceId, sessionId),
    );
    if (view.status !== 'captured') throw new Error(`expected captured, got ${view.status}`);

    // seedDeclaredFields inserts in the order given, so declared_at ascending
    // is player_level then platform.
    expect(view.declared.map((f) => f.key)).toEqual(['player_level', 'platform']);
    expect(view.declared[0]).toEqual({
      key: 'player_level',
      label: 'player_level',
      type: 'string',
      value: 42,
    });
    expect(view.raw).toEqual({ fps: 58 });
    expect(view.degraded_reason).toBeNull();
    expect(view.captured_at).toBe('2026-08-17T10:00:00.000Z');
  });

  it('appends a declared key with no declared_field row rather than dropping it', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const sessionId = await seedSession({ workspaceId, playerId });
    await seedDeclaredFields(workspaceId, ['platform']);
    await seedSnapshot({
      workspaceId,
      sessionId,
      declared: { orphan_key: 'x', platform: 'android' },
    });

    const view = await withWorkspace(workspaceId, (tx) =>
      getPlayerStateView(tx, workspaceId, sessionId),
    );
    if (view.status !== 'captured') throw new Error(`expected captured, got ${view.status}`);

    expect(view.declared.map((f) => f.key)).toEqual(['platform', 'orphan_key']);
    expect(view.declared[1]).toEqual({
      key: 'orphan_key',
      label: 'orphan_key',
      type: 'string',
      value: 'x',
    });
  });

  it('surfaces degraded_reason on a captured snapshot', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const sessionId = await seedSession({ workspaceId, playerId });
    await seedSnapshot({ workspaceId, sessionId, degradedReason: 'provider threw on total_spend' });

    const view = await withWorkspace(workspaceId, (tx) =>
      getPlayerStateView(tx, workspaceId, sessionId),
    );
    if (view.status !== 'captured') throw new Error(`expected captured, got ${view.status}`);
    expect(view.degraded_reason).toBe('provider threw on total_spend');
  });

  it('does not fall back to another session snapshot', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const thisSession = await seedSession({
      workspaceId,
      playerId,
      startedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const laterSession = await seedSession({
      workspaceId,
      playerId,
      startedAt: new Date('2026-06-01T00:00:00Z'),
    });
    await seedSnapshot({ workspaceId, sessionId: laterSession, declared: { player_level: 99 } });

    const view = await withWorkspace(workspaceId, (tx) =>
      getPlayerStateView(tx, workspaceId, thisSession),
    );
    expect(view).toEqual({ status: 'not_captured' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && pnpm vitest run tests/agent.conversationContext.test.ts`
Expected: FAIL — `getPlayerStateView is not a function`.

- [ ] **Step 3: Implement `getPlayerStateView`**

Append to `backend/src/agent/services/conversationContextService.ts`. Extend the existing imports:

```typescript
import { and, asc, eq } from 'drizzle-orm';
import type { AgentConversationDetail, AgentPlayerStateView } from '@support/types';
import {
  agent,
  conversation,
  declaredField,
  intent,
  player,
  playerStateSnapshot,
  subintent,
} from '../../shared/db/schema/index.ts';
import type { Tx } from '../../shared/db/withWorkspace.ts';
```

Then:

```typescript
/**
 * The rail's player-state panel, as a tagged union rather than one nullable
 * object. Four cases, all 200: missing player state is a state, not an error.
 *
 * No fallback to a later snapshot. When this conversation's session captured
 * nothing, the response says so and carries nothing else — synthesising state
 * from a different session would manufacture exactly the misleading
 * current-level number the product spec rejects, and a label under a number
 * does not stop anyone reading the number.
 *
 * Takes an open tx so the context endpoint reads everything in one transaction.
 */
export async function getPlayerStateView(
  tx: Tx,
  workspaceId: string,
  sessionId: string | null,
): Promise<AgentPlayerStateView> {
  if (!sessionId) return { status: 'no_session' };

  const [snapshot] = await tx
    .select({
      declared: playerStateSnapshot.declared,
      raw: playerStateSnapshot.raw,
      isMissing: playerStateSnapshot.isMissing,
      degradedReason: playerStateSnapshot.degradedReason,
      capturedAt: playerStateSnapshot.capturedAt,
    })
    .from(playerStateSnapshot)
    .where(eq(playerStateSnapshot.sessionId, sessionId))
    .limit(1);

  if (!snapshot) return { status: 'not_captured' };
  if (snapshot.isMissing) return { status: 'missing' };

  // Ordered by when the field was declared, so the seed order the game sees in
  // its own config is the order the agent reads down the panel.
  const fields = await tx
    .select({ key: declaredField.key, label: declaredField.label, type: declaredField.type })
    .from(declaredField)
    .where(eq(declaredField.workspaceId, workspaceId))
    .orderBy(asc(declaredField.declaredAt), asc(declaredField.key));

  const blob = snapshot.declared;
  const declared: {
    key: string;
    label: string;
    type: (typeof fields)[number]['type'];
    value: unknown;
  }[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (!(field.key in blob)) continue;
    seen.add(field.key);
    declared.push({ key: field.key, label: field.label, type: field.type, value: blob[field.key] });
  }
  // A key in the blob with no declared_field row cannot normally occur —
  // nothing is ever deleted — but appending beats dropping: a value the agent
  // can see is worth more than a tidy list.
  for (const key of Object.keys(blob)) {
    if (seen.has(key)) continue;
    declared.push({ key, label: key, type: 'string', value: blob[key] });
  }

  return {
    status: 'captured',
    declared,
    raw: snapshot.raw,
    degraded_reason: snapshot.degradedReason,
    captured_at: snapshot.capturedAt.toISOString(),
  };
}
```

Confirm `declaredField` and `playerStateSnapshot` are exported from `backend/src/shared/db/schema/index.ts`; `bootstrapService.ts` already imports `playerStateSnapshot`, so follow whatever path it uses.

- [ ] **Step 4: Run the tests**

Run: `cd backend && pnpm vitest run tests/agent.conversationContext.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/services/conversationContextService.ts \
        backend/tests/agent.conversationContext.test.ts
git commit -m "feat(agent): tagged-union player state reader for the context rail"
```

---

## Task 5: The ticket-history reader

**Files:**

- Modify: `backend/src/agent/services/conversationContextService.ts`
- Test: `backend/tests/agent.conversationContext.test.ts` (append)

**Interfaces:**

- Consumes: `AgentTicketSummary` from Task 3, `conversation.number` from Task 1.
- Produces: `getTicketHistory(tx: Tx, args: { playerId: string; excludeConversationId: string }): Promise<{ tickets: AgentTicketSummary[]; totalTickets: number; totalReopened: number }>`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/agent.conversationContext.test.ts`. Extend the file's imports:

```typescript
import { getTicketHistory } from '../src/agent/services/conversationContextService.ts';
import { seedConversation, seedIntent, seedSubintent } from './helpers/db.ts';
```

Then append:

```typescript
async function seedReopen(
  workspaceId: string,
  conversationId: string,
  times: number,
): Promise<void> {
  for (let i = 0; i < times; i++) {
    await ownerPool.query(
      `insert into event (workspace_id, type, conversation_id, actor_type) values ($1, 'conversation_reopened', $2, 'player')`,
      [workspaceId, conversationId],
    );
  }
}

describe('getTicketHistory', () => {
  it('excludes the current conversation and orders newest first', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const older = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const newer = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    const current = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-03-01T00:00:00Z'),
    });

    const result = await withWorkspace(workspaceId, (tx) =>
      getTicketHistory(tx, { playerId, excludeConversationId: current }),
    );

    expect(result.tickets.map((t) => t.id)).toEqual([newer, older]);
    expect(result.totalTickets).toBe(2);
  });

  it('numbers each ticket and carries its status', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const first = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const current = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    await ownerPool.query(`update conversation set status = 'closed' where id = $1`, [first]);

    const result = await withWorkspace(workspaceId, (tx) =>
      getTicketHistory(tx, { playerId, excludeConversationId: current }),
    );

    expect(result.tickets[0]).toMatchObject({ id: first, number: 1, status: 'closed' });
    expect(typeof result.tickets[0]!.created_at).toBe('string');
  });

  it('counts reopen events per ticket and totals them', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const a = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const b = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    const current = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-03-01T00:00:00Z'),
    });
    await seedReopen(workspaceId, a, 2);
    await seedReopen(workspaceId, b, 1);
    await seedReopen(workspaceId, current, 5); // the current one never counts

    const result = await withWorkspace(workspaceId, (tx) =>
      getTicketHistory(tx, { playerId, excludeConversationId: current }),
    );

    const byId = new Map(result.tickets.map((t) => [t.id, t.reopen_count]));
    expect(byId.get(a)).toBe(2);
    expect(byId.get(b)).toBe(1);
    expect(result.totalReopened).toBe(3);
  });

  it('reports zero reopens for a ticket with no events', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const a = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const current = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });

    const result = await withWorkspace(workspaceId, (tx) =>
      getTicketHistory(tx, { playerId, excludeConversationId: current }),
    );

    expect(result.tickets.find((t) => t.id === a)!.reopen_count).toBe(0);
    expect(result.totalReopened).toBe(0);
  });

  it('caps the list at 20 while total_tickets holds the true count', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    for (let i = 0; i < 25; i++) {
      await seedConversation({
        workspaceId,
        playerId,
        createdAt: new Date(Date.UTC(2026, 0, i + 1)),
      });
    }
    const current = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-06-01T00:00:00Z'),
    });

    const result = await withWorkspace(workspaceId, (tx) =>
      getTicketHistory(tx, { playerId, excludeConversationId: current }),
    );

    expect(result.tickets).toHaveLength(20);
    expect(result.totalTickets).toBe(25);
    // Newest first, so the newest of the 25 is number 25.
    expect(result.tickets[0]!.number).toBe(25);
  });

  it('names the intent and subintent when a past ticket was classified', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const intentId = await seedIntent(workspaceId, 'Account');
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Lost progress' });
    const past = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const current = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    await ownerPool.query(`update conversation set subintent_id = $1 where id = $2`, [
      subintentId,
      past,
    ]);

    const result = await withWorkspace(workspaceId, (tx) =>
      getTicketHistory(tx, { playerId, excludeConversationId: current }),
    );

    expect(result.tickets[0]!.subintent).toEqual({
      intent_name: 'Account',
      subintent_name: 'Lost progress',
    });
  });

  it('does not reach across workspaces', async () => {
    const wsA = await seedWorkspace();
    const wsB = await seedWorkspace();
    const playerA = await seedPlayer(wsA, 'shared-external-id');
    const playerB = await seedPlayer(wsB, 'shared-external-id');
    await seedConversation({
      workspaceId: wsB,
      playerId: playerB,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const current = await seedConversation({ workspaceId: wsA, playerId: playerA });

    const result = await withWorkspace(wsA, (tx) =>
      getTicketHistory(tx, { playerId: playerA, excludeConversationId: current }),
    );

    expect(result.tickets).toEqual([]);
    expect(result.totalTickets).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && pnpm vitest run tests/agent.conversationContext.test.ts -t getTicketHistory`
Expected: FAIL — `getTicketHistory is not a function`.

- [ ] **Step 3: Implement `getTicketHistory`**

Append to `backend/src/agent/services/conversationContextService.ts`. Extend the imports with `desc`, `ne`, `sql`, `count` from `drizzle-orm`, `event` from the schema barrel, and `AgentTicketSummary` from `@support/types`.

```typescript
const TICKET_CAP = 20;

export type TicketHistory = {
  tickets: AgentTicketSummary[];
  totalTickets: number;
  totalReopened: number;
};

/**
 * This player's other conversations in this workspace, newest first, capped at
 * 20 with the true count alongside.
 *
 * Two queries regardless of ticket count. listConversations() runs one preview
 * query per row and says so in a comment; this does not repeat that. The total
 * rides along on the first query as a window count — Postgres computes window
 * functions before LIMIT, so it counts the whole population, not the page.
 *
 * The message table is never touched, so there is no path by which an internal
 * note reaches this response. toAgentView is not involved.
 */
export async function getTicketHistory(
  tx: Tx,
  args: { playerId: string; excludeConversationId: string },
): Promise<TicketHistory> {
  const rows = await tx
    .select({
      id: conversation.id,
      number: conversation.number,
      createdAt: conversation.createdAt,
      status: conversation.status,
      resolutionSource: conversation.resolutionSource,
      intentName: intent.name,
      subintentName: subintent.name,
      assignedAgentName: agent.displayName,
      totalCount: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(conversation)
    .leftJoin(subintent, eq(subintent.id, conversation.subintentId))
    .leftJoin(intent, eq(intent.id, subintent.intentId))
    .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
    .where(
      and(
        eq(conversation.playerId, args.playerId),
        ne(conversation.id, args.excludeConversationId),
      ),
    )
    .orderBy(desc(conversation.createdAt))
    .limit(TICKET_CAP);

  // Grouped over the player's whole other-ticket population, not just the
  // capped page — summary.total_reopened has to describe the same set that
  // summary.total_tickets counts.
  const reopens = await tx
    .select({ conversationId: event.conversationId, reopens: count() })
    .from(event)
    .innerJoin(conversation, eq(conversation.id, event.conversationId))
    .where(
      and(
        eq(event.type, 'conversation_reopened'),
        eq(conversation.playerId, args.playerId),
        ne(conversation.id, args.excludeConversationId),
      ),
    )
    .groupBy(event.conversationId);

  const reopenById = new Map<string, number>();
  let totalReopened = 0;
  for (const row of reopens) {
    if (!row.conversationId) continue;
    reopenById.set(row.conversationId, row.reopens);
    totalReopened += row.reopens;
  }

  const tickets: AgentTicketSummary[] = rows.map((row) => ({
    id: row.id,
    number: row.number,
    created_at: row.createdAt.toISOString(),
    status: row.status,
    subintent:
      row.subintentName && row.intentName
        ? { intent_name: row.intentName, subintent_name: row.subintentName }
        : null,
    resolution_source: row.resolutionSource,
    resolved_by_agent_name: row.resolutionSource === 'agent' ? row.assignedAgentName : null,
    reopen_count: reopenById.get(row.id) ?? 0,
  }));

  return { tickets, totalTickets: rows[0]?.totalCount ?? 0, totalReopened };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && pnpm vitest run tests/agent.conversationContext.test.ts`
Expected: PASS — the seven `getPlayerStateView` cases and the seven `getTicketHistory` cases.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/services/conversationContextService.ts \
        backend/tests/agent.conversationContext.test.ts
git commit -m "feat(agent): ticket history reader with per-ticket reopen counts"
```

---

## Task 6: Wire `GET /agent/conversations/:id/context`

**Files:**

- Modify: `backend/src/agent/services/conversationContextService.ts`
- Modify: `backend/src/agent/controllers/conversationsController.ts`
- Modify: `backend/src/agent/routers/conversationsRouter.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.conversationContext.test.ts` (append an HTTP describe)

**Interfaces:**

- Consumes: `getPlayerStateView` (Task 4), `getTicketHistory` (Task 5), `AgentConversationContextResponse` (Task 3).
- Produces: `getConversationContext(ctx: AgentContext, conversationId: string): Promise<AgentConversationContextResponse | null>`, and the route `GET /agent/conversations/:id/context`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/agent.conversationContext.test.ts`. Extend the imports with the standalone-app harness — the same shape `agent.conversationDetail.test.ts` uses:

```typescript
import { createServer } from 'node:http';
import express from 'express';
import { beforeAll } from 'vitest';
import { req as request } from './helpers/http.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts';
```

Add the app and lifecycle at module scope, and widen the existing `afterAll`:

```typescript
const app = express();
app.use(express.json());
app.use(requireAgentSession, conversationsRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeDb();
  await closeOwnerPool();
});

async function setupAgent(workspaceId: string) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Agent One') returning id`,
    [`a-${workspaceId.slice(0, 8)}@example.test`],
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  );
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
  return { agentId, token };
}
```

Then append:

```typescript
describe('GET /agent/conversations/:id/context', () => {
  it('returns player state, tickets and summary in one payload', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    await ownerPool.query(`update player set first_seen_at = $1 where id = $2`, [
      new Date('2025-11-02T08:30:00Z'),
      playerId,
    ]);
    const sessionId = await seedSession({ workspaceId, playerId });
    await seedDeclaredFields(workspaceId, ['player_level']);
    await seedSnapshot({
      workspaceId,
      sessionId,
      declared: { player_level: 42 },
      raw: { fps: 58 },
    });

    const past = await seedConversation({
      workspaceId,
      playerId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await seedReopen(workspaceId, past, 2);
    const current = await seedConversation({
      workspaceId,
      playerId,
      sessionId,
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${current}/context`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.player_state.status).toBe('captured');
    expect(res.body.player_state.declared[0]).toMatchObject({ key: 'player_level', value: 42 });
    expect(res.body.player_state.raw).toEqual({ fps: 58 });
    expect(res.body.tickets).toHaveLength(1);
    expect(res.body.tickets[0]).toMatchObject({ id: past, reopen_count: 2 });
    expect(res.body.summary).toEqual({
      total_tickets: 1,
      total_reopened: 2,
      first_contact_at: '2025-11-02T08:30:00.000Z',
    });
  });

  it('returns 200 with no_session when the conversation has no session', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const current = await seedConversation({ workspaceId, playerId });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${current}/context`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.player_state).toEqual({ status: 'no_session' });
    expect(res.body.tickets).toEqual([]);
    expect(res.body.summary.total_tickets).toBe(0);
  });

  it('returns 200 with missing when the provider returned nothing usable', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const sessionId = await seedSession({ workspaceId, playerId });
    await seedSnapshot({ workspaceId, sessionId, isMissing: true });
    const current = await seedConversation({ workspaceId, playerId, sessionId });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${current}/context`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.player_state).toEqual({ status: 'missing' });
  });

  it('returns 200 with not_captured when the session wrote no snapshot', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const sessionId = await seedSession({ workspaceId, playerId });
    const current = await seedConversation({ workspaceId, playerId, sessionId });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${current}/context`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.player_state).toEqual({ status: 'not_captured' });
  });

  it('returns 404 for a conversation in another workspace', async () => {
    const mine = await seedWorkspace();
    const theirs = await seedWorkspace();
    const theirPlayer = await seedPlayer(theirs);
    const theirConversation = await seedConversation({
      workspaceId: theirs,
      playerId: theirPlayer,
    });
    const { token } = await setupAgent(mine);

    await request(app)
      .get(`/conversations/${theirConversation}/context`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('returns 422 for an id that is not a uuid', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAgent(workspaceId);
    await request(app)
      .get('/conversations/not-a-uuid/context')
      .set('Authorization', `Bearer ${token}`)
      .expect(422);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && pnpm vitest run tests/agent.conversationContext.test.ts -t "context"`
Expected: FAIL — 404 on every case, because no such route is registered.

- [ ] **Step 3: Implement `getConversationContext`**

Append to `backend/src/agent/services/conversationContextService.ts`. Add `AgentConversationContextResponse` to the `@support/types` import.

```typescript
/**
 * The whole rail in one payload. One endpoint rather than two, because the rail
 * is one thing, always fetched together, and its two halves have the same cache
 * lifetime.
 *
 * `null` is not found or not this workspace — RLS makes those indistinguishable
 * and the controller returns 404 for both.
 */
export async function getConversationContext(
  ctx: AgentContext,
  conversationId: string,
): Promise<AgentConversationContextResponse | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({
        sessionId: conversation.sessionId,
        playerId: player.id,
        firstSeenAt: player.firstSeenAt,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .where(eq(conversation.id, conversationId))
      .limit(1);

    if (!current) return null;

    const playerState = await getPlayerStateView(tx, ctx.workspaceId, current.sessionId);
    const history = await getTicketHistory(tx, {
      playerId: current.playerId,
      excludeConversationId: conversationId,
    });

    return {
      player_state: playerState,
      tickets: history.tickets,
      summary: {
        total_tickets: history.totalTickets,
        total_reopened: history.totalReopened,
        first_contact_at: current.firstSeenAt.toISOString(),
      },
    };
  });
}
```

- [ ] **Step 4: Write the controller handler**

Add `getConversationContext` to the existing `conversationContextService.ts` import in `backend/src/agent/controllers/conversationsController.ts`, then append:

```typescript
export const getConversationContextHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const params = ConversationIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const context = await getConversationContext(ctx, params.data.id);
  if (!context) {
    sendError(res, 404, 'not_found', 'Conversation not found.');
    return;
  }
  // All four player_state branches are 200. Missing player state is a state,
  // not an error — never reject a conversation because of it.
  res.status(200).json(context);
};
```

- [ ] **Step 5: Register the route**

In `backend/src/agent/routers/conversationsRouter.ts`, add `getConversationContextHandler` to the import list and register it alongside the other `:id` routes:

```typescript
conversationsRouter.get('/conversations/:id/context', getConversationContextHandler);
```

- [ ] **Step 6: Register in the OpenAPI document**

In `backend/src/docs/openapi.ts`, add after the `/agent/conversations/{id}` registration from Task 3. `AgentSubintentSchema` is already defined there — reuse it.

```typescript
const AgentPlayerStateSchema = z.union([
  z.object({ status: z.literal('no_session') }),
  z.object({ status: z.literal('not_captured') }),
  z.object({ status: z.literal('missing') }),
  z.object({
    status: z.literal('captured'),
    declared: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        type: z.enum(['string', 'number', 'boolean', 'timestamp']),
        value: z.unknown(),
      }),
    ),
    raw: z.record(z.string(), z.unknown()),
    degraded_reason: z.string().nullable(),
    captured_at: z.string(),
  }),
]);

const AgentTicketSummarySchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  created_at: z.string(),
  status: z.enum([
    'new',
    'bot_active',
    'open',
    'awaiting_player',
    'escalated',
    'resolved',
    'closed',
  ]),
  subintent: AgentSubintentSchema,
  resolution_source: z.enum(['bot', 'agent']).nullable(),
  resolved_by_agent_name: z.string().nullable(),
  reopen_count: z.number().int(),
});

registry.registerPath({
  method: 'get',
  path: '/agent/conversations/{id}/context',
  summary: 'Agent Conversation Context',
  description:
    "The context rail in one payload: the player-state snapshot captured when this ticket was raised, the player's other tickets in this workspace (newest first, capped at 20), and totals. All four player_state cases return 200 — missing player state is a state, not an error. `raw` is PII and is returned in full, uncollapsed by the API.",
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: {
      description: 'Context rail payload',
      content: {
        'application/json': {
          schema: z.object({
            player_state: AgentPlayerStateSchema,
            tickets: z.array(AgentTicketSummarySchema),
            summary: z.object({
              total_tickets: z.number().int(),
              total_reopened: z.number().int(),
              first_contact_at: z.string(),
            }),
          }),
        },
      },
    },
    404: { description: 'Not found, or not in this workspace' },
  },
});
```

- [ ] **Step 7: Run the tests**

Run: `cd backend && pnpm vitest run tests/agent.conversationContext.test.ts tests/agent.conversationDetail.test.ts`
Expected: PASS on both files.

- [ ] **Step 8: Verify the Swagger document builds**

Run: `cd backend && pnpm dev` in one shell, then in another: `curl -s localhost:4000/docs/json | grep -c "conversations/{id}/context"`
Expected: a non-zero count. Stop the dev server.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. If any pre-existing suite fails on the `number` column, it inserts a conversation through a path Task 1 Step 8 missed — fix it there rather than defaulting the column.

- [ ] **Step 10: Commit**

```bash
git add backend/src/agent/services/conversationContextService.ts \
        backend/src/agent/controllers/conversationsController.ts \
        backend/src/agent/routers/conversationsRouter.ts \
        backend/src/docs/openapi.ts \
        backend/tests/agent.conversationContext.test.ts
git commit -m "feat(agent): GET /agent/conversations/:id/context for the context rail"
```

---

## Spec coverage

| Spec requirement                                            | Task       |
| ----------------------------------------------------------- | ---------- |
| `workspace.ticket_seq`                                      | 1          |
| `conversation.number` + unique per `(workspace_id, number)` | 1          |
| Five-step migration order, backfill by `created_at`         | 1          |
| Backfill leaves `ticket_seq` at each workspace max          | 1          |
| Allocated inside the conversation-insert transaction        | 2          |
| Both creation paths allocate                                | 2          |
| Two workspaces number independently from 1                  | 2          |
| `GET /agent/conversations/:id` header row                   | 3          |
| Cross-workspace `:id` → 404 on both endpoints               | 3, 6       |
| Four `player_state` branches, each 200                      | 4, 6       |
| `declared` ordered and labelled; orphan keys appended       | 4          |
| `raw` returned in full, not role-gated, no event written    | 4          |
| `degraded_reason` on a captured response                    | 4          |
| No fallback to a later snapshot                             | 4          |
| `tickets` exclude the current conversation, newest first    | 5          |
| Cap at 20 with the true `total_tickets`                     | 5          |
| `reopen_count` per ticket                                   | 5          |
| Two queries regardless of ticket count                      | 5          |
| No message bodies; `message` table never touched            | 5          |
| Outcome facts only — no composed labels                     | 3, 5       |
| No cross-workspace player history                           | 5          |
| `GET /agent/conversations/:id/context` single payload       | 6          |
| `summary.first_contact_at` from `player.first_seen_at`      | 6          |
| Both routes in `openapi.ts`                                 | 3, 6       |
| Everything inside `withWorkspace`                           | 3, 4, 5, 6 |

Out of scope, per the spec, and absent from every task: custom fields, compensation tracking, filtering over the `declared` GIN index, cross-workspace history.
