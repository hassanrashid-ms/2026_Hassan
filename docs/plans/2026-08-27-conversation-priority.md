# Conversation Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `conversation.priority` actually vary instead of being permanently stuck at `p3` — automatically from subintent classification, and manually via an agent-facing control — so the queue's existing `ORDER BY priority` has something real to sort.

**Architecture:** One new boolean column (`priority_manually_set`) breaks the tie between "still default" and "an agent chose this." One new shared helper (`applySubintentDefaultPriority`) is called from both places a conversation's subintent gets written (bot's `classifyIfUnset`, agent's `reclassifyConversation`), applying the subintent's `default_priority` unless a manual edit already happened. One new mutation (`setConversationPriority`) plus its route/endpoint lets an agent override priority directly, marking it manual. Frontend gets a `PriorityPicker` popover mirroring the existing `SubintentPicker`/`AssignPicker`, wired into `ThreadPanel`'s header.

**Tech Stack:** Express 5 + TypeScript + Zod, Drizzle ORM + drizzle-kit migrations, PostgreSQL, Vitest + supertest-style `req()` helper for backend tests, React + TanStack Query + shadcn/ui (Popover/Command) for frontend.

## Global Constraints

- Every conversation mutation runs inside `withWorkspace(ctx.workspaceId, async (tx) => {...})` and pairs its `UPDATE conversation` with an `appendEvent(tx, {...})` in the same transaction — never insert into `event` directly.
- Manual priority edits are also change-logged via `appendChangeLog`, matching `reclassifyConversation`.
- **Manual always wins**: once `conversation.priority_manually_set = true`, no auto-classification path may overwrite `priority` again.
- Skip the update and event entirely (no-op) when the computed new priority equals the current value — no `p3 → p3` event noise.
- New route `PATCH /agent/conversations/:id/priority` is open to any authenticated agent — `requireAgentSession` only, no team-lead/admin gate (same as `/subintent`, unlike `/assign`).
- Register every new route + Zod schema in `backend/src/docs/openapi.ts`.
- No hard deletes, no silent overwrites — this plan adds one column and one event type (`conversation_priority_changed`), never removes or retypes anything (SDK/event-type freeze rules from `CLAUDE.md`).

---

### Task 1: Schema — add `priority_manually_set` column

**Files:**

- Modify: `backend/src/shared/db/schema/conversations.ts:50` (right after the `priority` field)
- Generate: a new migration file under `backend/src/shared/db/migrations/` (via `pnpm db:generate`)

**Interfaces:**

- Produces: `conversation.priorityManuallySet: boolean`, not null, default `false` — consumed by Tasks 3, 5, 6, and the `seedConversation` test helper (Task 2).

- [ ] **Step 1: Add the column to the schema**

In `backend/src/shared/db/schema/conversations.ts`, immediately after line 50 (`priority: conversationPriority('priority').notNull().default('p3'),`), add:

```ts
    /** True once an agent has explicitly set priority via PATCH .../priority.
     *  Sticky: no auto-classification path may overwrite priority after this
     *  flips true. See docs/specs/2026-08-27-conversation-priority-design.md. */
    priorityManuallySet: boolean('priority_manually_set').notNull().default(false),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new SQL file appears under `backend/src/shared/db/migrations/` adding the `priority_manually_set` column (`ALTER TABLE "conversation" ADD COLUMN "priority_manually_set" boolean DEFAULT false NOT NULL;` or equivalent). Confirm no other unrelated diffs got picked up — if drizzle-kit reports changes to unrelated tables, stop and investigate before continuing (do not blindly accept an unrelated diff).

- [ ] **Step 3: Apply the migration**

Run: `pnpm db:setup`
Expected: exits 0. This is idempotent and safe to re-run.

- [ ] **Step 4: Commit**

```bash
git add backend/src/shared/db/schema/conversations.ts backend/src/shared/db/migrations/
git commit -m "schema: add conversation.priority_manually_set"
```

---

### Task 2: Test helpers — support seeding priority state

**Files:**

- Modify: `backend/tests/helpers/db.ts:157-197` (`seedConversation`)
- Modify: `backend/tests/helpers/db.ts:255-268` (`seedSubintent`)

**Interfaces:**

- Consumes: `conversation.priorityManuallySet` (Task 1).
- Produces: `seedConversation(args)` accepts an optional `priorityManuallySet?: boolean`; `seedSubintent(args)` accepts an optional `defaultPriority?: 'p1'|'p2'|'p3'|'p4'`. Both are consumed by every test written in Tasks 3, 4, 5, 6.

- [ ] **Step 1: Extend `seedConversation`**

In `backend/tests/helpers/db.ts`, change the `seedConversation` args type (line 157-168) to add `priorityManuallySet?: boolean;` after the existing `priority?: 'p1' | 'p2' | 'p3' | 'p4';` line. Update the INSERT (lines 177-195) to include the new column:

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
  priority?: 'p1' | 'p2' | 'p3' | 'p4';
  priorityManuallySet?: boolean;
  subintentId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  const { rows } = await ownerPool.query<{ ticket_seq: number }>(
    `update workspace set ticket_seq = ticket_seq + 1 where id = $1 returning ticket_seq`,
    [args.workspaceId],
  );
  const number = rows[0]!.ticket_seq;
  await ownerPool.query(
    `insert into conversation
       (id, workspace_id, player_id, session_id, number, created_at, status, confirm_phase, assigned_agent_id, resolution_source, priority, priority_manually_set, subintent_id)
     values ($1, $2, $3, $4, $5, coalesce($6, now()), coalesce($7::conversation_status, 'bot_active'), coalesce($8::confirm_phase, 'none'), $9, $10::resolution_source, coalesce($11::conversation_priority, 'p3'), coalesce($12, false), $13)`,
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
      args.priority ?? null,
      args.priorityManuallySet ?? null,
      args.subintentId ?? null,
    ],
  );
  return id;
}
```

- [ ] **Step 2: Extend `seedSubintent`**

Change the `seedSubintent` args (lines 255-260) to add `defaultPriority?: 'p1' | 'p2' | 'p3' | 'p4';` and thread it into the INSERT:

```ts
export async function seedSubintent(args: {
  workspaceId: string;
  intentId: string;
  name?: string;
  formId?: string | null;
  defaultPriority?: 'p1' | 'p2' | 'p3' | 'p4';
}): Promise<string> {
  const id = randomUUID();
  const name = args.name ?? `Subintent ${randomUUID().slice(0, 8)}`;
  await ownerPool.query(
    `insert into subintent (id, workspace_id, intent_id, name, form_id, default_priority) values ($1, $2, $3, $4, $5, $6::conversation_priority)`,
    [id, args.workspaceId, args.intentId, name, args.formId ?? null, args.defaultPriority ?? null],
  );
  return id;
}
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `pnpm --filter backend test -- helpers` (or simply run the full suite once at the end of Task 6 — these two functions are exercised by every existing test that calls them, so a broken signature fails immediately). For a fast sanity check now:

Run: `pnpm --filter backend test -- agent.reclassify.test.ts`
Expected: PASS (all existing tests, unaffected by the new optional args).

- [ ] **Step 4: Commit**

```bash
git add backend/tests/helpers/db.ts
git commit -m "test: seedConversation/seedSubintent accept priority fields"
```

---

### Task 3: `applySubintentDefaultPriority` helper + unit tests

**Files:**

- Create: `backend/src/domain/conversations/applySubintentDefaultPriority.ts`
- Modify: `backend/src/domain/conversations/index.ts` (add export)
- Test: `backend/tests/domain.applySubintentDefaultPriority.test.ts`

**Interfaces:**

- Consumes: `appendEvent` (`backend/src/shared/events/appendEvent.ts:30`), `conversation`/`subintent` tables (`backend/src/shared/db/schema/index.ts`), `Tx` (`backend/src/shared/db/withWorkspace.ts`).
- Produces: `applySubintentDefaultPriority(tx: Tx, params: { workspaceId: string; conversationId: string; subintentId: string; currentPriority: 'p1'|'p2'|'p3'|'p4'; priorityManuallySet: boolean; actorId: string | null; actorType: 'bot' | 'agent' }): Promise<void>` — called by Task 4 (bot path) and Task 5 (agent reclassify path).

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/domain.applySubintentDefaultPriority.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applySubintentDefaultPriority } from '../src/domain/conversations/index.ts';
import { conversation } from '../src/shared/db/schema/index.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { closeDb } from '../src/shared/db/client.ts';
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

beforeEach(truncateAll);
afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

async function conversationRow(id: string) {
  const { rows } = await ownerPool.query<{ priority: string; priority_manually_set: boolean }>(
    `select priority, priority_manually_set from conversation where id = $1`,
    [id],
  );
  return rows[0]!;
}

async function eventsFor(conversationId: string) {
  const { rows } = await ownerPool.query(
    `select type, actor_id, actor_type, payload from event where conversation_id = $1 order by id`,
    [conversationId],
  );
  return rows;
}

describe('applySubintentDefaultPriority', () => {
  it('applies the subintent default priority when unset and priority differs', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const intentId = await seedIntent(workspaceId);
    const subintentId = await seedSubintent({ workspaceId, intentId, defaultPriority: 'p1' });
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p3' });

    await withWorkspace(workspaceId, (tx) =>
      applySubintentDefaultPriority(tx, {
        workspaceId,
        conversationId,
        subintentId,
        currentPriority: 'p3',
        priorityManuallySet: false,
        actorId: null,
        actorType: 'bot',
      }),
    );

    const row = await conversationRow(conversationId);
    expect(row.priority).toBe('p1');

    const events = await eventsFor(conversationId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'conversation_priority_changed',
      actor_id: null,
      actor_type: 'bot',
      payload: { from: 'p3', to: 'p1', reason: 'subintent_default' },
    });
  });

  it('does nothing when priorityManuallySet is true', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const intentId = await seedIntent(workspaceId);
    const subintentId = await seedSubintent({ workspaceId, intentId, defaultPriority: 'p1' });
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      priority: 'p4',
      priorityManuallySet: true,
    });

    await withWorkspace(workspaceId, (tx) =>
      applySubintentDefaultPriority(tx, {
        workspaceId,
        conversationId,
        subintentId,
        currentPriority: 'p4',
        priorityManuallySet: true,
        actorId: null,
        actorType: 'bot',
      }),
    );

    const row = await conversationRow(conversationId);
    expect(row.priority).toBe('p4');
    expect(await eventsFor(conversationId)).toEqual([]);
  });

  it('does nothing when the subintent has no default priority', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const intentId = await seedIntent(workspaceId);
    const subintentId = await seedSubintent({ workspaceId, intentId });
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p3' });

    await withWorkspace(workspaceId, (tx) =>
      applySubintentDefaultPriority(tx, {
        workspaceId,
        conversationId,
        subintentId,
        currentPriority: 'p3',
        priorityManuallySet: false,
        actorId: null,
        actorType: 'bot',
      }),
    );

    const row = await conversationRow(conversationId);
    expect(row.priority).toBe('p3');
    expect(await eventsFor(conversationId)).toEqual([]);
  });

  it('does nothing when the default priority equals the current priority', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const intentId = await seedIntent(workspaceId);
    const subintentId = await seedSubintent({ workspaceId, intentId, defaultPriority: 'p3' });
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p3' });

    await withWorkspace(workspaceId, (tx) =>
      applySubintentDefaultPriority(tx, {
        workspaceId,
        conversationId,
        subintentId,
        currentPriority: 'p3',
        priorityManuallySet: false,
        actorId: null,
        actorType: 'bot',
      }),
    );

    expect(await eventsFor(conversationId)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter backend test -- domain.applySubintentDefaultPriority.test.ts`
Expected: FAIL — `applySubintentDefaultPriority` is not exported from `../src/domain/conversations/index.ts` (module doesn't exist yet).

- [ ] **Step 3: Implement the helper**

Create `backend/src/domain/conversations/applySubintentDefaultPriority.ts`:

```ts
import { eq } from 'drizzle-orm';
import { conversation, subintent } from '../../shared/db/schema/index.ts';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { appendEvent } from '../../shared/events/appendEvent.ts';

type ConversationPriority = 'p1' | 'p2' | 'p3' | 'p4';

/**
 * Applies a subintent's `default_priority` onto a conversation, called from
 * every place a conversation's subintent gets written (bot's classifyIfUnset,
 * agent's reclassifyConversation). Manual always wins: skipped entirely once
 * `priorityManuallySet` is true, and a no-op (no write, no event) when the
 * subintent has no default or the default already matches the current value.
 * See docs/specs/2026-08-27-conversation-priority-design.md.
 */
export async function applySubintentDefaultPriority(
  tx: Tx,
  params: {
    workspaceId: string;
    conversationId: string;
    subintentId: string;
    currentPriority: ConversationPriority;
    priorityManuallySet: boolean;
    actorId: string | null;
    actorType: 'bot' | 'agent';
  },
): Promise<void> {
  if (params.priorityManuallySet) return;

  const [target] = await tx
    .select({ defaultPriority: subintent.defaultPriority })
    .from(subintent)
    .where(eq(subintent.id, params.subintentId))
    .limit(1);

  if (!target?.defaultPriority || target.defaultPriority === params.currentPriority) return;

  await tx
    .update(conversation)
    .set({ priority: target.defaultPriority })
    .where(eq(conversation.id, params.conversationId));

  await appendEvent(tx, {
    workspaceId: params.workspaceId,
    type: 'conversation_priority_changed',
    conversationId: params.conversationId,
    actorId: params.actorId,
    actorType: params.actorType,
    payload: {
      from: params.currentPriority,
      to: target.defaultPriority,
      reason: 'subintent_default',
    },
  });
}
```

Add the export to `backend/src/domain/conversations/index.ts` (alongside the existing `export * from './...'` lines):

```ts
export * from './applySubintentDefaultPriority.ts';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter backend test -- domain.applySubintentDefaultPriority.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/conversations/applySubintentDefaultPriority.ts backend/src/domain/conversations/index.ts backend/tests/domain.applySubintentDefaultPriority.test.ts
git commit -m "feat: add applySubintentDefaultPriority helper"
```

---

### Task 4: Wire auto-priority into the bot's `classifyIfUnset`

**Files:**

- Modify: `backend/src/domain/bot/applyBotTurn.ts:323-355` (`classifyIfUnset`)
- Test: `backend/tests/bot.turnSeam.test.ts` (extend)

**Interfaces:**

- Consumes: `applySubintentDefaultPriority` (Task 3).
- Produces: nothing new — this task only wires an existing call site.

- [ ] **Step 1: Write the failing test**

In `backend/tests/bot.turnSeam.test.ts`, add `seedSubintent`'s new `defaultPriority` param usage in a new test. First, add a small local helper near the top (after `conversationRow`, around line 39) to read priority:

```ts
async function priorityOf(conversationId: string) {
  const { rows } = await ownerPool.query<{ priority: string; priority_manually_set: boolean }>(
    `select priority, priority_manually_set from conversation where id = $1`,
    [conversationId],
  );
  return rows[0]!;
}
```

Then add this test inside the `describe('applyBotTurn', ...)` block, after the existing `'a second answer does not reclassify...'` test (after line 157):

```ts
it('classifying to a subintent with a default priority applies it, once', async () => {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p3' });
  const intentId = await seedIntent(workspaceId);
  const subintentId = await seedSubintent({ workspaceId, intentId, defaultPriority: 'p1' });

  await withWorkspace(workspaceId, (tx) =>
    applyBotTurn(
      tx,
      { workspaceId, conversationId },
      { kind: 'answer', reply: 'first', subintentId },
    ),
  );

  const row = await priorityOf(conversationId);
  expect(row.priority).toBe('p1');
  expect(row.priority_manually_set).toBe(false);

  const events = await eventsFor(conversationId);
  expect(events.map((e) => e.type)).toEqual([
    'message_sent',
    'intent_set',
    'conversation_priority_changed',
  ]);
});

it('does not touch priority when already manually set', async () => {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({
    workspaceId,
    playerId,
    priority: 'p4',
    priorityManuallySet: true,
  });
  const intentId = await seedIntent(workspaceId);
  const subintentId = await seedSubintent({ workspaceId, intentId, defaultPriority: 'p1' });

  await withWorkspace(workspaceId, (tx) =>
    applyBotTurn(
      tx,
      { workspaceId, conversationId },
      { kind: 'answer', reply: 'first', subintentId },
    ),
  );

  const row = await priorityOf(conversationId);
  expect(row.priority).toBe('p4');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter backend test -- bot.turnSeam.test.ts`
Expected: FAIL on the first new test — priority stays `p3`, no `conversation_priority_changed` event.

- [ ] **Step 3: Wire the call**

In `backend/src/domain/bot/applyBotTurn.ts`, import `applySubintentDefaultPriority` (add to the existing import from `'../conversations/index.ts'` or add a new import line near the top — check the existing imports around line 1-20 for where `postMessage`/similar helpers are imported from and follow that pattern) and, inside `classifyIfUnset` (lines 323-355), after the `if (updated.length === 0) return;` guard and before (or after) the `intent_set` `appendEvent` call, add:

```ts
await applySubintentDefaultPriority(tx, {
  workspaceId: ctx.workspaceId,
  conversationId: ctx.conversationId,
  subintentId,
  currentPriority: 'p3',
  priorityManuallySet: false,
  actorId: null,
  actorType: 'bot',
});
```

Note: `classifyIfUnset`'s `UPDATE ... WHERE subintent_id IS NULL` guard means this only ever runs on a conversation's _first_ classification — at that point `priority_manually_set` is always `false` and `priority` is always the schema default `p3` (nothing else writes `priority` before first classification per this codebase). Hardcoding `currentPriority: 'p3'` and `priorityManuallySet: false` here — rather than an extra `SELECT` — is correct precisely because `classifyIfUnset` is write-once; if `classifyIfUnset`'s write-once guard is ever loosened, this call must be revisited to read the live values instead.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter backend test -- bot.turnSeam.test.ts`
Expected: PASS (all tests, including the two new ones and every pre-existing one — event-order assertions in already-passing tests like `'answer keeps bot_active...'` must still pass since that test's subintent has no `defaultPriority` seeded, so `applySubintentDefaultPriority` no-ops for it).

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/bot/applyBotTurn.ts backend/tests/bot.turnSeam.test.ts
git commit -m "feat: apply subintent default priority on bot classification"
```

---

### Task 5: Wire auto-priority into `reclassifyConversation`

**Files:**

- Modify: `backend/src/agent/services/conversationsService.ts:542-598` (`reclassifyConversation`)
- Test: `backend/tests/agent.reclassify.test.ts` (extend)

**Interfaces:**

- Consumes: `applySubintentDefaultPriority` (Task 3).
- Produces: nothing new — wiring only.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/agent.reclassify.test.ts`, add two tests at the end of the `describe('PATCH /agent/conversations/:id/subintent', ...)` block (after the existing `'does not insert a message row...'` test, before the closing `});` at line 332):

```ts
it('applies the target subintent default priority when not manually set', async () => {
  const workspaceId = await seedWorkspace();
  const intentId = await seedIntent(workspaceId);
  const fromSubintentId = await seedSubintent({ workspaceId, intentId });
  const toSubintentId = await seedSubintent({ workspaceId, intentId, defaultPriority: 'p1' });
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({
    workspaceId,
    playerId,
    status: 'open',
    subintentId: fromSubintentId,
    priority: 'p3',
  });
  const { agentId, token } = await setupAgent(workspaceId);

  await request(app)
    .patch(`/conversations/${conversationId}/subintent`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Workspace-Id', workspaceId)
    .send({ subintentId: toSubintentId })
    .expect(200);

  const { rows } = await ownerPool.query<{ priority: string }>(
    `select priority from conversation where id = $1`,
    [conversationId],
  );
  expect(rows[0]!.priority).toBe('p1');

  const events = await ownerPool.query(
    `select type, actor_id, payload from event where conversation_id = $1 and type = 'conversation_priority_changed'`,
    [conversationId],
  );
  expect(events.rows).toHaveLength(1);
  expect(events.rows[0]).toMatchObject({
    actor_id: agentId,
    payload: { from: 'p3', to: 'p1', reason: 'subintent_default' },
  });
});

it('does not override a manually-set priority on reclassify', async () => {
  const workspaceId = await seedWorkspace();
  const intentId = await seedIntent(workspaceId);
  const fromSubintentId = await seedSubintent({ workspaceId, intentId });
  const toSubintentId = await seedSubintent({ workspaceId, intentId, defaultPriority: 'p1' });
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({
    workspaceId,
    playerId,
    status: 'open',
    subintentId: fromSubintentId,
    priority: 'p4',
    priorityManuallySet: true,
  });
  const { token } = await setupAgent(workspaceId);

  await request(app)
    .patch(`/conversations/${conversationId}/subintent`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Workspace-Id', workspaceId)
    .send({ subintentId: toSubintentId })
    .expect(200);

  const { rows } = await ownerPool.query<{ priority: string }>(
    `select priority from conversation where id = $1`,
    [conversationId],
  );
  expect(rows[0]!.priority).toBe('p4');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter backend test -- agent.reclassify.test.ts`
Expected: FAIL on the first new test — priority stays `p3`, no `conversation_priority_changed` event written.

- [ ] **Step 3: Wire the call**

In `backend/src/agent/services/conversationsService.ts`, add `applySubintentDefaultPriority` to the import from `'../../domain/conversations/index.ts'` (line 16-20, alongside `postMessage`/`toAgentView`), and select `priority`/`priorityManuallySet` in `reclassifyConversation`'s existing lookup (lines 548-556):

```ts
const [conv] = await tx
  .select({
    id: conversation.id,
    subintentId: conversation.subintentId,
    status: conversation.status,
    priority: conversation.priority,
    priorityManuallySet: conversation.priorityManuallySet,
  })
  .from(conversation)
  .where(eq(conversation.id, conversationId))
  .limit(1);
```

Then, after the existing `UPDATE conversation SET subintentId, classificationSource` (lines 572-575) and before the `appendEvent` call for `conversation_reclassified` (line 577), add:

```ts
await applySubintentDefaultPriority(tx, {
  workspaceId: ctx.workspaceId,
  conversationId,
  subintentId,
  currentPriority: conv.priority,
  priorityManuallySet: conv.priorityManuallySet,
  actorId: ctx.agentId,
  actorType: 'agent',
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter backend test -- agent.reclassify.test.ts`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/services/conversationsService.ts backend/tests/agent.reclassify.test.ts
git commit -m "feat: apply subintent default priority on agent reclassify"
```

---

### Task 6: Manual priority edit — service, route, controller, openapi

**Files:**

- Modify: `backend/src/agent/services/conversationsService.ts` (new `setConversationPriority`, after `reclassifyConversation`)
- Modify: `backend/src/agent/controllers/conversationsController.ts` (new handler, after `reclassifyConversationHandler`)
- Modify: `backend/src/agent/routers/conversationsRouter.ts` (new route)
- Modify: `backend/src/docs/openapi.ts` (new path registration, after the `/subintent` entry at line 971)
- Test: `backend/tests/agent.priority.test.ts` (new, modeled on `agent.reclassify.test.ts`)

**Interfaces:**

- Consumes: `withWorkspace`, `appendEvent`, `appendChangeLog` (same imports already in `conversationsService.ts`).
- Produces: `setConversationPriority(ctx: AgentContext, conversationId: string, priority: 'p1'|'p2'|'p3'|'p4'): Promise<SetPriorityResult>` where `SetPriorityResult = { ok: true; updated: boolean } | { ok: false; reason: 'not_found' }`. Consumed by the controller in this task and, later, nothing else in this plan (frontend calls the HTTP route, not this function directly).

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/agent.priority.test.ts`, copying `agent.reclassify.test.ts`'s harness verbatim (imports, `setupAgent`, `beforeAll`/`afterAll`/`beforeEach`) but importing `conversationsRouter` the same way, and this `describe` block:

```ts
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, conversationsRouter);
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

async function setupAgent(workspaceId: string): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ('agent1@example.test', 'Agent One') returning id`,
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  );
  const token = await signAgentSession({ agent_id: agentId });
  return { agentId, token };
}

describe('PATCH /agent/conversations/:id/priority', () => {
  it('sets priority and marks it manually set', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p3' });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .patch(`/conversations/${conversationId}/priority`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ priority: 'p1' })
      .expect(200);

    expect(res.body).toEqual({ updated: true });

    const { rows } = await ownerPool.query<{ priority: string; priority_manually_set: boolean }>(
      `select priority, priority_manually_set from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.priority).toBe('p1');
    expect(rows[0]!.priority_manually_set).toBe(true);
  });

  it('works on a resolved conversation (no status restriction)', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'resolved',
      priority: 'p3',
    });
    const { token } = await setupAgent(workspaceId);

    await request(app)
      .patch(`/conversations/${conversationId}/priority`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ priority: 'p2' })
      .expect(200);
  });

  it('returns 404 for a conversation that does not exist', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await setupAgent(workspaceId);
    const nonExistentConversationId = '00000000-0000-0000-0000-000000000000';

    const res = await request(app)
      .patch(`/conversations/${nonExistentConversationId}/priority`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ priority: 'p1' })
      .expect(404);

    expect(res.body.error.code).toBe('not_found');
  });

  it('is a no-op when priority already equals the requested value', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p3' });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .patch(`/conversations/${conversationId}/priority`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ priority: 'p3' })
      .expect(200);

    expect(res.body).toEqual({ updated: false });

    const events = await ownerPool.query(
      `select id from event where conversation_id = $1 and type = 'conversation_priority_changed'`,
      [conversationId],
    );
    expect(events.rows).toHaveLength(0);
  });

  it('writes exactly one conversation_priority_changed event with correct payload', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p3' });
    const { agentId, token } = await setupAgent(workspaceId);

    await request(app)
      .patch(`/conversations/${conversationId}/priority`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ priority: 'p1' })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select type, actor_id, actor_type, payload from event where conversation_id = $1 and type = 'conversation_priority_changed'`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'conversation_priority_changed',
      actor_id: agentId,
      actor_type: 'agent',
      payload: { from: 'p3', to: 'p1', reason: 'manual' },
    });
  });

  it('writes exactly one change_log row with correct before/after', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p3' });
    const { token } = await setupAgent(workspaceId);

    await request(app)
      .patch(`/conversations/${conversationId}/priority`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ priority: 'p1' })
      .expect(200);

    const { rows } = await ownerPool.query<{
      field: string;
      before_value: string;
      after_value: string;
    }>(
      `select field, before_value, after_value from change_log where entity_id = $1 and entity_type = 'conversation' and field = 'priority'`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before_value).toBe('p3');
    expect(rows[0]!.after_value).toBe('p1');
  });

  it('rejects an invalid priority value with 422', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { token } = await setupAgent(workspaceId);

    await request(app)
      .patch(`/conversations/${conversationId}/priority`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ priority: 'urgent' })
      .expect(422);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter backend test -- agent.priority.test.ts`
Expected: FAIL — route `PATCH /agent/conversations/:id/priority` doesn't exist (404/`Cannot PATCH`).

- [ ] **Step 3: Implement the service function**

In `backend/src/agent/services/conversationsService.ts`, add after `reclassifyConversation` (after line 598, before the `WorkspaceWorkloadAgent` type). `status` rides along in the result the same way `ReclassifyResult` carries it — the controller needs it for `emitInboxChanged`, which every other mutation handler in this file also calls with the conversation's current status:

```ts
export type SetPriorityResult =
  { ok: true; updated: boolean; status: string } | { ok: false; reason: 'not_found' };

export async function setConversationPriority(
  ctx: AgentContext,
  conversationId: string,
  priority: (typeof conversation.priority.enumValues)[number],
): Promise<SetPriorityResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [conv] = await tx
      .select({ id: conversation.id, priority: conversation.priority, status: conversation.status })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1);
    if (!conv) return { ok: false, reason: 'not_found' };
    if (conv.priority === priority) return { ok: true, updated: false, status: conv.status };

    await tx
      .update(conversation)
      .set({ priority, priorityManuallySet: true })
      .where(eq(conversation.id, conversationId));

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_priority_changed',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { from: conv.priority, to: priority, reason: 'manual' },
    });
    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'conversation',
      entityId: conversationId,
      actorId: ctx.agentId,
      changes: [{ field: 'priority', before: conv.priority, after: priority }],
    });
    return { ok: true, updated: true, status: conv.status };
  });
}
```

- [ ] **Step 4: Implement the controller handler**

In `backend/src/agent/controllers/conversationsController.ts`, add `setConversationPriority` to the import from `'../services/conversationsService.ts'` (line 11-19), and after `reclassifyConversationHandler` (after line 184), add:

```ts
const SetPriorityBody = z.object({ priority: z.enum(['p1', 'p2', 'p3', 'p4']) });

const SET_PRIORITY_ERRORS = {
  not_found: [404, 'Conversation not found.'],
} as const;

export const setConversationPriorityHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const params = ConversationIdParams.safeParse(req.params);
  const body = SetPriorityBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'id must be a uuid, body must be { priority: p1|p2|p3|p4 }.',
    );
    return;
  }
  const result = await setConversationPriority(ctx, params.data.id, body.data.priority);
  if (!result.ok) {
    const [status, message] = SET_PRIORITY_ERRORS[result.reason];
    sendError(res, status, result.reason, message);
    return;
  }
  // Status is unaffected by a priority change — this is the same signal
  // reclassify emits, which ContextRail's socket listener already
  // invalidates its caches on. Skipped on a no-op so an unchanged value
  // doesn't trigger a cache invalidation for nothing.
  if (result.updated) {
    emitInboxChanged(getIo(), ctx.workspaceId, params.data.id, result.status);
  }
  res.status(200).json({ updated: result.updated });
};
```

- [ ] **Step 5: Register the route**

In `backend/src/agent/routers/conversationsRouter.ts`, add `setConversationPriorityHandler` to the import (alongside `reclassifyConversationHandler`), and add after line 34:

```ts
conversationsRouter.patch('/conversations/:id/priority', setConversationPriorityHandler);
```

- [ ] **Step 6: Register in openapi.ts**

In `backend/src/docs/openapi.ts`, after the `/agent/conversations/{id}/subintent` `registerPath` block (after line 971), add:

```ts
registry.registerPath({
  method: 'patch',
  path: '/agent/conversations/{id}/priority',
  summary: 'Agent Set Conversation Priority',
  description:
    "Sets a conversation's priority directly. Marks it manually-set, which permanently prevents subintent-classification auto-priority from overwriting it again. No-op (updated: false) when the requested value already matches.",
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: {
        'application/json': { schema: z.object({ priority: z.enum(['p1', 'p2', 'p3', 'p4']) }) },
      },
    },
  },
  responses: {
    200: {
      description: 'Set-priority result',
      content: { 'application/json': { schema: z.object({ updated: z.boolean() }) } },
    },
    404: { description: 'Conversation not found' },
  },
});
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter backend test -- agent.priority.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 8: Run the full backend suite**

Run: `pnpm --filter backend test`
Expected: PASS — everything from Tasks 1-6 plus every pre-existing test, in one pass (Postgres must be up per `CLAUDE.md`).

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 10: Commit**

```bash
git add backend/src/agent/services/conversationsService.ts backend/src/agent/controllers/conversationsController.ts backend/src/agent/routers/conversationsRouter.ts backend/src/docs/openapi.ts backend/tests/agent.priority.test.ts
git commit -m "feat: add PATCH /agent/conversations/:id/priority"
```

---

### Task 7: Thread `priority` through the conversation-detail read path

**Files:**

- Modify: `packages/types/src/agent-context.ts:17-32` (`AgentConversationDetail`)
- Modify: `backend/src/agent/services/conversationContextService.ts:38-90` (`getConversationDetail`)

**Interfaces:**

- Consumes: `conversation.priority` (existing column).
- Produces: `AgentConversationDetail.priority: ConversationPriorityValue`, consumed by Task 10 (`ConversationDetailPane.tsx`).

- [ ] **Step 1: Add the field to the shared type**

In `packages/types/src/agent-context.ts`, add the import and field:

```ts
import type { ConversationPriorityValue, ConversationStatusValue } from './chat.ts';
```

(replacing the existing `import type { ConversationStatusValue } from './chat.ts';` on line 1), and add `priority: ConversationPriorityValue;` to `AgentConversationDetail` (after the `status` field, line 21):

```ts
export type AgentConversationDetail = {
  id: string;
  number: number;
  player: { id: string; external_player_id: string };
  status: ConversationStatusValue;
  priority: ConversationPriorityValue;
  subintent: { intent_name: string; subintent_name: string; subintent_id: string | null } | null;
  assigned_agent: { id: string; display_name: string } | null;
  resolution_source: ResolutionSourceValue | null;
  resolved_by_agent_name: string | null;
  created_at: string;
};
```

- [ ] **Step 2: Select and return it from the backend**

In `backend/src/agent/services/conversationContextService.ts`, add `priority: conversation.priority` to the `.select({...})` call in `getConversationDetail` (after `status: conversation.status,`, around line 47), and add `priority: row.priority,` to the returned object (after `status: row.status,`, around line 72).

- [ ] **Step 3: Verify with a quick manual check**

Run: `pnpm typecheck`
Expected: exits 0 — this confirms the new required field is populated everywhere `AgentConversationDetail` is constructed (there's exactly one construction site, `getConversationDetail`) and every consumer compiles (none read `priority` yet — that's Task 10).

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/agent-context.ts backend/src/agent/services/conversationContextService.ts
git commit -m "feat: include priority in conversation detail response"
```

---

### Task 8: Frontend API client — `setConversationPriority`

**Files:**

- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`

**Interfaces:**

- Produces: `setConversationPriority(token: string, conversationId: string, priority: string): Promise<{ updated: boolean }>` — consumed by Task 9 (`PriorityPicker.tsx`).

- [ ] **Step 1: Add the function**

In `frontend/src/surfaces/agent-console/api/agentApi.ts`, add after `reclassifyConversation` (after line 182):

```ts
export function setConversationPriority(
  token: string,
  conversationId: string,
  priority: string,
): Promise<{ updated: boolean }> {
  return call(`/agent/conversations/${conversationId}/priority`, token, {
    method: 'PATCH',
    body: JSON.stringify({ priority }),
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts
git commit -m "feat: add setConversationPriority API client function"
```

---

### Task 9: `PriorityPicker` component

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/Inbox/components/PriorityPicker.tsx`

**Interfaces:**

- Consumes: `setConversationPriority` (Task 8), `PRIORITY_BADGE_VARIANT` (exported from `ConversationRow.tsx:24-32`), `ConversationPriorityValue` (`@support/types`).
- Produces: `<PriorityPicker token conversationId currentPriority />` — consumed by Task 10 (`ThreadPanel.tsx`).

- [ ] **Step 1: Implement the component**

Create `frontend/src/surfaces/agent-console/pages/Inbox/components/PriorityPicker.tsx`, modeled directly on `SubintentPicker.tsx` — same Popover+Command shape, but the option list is static (4 fixed values, no query):

```tsx
import { useState } from 'react';
import type { ConversationPriorityValue } from '@support/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setConversationPriority } from '../../../api/agentApi.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from '../../../components/ui/command.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.tsx';
import { PRIORITY_BADGE_VARIANT } from './ConversationRow.tsx';

const PRIORITIES: ConversationPriorityValue[] = ['p1', 'p2', 'p3', 'p4'];

export function PriorityPicker({
  token,
  conversationId,
  currentPriority,
}: {
  token: string;
  conversationId: string;
  currentPriority: ConversationPriorityValue;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const setPriority = useMutation({
    mutationFn: (priority: ConversationPriorityValue) =>
      setConversationPriority(token, conversationId, priority),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'detail'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'mine'] });
      setOpen(false);
    },
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Badge variant={PRIORITY_BADGE_VARIANT[currentPriority]} className="cursor-pointer">
          {currentPriority.toUpperCase()}
        </Badge>
      </PopoverTrigger>
      <PopoverContent className="p-0">
        <Command shouldFilter={false}>
          <CommandList>
            <CommandGroup>
              {PRIORITIES.map((p) => (
                <CommandItem key={p} value={p} onSelect={() => setPriority.mutate(p)}>
                  {p.toUpperCase()}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Inbox/components/PriorityPicker.tsx
git commit -m "feat: add PriorityPicker component"
```

---

### Task 10: Wire `PriorityPicker` into the thread header

**Files:**

- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx`
- Modify: `frontend/src/surfaces/agent-console/components/ConversationDetailPane.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx` (extend, if it already covers `SubintentPicker`/`AssignPicker` rendering — check the file first; add an equivalent case)

**Interfaces:**

- Consumes: `PriorityPicker` (Task 9), `AgentConversationDetail.priority` / `AgentConversationSummary.priority` (Task 7 / existing).

- [ ] **Step 1: Check the existing ThreadPanel test for the pattern to mirror**

Read `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx` around its `SubintentPicker`/`AssignPicker`-related assertions (if any exist) to match the exact render/query-client-mocking setup before writing a new assertion. If the file has no test asserting `SubintentPicker` renders, skip straight to Step 2 without adding a new frontend test — do not invent a new test harness pattern from scratch for this plan.

- [ ] **Step 2: Add the `priority` prop to `ThreadPanel`**

In `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx`, add `import type { ConversationPriorityValue } from '@support/types';` to the existing type-only import from `'@support/types'` (line 2-7), import `PriorityPicker` (alongside the `SubintentPicker`/`AssignPicker` imports at lines 26-28):

```ts
import { PriorityPicker } from './PriorityPicker.tsx';
```

Add `priority` to the function's destructured props and its type (after `status`, in both the destructure at line 90-107 and the type block at line 108-125):

```ts
  status,
  priority,
```

```ts
  status?: ConversationStatusValue;
  priority?: ConversationPriorityValue;
```

Render it in the header, right after the status badge (after line 371, before the `SubintentPicker` block at line 372-383):

```tsx
{
  status && <Badge variant={STATUS_BADGE_VARIANT[status]}>{formatStatus(status)}</Badge>;
}
{
  conversationId && priority && (
    <PriorityPicker token={token} conversationId={conversationId} currentPriority={priority} />
  );
}
```

- [ ] **Step 3: Pass `priority` from `ConversationDetailPane`**

In `frontend/src/surfaces/agent-console/components/ConversationDetailPane.tsx`, add a `priority` derivation alongside the existing `status`/`assignedAgentId` derivations (after line 53):

```ts
const priority = summary?.priority ?? detail.data?.priority;
```

And pass it to `<ThreadPanel>` (alongside the existing `status={status}` prop, around line 72):

```tsx
priority = { priority };
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 5: Manual verification in the running app**

Run: `pnpm dev`, open the agent console, open any conversation, confirm the priority badge now appears in the thread header next to the status badge, is clickable, opens a popover with P1-P4, and selecting one persists (refresh the page, badge shows the new value) and updates the badge in the conversation list row too.

- [ ] **Step 6: Run the full test suite once**

Run: `pnpm test`
Expected: PASS across every package (backend + frontend).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx frontend/src/surfaces/agent-console/components/ConversationDetailPane.tsx
git commit -m "feat: show and edit conversation priority in thread header"
```

---

## Self-Review Notes

- **Spec coverage:** Data model change → Task 1. Auto-priority from subintent (both call sites) → Tasks 3-5. Manual priority edit (service/route/controller/openapi) → Task 6. Frontend (api client, picker, wiring, type/read-path plumbing) → Tasks 7-10. Testing section of the spec → covered inline in each task (Tasks 3, 4, 5, 6 each add/extend tests; Task 10 checks for an existing frontend test pattern before deciding whether to add one, rather than skipping frontend coverage silently).
- **Out-of-scope items from the spec** (subintent-merge retroactive priority, `assignOnHandoff` changes, bulk edits, notifications) are intentionally absent from every task above — no task touches `assignOnHandoff.ts` or `taxonomyService.ts`'s `mergeSubintent`.
- **Type consistency check:** `applySubintentDefaultPriority`'s `currentPriority`/`priorityManuallySet` params (Task 3) match exactly what Task 4 hardcodes (`'p3'`/`false`, justified by `classifyIfUnset`'s write-once guard) and what Task 5 reads live from the conversation row. `SetPriorityResult` (Task 6) carries `status` specifically because the controller needs it for `emitInboxChanged`, matching `ReclassifyResult`'s existing shape — flagged inline in Task 6 rather than left as a mismatch.
