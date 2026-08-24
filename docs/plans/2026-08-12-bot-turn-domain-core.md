# Bot Turn Domain Core Implementation Plan

> **Executed and partly superseded — read this before copying anything out of it.** This is a
> historical execution record; it is not updated in place. The `bot_handoff` payload it shows
> (`{ reason }`, at the code sample around line 1074 and the assertion around line 895) gained
> `assigned_agent_id` on 2026-08-13 — `assignOnHandoff` had already computed the value and it was
> being discarded. See
> [`docs/specs/2026-08-13-conversation-lifecycle-events-and-session-attribution-design.md`](../specs/2026-08-13-conversation-lifecycle-events-and-session-attribution-design.md).
> `null` there means no active agent exists, which is a valid outcome, not an error. All three bot
> events stay unstamped (`session_id: null`) on purpose: they are bot-authored and generally run in
> the BullMQ worker, so stamping would be inconsistent.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the bot orchestrator its shape before its brain: the `subintent_id` schema delta, the `BotDecider` seam with a stub that always defers to a human, `applyBotTurn`'s four outcomes as one transaction each, deterministic least-loaded assignment, the two fixed-copy messages, and the synchronous half of `sendPlayerMessage` — new conversations default to `bot_active`, and a not-provisioned workspace hands off inline with no job. No queue, no worker, no `openai` call.

**Architecture:** A new `backend/src/domain/bot/` module set (`botTurn.ts`, `applyBotTurn.ts`, `assignOnHandoff.ts`, `messages.ts`) sitting alongside the existing `botConfig.ts`/`defaultPrompt.ts`, all taking a caller-owned `Tx`. One schema delta (`conversation.subintent_id` with the codebase's first composite FK, `subintent`'s new parent unique key). One behavioural change to `sendPlayerMessage`: the `status: 'open'` override on conversation creation is deleted, and a new not-provisioned branch calls `applyBotTurn` inline in the same transaction it already runs in.

**Tech Stack:** TypeScript (native `.ts` ESM imports, extensions included), Drizzle ORM (`drizzle-kit push`), PostgreSQL 17, Vitest.

**Source spec:** `docs/specs/2026-08-11-bot-turn-seam-and-handoff-design.md` (Status: Accepted, revised in part by spec 4 — this plan implements only what spec 4's revision note says stands unchanged: the control flow, the gate, the assignment rule, and the transaction discipline. It does not implement `article_rejected`, the `resolve` outcome, or `bot_phase` — those are spec 4's.)

## Global Constraints

- **This is Part 1 of 2.** Part 2 (`2026-08-12-bot-turn-async-pipeline.md`, written separately) owns `shared/jobs/botTurns.ts` (the `bot-turns` queue and worker), `orchestrator.ts`/`runBotTurn`, the retry/`failed`-handler logic, and the actual `enqueueBotTurn(...)` call from `sendPlayerMessage`'s provisioned branch. This plan stops at producing a `shouldEnqueue: true` value in that branch and does **not** call anything with it — no import of a jobs module, no `if (shouldEnqueue)` follow-through.
- **No LLM call, no `openai` dependency, no `OPENAI_MODEL` env var, no prompt assembly, no retrieval.** `stubDecider` returns `{ kind: 'unavailable', reason: 'not_implemented' }` and does nothing else. That is the entire "decision" in this slice.
- **No hard deletes.** Every new FK is `ON DELETE RESTRICT`.
- **`applyBotTurn` is the only writer of a bot-turn outcome.** No ad-hoc `UPDATE conversation` or `INSERT INTO event` for any of the four outcomes anywhere else.
- **Socket emits never happen inside `applyBotTurn`.** It returns what was posted; only a caller (in this plan, `sendPlayerMessage`; in Part 2, `runBotTurn`) emits, and only after commit.
- **`event.actor_id` is `null` and `event.actor_type` is `'bot'`** for all three new event types (`intent_set`, `bot_handoff`, `bot_unavailable`). Never invent a sentinel bot UUID.
- **`SILENT_UNAVAILABLE_REASONS` is `{'not_provisioned', 'not_implemented'}` exactly.** The `bot_unavailable` event is written for every `unavailable` outcome regardless; only the internal note is conditional on this set.
- **Classification (`subintent_id` + `classification_source`) is written only when `subintent_id IS NULL`,** and `intent_set` is appended only when the write actually happened. A second `answer` never overwrites the first.
- **`'not_implemented'` is scaffolding, not a product state.** It exists only so spec 3/4's removal of it is a type error that forces every reference to be found — do not build anything downstream (metrics, UI copy) that treats it as a real reason.
- **The player-facing handoff copy is the fixed string** `"You're being connected to our support team."` — a compile-time constant, never model output, identical for a clean handoff and a crash.
- **`assignOnHandoff`'s "active" predicate is `workspace_member.deactivated_at IS NULL AND agent.status = 'active'`.** Role is never consulted. "No active agent" is not an error — `assigned_agent_id` stays `NULL` and the status still flips to `open`.
- Imports carry the `.ts` extension (`from './identity.ts'`). Follow the existing schema/domain files exactly.
- Never `console.*`. Use `logger` from `backend/src/shared/logging/logger.ts` if logging is needed (this slice writes no logs — the fallback path's whole point is not needing one to be correct).
- All commands run from the repo root: `/Users/hassanrashid/Desktop/git/mindstorm/crm/app`. Postgres and Redis must be up (`docker compose up -d`) for any test that touches the database. Run `pnpm db:setup` after Task 1's schema change, before running any other test in this plan.

---

## File Structure

| File                                              | Action | Responsibility                                                                                                                                 |
| ------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/shared/db/schema/taxonomy.ts`        | modify | add `UNIQUE (workspace_id, id)` to `subintent`                                                                                                 |
| `backend/src/shared/db/schema/conversations.ts`   | modify | add `conversation.subintent_id`, its composite FK, its index                                                                                   |
| `backend/src/domain/bot/botTurn.ts`               | create | `HandoffReason`, `UnavailableReason`, `BotTurnDecision`, `BotDecider`, `BotTurnInput`, `SILENT_UNAVAILABLE_REASONS`, `stubDecider`             |
| `backend/src/domain/bot/messages.ts`              | create | `HANDOFF_PLAYER_MESSAGE`, `botFailureNote(reason)`                                                                                             |
| `backend/src/domain/bot/assignOnHandoff.ts`       | create | `assignOnHandoff(tx, workspaceId)` → `agentId \| null`                                                                                         |
| `backend/src/domain/bot/applyBotTurn.ts`          | create | `applyBotTurn(tx, ctx, decision)` → `{ posted[], statusChanged }`, all four outcomes                                                           |
| `backend/src/domain/bot/index.ts`                 | modify | barrel now also exports the four new modules                                                                                                   |
| `backend/src/domain/conversations/postMessage.ts` | modify | `PostMessageInput.actorId` widens to `string \| null`                                                                                          |
| `backend/src/surface/services/messagesService.ts` | modify | remove the `status: 'open'` override; add the not-provisioned inline branch; compute (but do not consume) `shouldEnqueue`                      |
| `backend/tests/helpers/db.ts`                     | modify | `seedWorkspaceMember`, `seedIntent`, `seedSubintent` helpers; `SCOPED_TABLES` already includes `subintent`/`intent`? verify and add if missing |
| `backend/tests/schema.test.ts`                    | modify | three new assertions (composite FK, subintent unique key, conversation status default)                                                         |
| `backend/tests/bot.turnSeam.test.ts`              | create | full outcome-matrix test file                                                                                                                  |
| `backend/tests/bot.assignment.test.ts`            | create | least-loaded assignment test file                                                                                                              |
| `backend/tests/surface.messages.test.ts`          | modify | replace the `status: 'open'`-on-create assertion; add the not-provisioned branch assertions                                                    |
| `backend/tests/realtime.internalNote.test.ts`     | modify | extend to cover a bot failure note, not just an agent-authored one                                                                             |

`docs/decisions/spec-contradictions.md` needs **no** edit here — the assignment deviation (§7 of the spec) is Part 1's to record since `assignOnHandoff` is built here.

---

### Task 1: Schema delta — `subintent` unique key, `conversation.subintent_id`, composite FK

**Files:**

- Modify: `backend/src/shared/db/schema/taxonomy.ts`
- Modify: `backend/src/shared/db/schema/conversations.ts`
- Test: `backend/tests/schema.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `conversation.subintentId` (Drizzle column, `uuid`, nullable) and `subintent`'s new `UNIQUE (workspace_id, id)` index, both importable via `backend/src/shared/db/schema/index.ts` as today.

This is the codebase's **first** composite foreign key (per `docs/decisions/2026-08-04-composite-foreign-keys-for-tenancy.md`) — every existing FK is still single-column `.references(() => x.id)`. Drizzle expresses a composite FK with the `foreignKey()` table-builder function in the third argument to `pgTable`, not with `.references()` on a single column.

- [ ] **Step 1: Write the failing schema tests**

In `backend/tests/schema.test.ts`, add inside the existing `describe('schema', …)` block:

```ts
it('gives subintent a (workspace_id, id) unique key for the composite FK', async () => {
  const { rows } = await ownerPool.query<{ indexdef: string }>(
    `select indexdef from pg_indexes where tablename = 'subintent'`,
  );
  const defs = rows.map((r) => r.indexdef).join('\n');
  expect(defs).toMatch(/UNIQUE INDEX .* ON public\.subintent USING btree \(workspace_id, id\)/);
});

it('adds a nullable, composite-FK conversation.subintent_id', async () => {
  const cols = await columns('conversation');
  expect(cols.has('subintent_id')).toBe(true);
  expect(cols.get('subintent_id')?.nullable).toBe(true);

  const { rows } = await ownerPool.query<{ conname: string; confdeltype: string }>(
    `select conname, confdeltype
         from pg_constraint
        where conrelid = 'conversation'::regclass
          and contype = 'f'
          and conkey = (
            select array_agg(attnum order by attnum)
              from pg_attribute
             where attrelid = 'conversation'::regclass
               and attname in ('workspace_id', 'subintent_id')
          )`,
  );
  expect(rows.length).toBe(1);
  expect(rows[0]?.confdeltype).toBe('r'); // ON DELETE RESTRICT
});

it('conversation.status still defaults to bot_active', async () => {
  const { rows } = await ownerPool.query<{ column_default: string }>(
    `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'conversation' and column_name = 'status'`,
  );
  expect(rows[0]?.column_default).toContain('bot_active');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && pnpm vitest run tests/schema.test.ts -t "subintent a"`
Expected: FAIL — `subintent.id` composite unique key does not exist yet, `conversation.subintent_id` column does not exist.

- [ ] **Step 3: Add the unique key to `subintent`**

In `backend/src/shared/db/schema/taxonomy.ts`, change the `subintent` table's index array:

```ts
export const subintent = pgTable(
  'subintent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intent.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    defaultPriority: conversationPriority('default_priority'),
    formId: uuid('form_id'),
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => subintent.id, {
      onDelete: 'restrict',
    }),
    archivedAt: timestamp('archived_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subintent_workspace_intent_name_uk').on(t.workspaceId, t.intentId, t.name),
    // Composite-FK parent key: conversation.subintent_id references (workspace_id, id)
    // together, so a conversation can never name another workspace's subintent — see
    // docs/decisions/2026-08-04-composite-foreign-keys-for-tenancy.md.
    uniqueIndex('subintent_workspace_id_uk').on(t.workspaceId, t.id),
  ],
);
```

- [ ] **Step 4: Add `subintent_id` and its composite FK to `conversation`**

In `backend/src/shared/db/schema/conversations.ts`, add the `foreignKey` import and the column:

```ts
import {
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
```

```ts
import { subintent } from './taxonomy.ts';
```

Add the column to `conversation`'s column map, after `classificationSource`:

```ts
    /**
     * NULL means the bot never classified this conversation — never "unknown
     * category". `Other`'s catch-all subintent is where an unplaceable
     * conversation lands, and the two must stay distinguishable.
     */
    subintentId: uuid('subintent_id'),
```

And add the composite FK plus its index to the table's third argument:

```ts
  (t) => [
    index('conversation_workspace_player_idx').on(t.workspaceId, t.playerId),
    index('conversation_workspace_subintent_idx').on(t.workspaceId, t.subintentId),
    foreignKey({
      name: 'conversation_subintent_fk',
      columns: [t.workspaceId, t.subintentId],
      foreignColumns: [subintent.workspaceId, subintent.id],
    }).onDelete('restrict'),
  ],
```

- [ ] **Step 5: Push the schema and re-run RLS setup**

Run: `pnpm db:setup`
Expected: completes with no error; `pg_indexes`/`pg_constraint` now show the new unique key, column and FK.

- [ ] **Step 6: Run the schema tests to verify they pass**

Run: `cd backend && pnpm vitest run tests/schema.test.ts`
Expected: PASS, all tests including the three new ones.

- [ ] **Step 7: Commit**

```bash
git add backend/src/shared/db/schema/taxonomy.ts backend/src/shared/db/schema/conversations.ts backend/tests/schema.test.ts
git commit -m "feat(bot): add conversation.subintent_id with composite FK to subintent"
```

---

### Task 2: Test helpers for the new module set

**Files:**

- Modify: `backend/tests/helpers/db.ts`

**Interfaces:**

- Produces: `seedWorkspaceMember(args): Promise<string>` (returns `workspace_member.id`), `seedIntent(args): Promise<string>` (returns `intent.id`), `seedSubintent(args): Promise<string>` (returns `subintent.id`).

Every later task's tests need agents attached to a workspace with a role and active status, and a real subintent row to classify onto. Building these helpers first, and proving them against the schema, means Tasks 3–7's tests are not also debugging fixture SQL.

- [ ] **Step 1: Write the failing test proving the helpers exist and insert correctly**

Add a temporary throwaway assertion is unnecessary — instead, write the helpers directly and prove them via Task 3's tests, which depend on them. This task has no dedicated test file of its own; its "test" is that Task 3 onward compile and their seed calls succeed. Skip to Step 2.

- [ ] **Step 2: Add the three helpers**

In `backend/tests/helpers/db.ts`, append:

```ts
export async function seedWorkspaceMember(args: {
  workspaceId: string;
  agentId: string;
  role?: 'agent' | 'team_lead' | 'admin';
  deactivatedAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into workspace_member (id, workspace_id, agent_id, role, deactivated_at) values ($1, $2, $3, $4, $5)`,
    [id, args.workspaceId, args.agentId, args.role ?? 'agent', args.deactivatedAt ?? null],
  );
  return id;
}

export async function seedIntent(
  workspaceId: string,
  name = `Intent ${randomUUID().slice(0, 8)}`,
): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(`insert into intent (id, workspace_id, name) values ($1, $2, $3)`, [
    id,
    workspaceId,
    name,
  ]);
  return id;
}

export async function seedSubintent(args: {
  workspaceId: string;
  intentId: string;
  name?: string;
}): Promise<string> {
  const id = randomUUID();
  const name = args.name ?? `Subintent ${randomUUID().slice(0, 8)}`;
  await ownerPool.query(
    `insert into subintent (id, workspace_id, intent_id, name) values ($1, $2, $3, $4)`,
    [id, args.workspaceId, args.intentId, name],
  );
  return id;
}
```

`seedAgent` inserts with `status` left to its column default (`'active'`), so no change is needed there for the "active agent" case; deactivating an agent for a test is a direct `ownerPool.query("update agent set status = 'on_leave' where id = $1", [id])` inline in that test.

Check `SCOPED_TABLES` in the same file already lists `event`, `message`, `conversation`, `workspace_member`, `agent`, `workspace` — it does not yet list `intent` or `subintent`. Add both, in a position that satisfies FK-cascade truncation order (they must be truncated together with `conversation` since `conversation.subintent_id` now FKs to `subintent`; `TRUNCATE ... CASCADE` handles ordering regardless, so alphabetical-ish placement is fine):

```ts
const SCOPED_TABLES = [
  'change_log',
  'bot_config',
  'event',
  'message',
  'conversation',
  'subintent',
  'intent',
  'player_state_snapshot',
  'declared_field',
  'session',
  'player',
  'workspace_member',
  'agent',
  'workspace',
];
```

- [ ] **Step 3: Verify compilation**

Run: `pnpm typecheck`
Expected: PASS — no consumer of these helpers exists yet, so this only checks the file itself is well-typed.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/helpers/db.ts
git commit -m "test: add seedWorkspaceMember/seedIntent/seedSubintent helpers, scope intent+subintent to truncateAll"
```

---

### Task 3: The `BotDecider` seam and `stubDecider`

**Files:**

- Create: `backend/src/domain/bot/botTurn.ts`
- Modify: `backend/src/domain/bot/index.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `HandoffReason`, `UnavailableReason`, `BotTurnDecision`, `BotTurnInput`, `BotDecider`, `SILENT_UNAVAILABLE_REASONS: ReadonlySet<UnavailableReason>`, `stubDecider: BotDecider`. `BotTurnInput` is `{ workspaceId: string; conversationId: string }` in this slice — Part 2's `runBotTurn` is the only caller and needs nothing richer until spec 2 adds retrieval and spec 4 adds tool budgets.

This is a pure types-and-one-function file — no `Tx`, no I/O, no test file of its own beyond a type-level check exercised by every later task that imports it.

- [ ] **Step 1: Write the file**

```ts
// backend/src/domain/bot/botTurn.ts

/**
 * Both members are spec 4's to produce (a real decider never runs here). Declared
 * here because the outcome they feed — `applyBotTurn`'s `handoff` shape — is built
 * in this slice, so a type that grew in the slice that consumes it would make that
 * slice a control-flow change rather than a one-function swap.
 */
export type HandoffReason = 'model' | 'turn_cap';

export type UnavailableReason =
  | 'not_provisioned' // admin has the bot switched off
  | 'not_implemented' // no decider exists yet — removed once a real one lands
  | 'error' // a turn failed after its retries were exhausted
  | 'timeout' // reserved for the tool-calling decider
  | 'invalid_response'; // reserved for the tool-calling decider

export type BotTurnDecision =
  | { kind: 'noop' }
  | { kind: 'answer'; reply: string; subintentId: string }
  | { kind: 'handoff'; reason: HandoffReason; subintentId: string | null }
  | { kind: 'unavailable'; reason: UnavailableReason };

export type BotTurnInput = {
  workspaceId: string;
  conversationId: string;
};

export type BotDecider = (input: BotTurnInput) => Promise<BotTurnDecision>;

/**
 * The scaffolding decider. `'not_implemented'` exists so a real decider's arrival
 * is a type error at this exact reference, forcing its removal rather than leaving
 * it reachable in production by accident.
 */
export const stubDecider: BotDecider = async () => ({
  kind: 'unavailable',
  reason: 'not_implemented',
});

/**
 * Two `unavailable` reasons are not incidents: an admin deliberately switched the
 * bot off, or no decider has been built yet. Every other reason gets an internal
 * note — see `applyBotTurn`.
 */
export const SILENT_UNAVAILABLE_REASONS: ReadonlySet<UnavailableReason> = new Set([
  'not_provisioned',
  'not_implemented',
]);
```

- [ ] **Step 2: Add the barrel export**

In `backend/src/domain/bot/index.ts`, add:

```ts
export * from './botTurn.ts';
```

(Read the existing file first — it currently re-exports `botConfig.ts` and `defaultPrompt.ts`; add this line alongside those, do not replace them.)

- [ ] **Step 3: Verify compilation**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/domain/bot/botTurn.ts backend/src/domain/bot/index.ts
git commit -m "feat(bot): add BotDecider seam, BotTurnDecision union, stubDecider"
```

---

### Task 4: Fixed-copy messages

**Files:**

- Create: `backend/src/domain/bot/messages.ts`
- Modify: `backend/src/domain/bot/index.ts`

**Interfaces:**

- Consumes: `UnavailableReason` from `./botTurn.ts`.
- Produces: `HANDOFF_PLAYER_MESSAGE: string`, `botFailureNote(reason: UnavailableReason): string`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/bot.messages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { botFailureNote, HANDOFF_PLAYER_MESSAGE } from '../src/domain/bot/messages.ts';

describe('bot copy', () => {
  it('is the fixed player-facing handoff string', () => {
    expect(HANDOFF_PLAYER_MESSAGE).toBe("You're being connected to our support team.");
  });

  it('embeds the reason in the internal failure note', () => {
    expect(botFailureNote('error')).toBe(
      'Bot could not respond (`error`). Handed off unclassified.',
    );
    expect(botFailureNote('timeout')).toBe(
      'Bot could not respond (`timeout`). Handed off unclassified.',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && pnpm vitest run tests/bot.messages.test.ts`
Expected: FAIL — `../src/domain/bot/messages.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/domain/bot/messages.ts
import type { UnavailableReason } from './botTurn.ts';

/**
 * Identical on every handoff, deliberate or failed — a crash must be
 * indistinguishable from a clean handoff to the player. A fixed constant, not
 * model output, so a rewritten prompt or a player's own injected instruction
 * cannot reach it.
 */
export const HANDOFF_PLAYER_MESSAGE = "You're being connected to our support team.";

/** The agent-only note for an `unavailable` outcome whose reason is not silent. */
export function botFailureNote(reason: UnavailableReason): string {
  return `Bot could not respond (\`${reason}\`). Handed off unclassified.`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && pnpm vitest run tests/bot.messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the barrel export**

In `backend/src/domain/bot/index.ts`, add:

```ts
export * from './messages.ts';
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain/bot/messages.ts backend/src/domain/bot/index.ts backend/tests/bot.messages.test.ts
git commit -m "feat(bot): add fixed handoff copy and internal failure note"
```

---

### Task 5: `assignOnHandoff` — deterministic least-loaded assignment

**Files:**

- Create: `backend/src/domain/bot/assignOnHandoff.ts`
- Modify: `backend/src/domain/bot/index.ts`
- Test: `backend/tests/bot.assignment.test.ts`

**Interfaces:**

- Consumes: `Tx` from `../../shared/db/withWorkspace.ts`; `agent`, `workspaceMember`, `conversation` from `../../shared/db/schema/index.ts`.
- Produces: `assignOnHandoff(tx: Tx, workspaceId: string): Promise<string | null>`.

Least-loaded: the active member of the workspace with the fewest conversations currently `assigned_agent_id`-ed to them in a **live** status (`open`, `awaiting_player`, `escalated` — not `resolved`, not `closed`, not `bot_active`, not `new`), ties broken by `agent.id` ascending. Active means `workspace_member.deactivated_at IS NULL AND agent.status = 'active'`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/bot.assignment.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { assignOnHandoff } from '../src/domain/bot/assignOnHandoff.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { closeDb } from '../src/shared/db/client.ts';
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

beforeEach(truncateAll);
afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

async function assignConversationTo(
  conversationId: string,
  agentId: string,
  status = 'open',
): Promise<void> {
  await ownerPool.query(
    `update conversation set assigned_agent_id = $2, status = $3 where id = $1`,
    [conversationId, agentId, status],
  );
}

describe('assignOnHandoff', () => {
  it('picks the active member with fewest live-status conversations', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const busyAgent = await seedAgent();
    const idleAgent = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: busyAgent });
    await seedWorkspaceMember({ workspaceId, agentId: idleAgent });

    const busyConvo = await seedConversation({ workspaceId, playerId });
    await assignConversationTo(busyConvo, busyAgent, 'open');

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBe(idleAgent);
  });

  it('breaks ties by agent.id ascending', async () => {
    const workspaceId = await seedWorkspace();
    const agentLow = await seedAgent('a-low@example.test');
    const agentHigh = await seedAgent('a-high@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: agentLow });
    await seedWorkspaceMember({ workspaceId, agentId: agentHigh });

    const [lo, hi] = [agentLow, agentHigh].sort();
    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBe(lo);
    expect(result).not.toBe(hi);
  });

  it('skips a deactivated workspace member', async () => {
    const workspaceId = await seedWorkspace();
    const deactivated = await seedAgent();
    const active = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: deactivated, deactivatedAt: new Date() });
    await seedWorkspaceMember({ workspaceId, agentId: active });

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBe(active);
  });

  it('skips an agent whose status is not active', async () => {
    const workspaceId = await seedWorkspace();
    const onLeave = await seedAgent();
    const active = await seedAgent();
    await ownerPool.query(`update agent set status = 'on_leave' where id = $1`, [onLeave]);
    await seedWorkspaceMember({ workspaceId, agentId: onLeave });
    await seedWorkspaceMember({ workspaceId, agentId: active });

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBe(active);
  });

  it('includes admins and team leads', async () => {
    const workspaceId = await seedWorkspace();
    const admin = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: admin, role: 'admin' });

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBe(admin);
  });

  it('returns null, not an error, when no active agent exists', async () => {
    const workspaceId = await seedWorkspace();
    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBeNull();
  });

  it('never picks an agent from another workspace', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const agentB = await seedAgent();
    await seedWorkspaceMember({ workspaceId: workspaceB, agentId: agentB });

    const result = await withWorkspace(workspaceA, (tx) => assignOnHandoff(tx, workspaceA));
    expect(result).toBeNull();
  });

  it('only counts open, awaiting_player, escalated as live — not resolved or closed', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentA = await seedAgent();
    const agentB = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: agentA });
    await seedWorkspaceMember({ workspaceId, agentId: agentB });

    // agentA has two RESOLVED conversations — should not count against them.
    const c1 = await seedConversation({ workspaceId, playerId });
    const c2 = await seedConversation({ workspaceId, playerId });
    await assignConversationTo(c1, agentA, 'resolved');
    await assignConversationTo(c2, agentA, 'closed');

    // agentB has one OPEN conversation — should count.
    const c3 = await seedConversation({ workspaceId, playerId });
    await assignConversationTo(c3, agentB, 'open');

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBe(agentA);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && pnpm vitest run tests/bot.assignment.test.ts`
Expected: FAIL — `../src/domain/bot/assignOnHandoff.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/domain/bot/assignOnHandoff.ts
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { agent, conversation, workspaceMember } from '../../shared/db/schema/index.ts';

const LIVE_STATUSES = ['open', 'awaiting_player', 'escalated'] as const;

/**
 * Deterministic least-loaded, not round-robin — see the deviation recorded in
 * docs/decisions/spec-contradictions.md. Ties break by agent.id ascending, which
 * is what makes this testable without controlling a rotation cursor's starting
 * position. Returns null when no active agent exists; that is not an error.
 */
export async function assignOnHandoff(tx: Tx, workspaceId: string): Promise<string | null> {
  const rows = await tx
    .select({
      agentId: agent.id,
      liveCount: sql<number>`count(${conversation.id}) filter (where ${inArray(conversation.status, [...LIVE_STATUSES])})`,
    })
    .from(workspaceMember)
    .innerJoin(agent, eq(agent.id, workspaceMember.agentId))
    .leftJoin(
      conversation,
      and(eq(conversation.assignedAgentId, agent.id), eq(conversation.workspaceId, workspaceId)),
    )
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        isNull(workspaceMember.deactivatedAt),
        eq(agent.status, 'active'),
      ),
    )
    .groupBy(agent.id)
    .orderBy(
      sql`count(${conversation.id}) filter (where ${inArray(conversation.status, [...LIVE_STATUSES])}) asc`,
      asc(agent.id),
    )
    .limit(1);

  return rows[0]?.agentId ?? null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && pnpm vitest run tests/bot.assignment.test.ts`
Expected: PASS, all eight tests.

- [ ] **Step 5: Add the barrel export**

In `backend/src/domain/bot/index.ts`, add:

```ts
export * from './assignOnHandoff.ts';
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain/bot/assignOnHandoff.ts backend/src/domain/bot/index.ts backend/tests/bot.assignment.test.ts
git commit -m "feat(bot): add deterministic least-loaded assignOnHandoff"
```

---

### Task 6: Widen `PostMessageInput.actorId` to `string | null`

**Files:**

- Modify: `backend/src/domain/conversations/postMessage.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `PostMessageInput.actorId: string | null` (was `string`). `postMessage` already passes `actorId` straight to `appendEvent`, whose `EventInput.actorId` is already `string | null | undefined` — no change needed there.

A `system` message (the handoff and unavailable outcomes both post one) has no player and no agent behind it. Every existing caller (`sendPlayerMessage`, `sendAgentMessage`, wherever else `postMessage` is called) passes a real string today and is unaffected by the widened type.

- [ ] **Step 1: Confirm no test currently asserts `actorId` is non-nullable**

Run: `cd backend && grep -rn "actorId" tests/`
Expected: existing call sites pass a string literal or a seeded id; none assert the type is narrower than `string | null`. If one does, note it and adjust in this step rather than skip it.

- [ ] **Step 2: Widen the type**

In `backend/src/domain/conversations/postMessage.ts`, change:

```ts
/** The player id or agent id behind this send — recorded on the event, not the message row. */
actorId: string;
```

to:

```ts
/**
 * The player id or agent id behind this send — recorded on the event, not the
 * message row. Null for a `system` message: it has no player and no agent
 * behind it, and inventing a sentinel actor id would put a fictional uuid in
 * the reporting spine.
 */
actorId: string | null;
```

- [ ] **Step 3: Verify existing callers still typecheck**

Run: `pnpm typecheck`
Expected: PASS — widening a parameter type is backward-compatible with every existing string-passing call site.

- [ ] **Step 4: Run the existing message-posting tests**

Run: `cd backend && pnpm vitest run tests/surface.messages.test.ts tests/agent.messages.test.ts`

(If `agent.messages.test.ts` does not exist under that exact name, run `pnpm vitest run tests/` filtered to whatever file(s) currently cover `sendAgentMessage`/`postMessage` — find them with `grep -rl "postMessage" backend/tests/` first.)

Expected: PASS, unchanged.

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/conversations/postMessage.ts
git commit -m "feat(conversations): widen PostMessageInput.actorId to string | null for system messages"
```

---

### Task 7: `applyBotTurn` — all four outcomes

**Files:**

- Create: `backend/src/domain/bot/applyBotTurn.ts`
- Modify: `backend/src/domain/bot/index.ts`
- Test: `backend/tests/bot.turnSeam.test.ts`

**Interfaces:**

- Consumes: `BotTurnDecision`, `SILENT_UNAVAILABLE_REASONS` from `./botTurn.ts`; `HANDOFF_PLAYER_MESSAGE`, `botFailureNote` from `./messages.ts`; `assignOnHandoff` from `./assignOnHandoff.ts`; `postMessage`, `PostedMessageRow` from `../conversations/postMessage.ts`; `appendEvent` from `../../shared/events/appendEvent.ts`; `Tx` from `../../shared/db/withWorkspace.ts`; `conversation`, `subintent`, `intent` from `../../shared/db/schema/index.ts`.
- Produces:
  ```ts
  export type ApplyBotTurnContext = {
    workspaceId: string;
    conversationId: string;
  };
  export type ApplyBotTurnResult = {
    posted: PostedMessageRow[];
    statusChanged: boolean;
  };
  export async function applyBotTurn(
    tx: Tx,
    ctx: ApplyBotTurnContext,
    decision: BotTurnDecision,
  ): Promise<ApplyBotTurnResult>;
  ```
  Part 2's `runBotTurn` and this plan's `sendPlayerMessage` not-provisioned branch both call this signature — do not change it without updating both.

Outcome table (spec's, verbatim):

| `kind`        | Message(s)                                                       | Status             | Assign            | Classification        | Events                                      |
| ------------- | ---------------------------------------------------------------- | ------------------ | ----------------- | --------------------- | ------------------------------------------- |
| `noop`        | —                                                                | unchanged          | —                 | —                     | —                                           |
| `answer`      | `bot`, public                                                    | stays `bot_active` | —                 | set if NULL           | `intent_set` if written                     |
| `handoff`     | `system`, public                                                 | → `open`           | `assignOnHandoff` | set if NULL           | `intent_set` if written, then `bot_handoff` |
| `unavailable` | `system` public, **+** `system` internal unless reason is silent | → `open`           | `assignOnHandoff` | untouched, stays NULL | `bot_unavailable`                           |

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/bot.turnSeam.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyBotTurn } from '../src/domain/bot/applyBotTurn.ts';
import { HANDOFF_PLAYER_MESSAGE, botFailureNote } from '../src/domain/bot/messages.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { closeDb } from '../src/shared/db/client.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedIntent,
  seedPlayer,
  seedSubintent,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

beforeEach(truncateAll);
afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

async function conversationRow(id: string) {
  const { rows } = await ownerPool.query(
    `select status, assigned_agent_id, subintent_id, classification_source from conversation where id = $1`,
    [id],
  );
  return rows[0];
}

async function messagesFor(conversationId: string) {
  const { rows } = await ownerPool.query(
    `select author_type, visibility, body from message where conversation_id = $1 order by seq`,
    [conversationId],
  );
  return rows;
}

async function eventsFor(conversationId: string) {
  const { rows } = await ownerPool.query(
    `select type, payload from event where conversation_id = $1 order by id`,
    [conversationId],
  );
  return rows;
}

describe('applyBotTurn', () => {
  it('noop writes nothing', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'noop' }),
    );

    expect(await messagesFor(conversationId)).toEqual([]);
    expect(await eventsFor(conversationId)).toEqual([]);
    const row = await conversationRow(conversationId);
    expect(row.status).toBe('bot_active');
  });

  it('answer keeps bot_active, posts one public bot message, classifies once', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const intentId = await seedIntent(workspaceId, 'Billing');
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Refund' });

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(
        tx,
        { workspaceId, conversationId },
        { kind: 'answer', reply: 'Here is how refunds work.', subintentId },
      ),
    );

    const msgs = await messagesFor(conversationId);
    expect(msgs).toEqual([
      { author_type: 'bot', visibility: 'public', body: 'Here is how refunds work.' },
    ]);

    const row = await conversationRow(conversationId);
    expect(row.status).toBe('bot_active');
    expect(row.subintent_id).toBe(subintentId);
    expect(row.classification_source).toBe('bot');

    const events = await eventsFor(conversationId);
    expect(events.map((e) => e.type)).toEqual(['intent_set']);
    expect(events[0].payload).toMatchObject({
      source: 'bot',
      subintent_name: 'Refund',
      intent_name: 'Billing',
    });
  });

  it('a second answer does not reclassify or append a second intent_set', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const intentId = await seedIntent(workspaceId);
    const firstSubintent = await seedSubintent({ workspaceId, intentId });
    const secondSubintent = await seedSubintent({ workspaceId, intentId });

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(
        tx,
        { workspaceId, conversationId },
        { kind: 'answer', reply: 'first', subintentId: firstSubintent },
      ),
    );
    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(
        tx,
        { workspaceId, conversationId },
        { kind: 'answer', reply: 'second', subintentId: secondSubintent },
      ),
    );

    const row = await conversationRow(conversationId);
    expect(row.subintent_id).toBe(firstSubintent);

    const events = await eventsFor(conversationId);
    expect(events.filter((e) => e.type === 'intent_set').length).toBe(1);
  });

  it('handoff flips to open, posts one public system message, no internal note, assigns, appends bot_handoff', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const availableAgent = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: availableAgent });

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(
        tx,
        { workspaceId, conversationId },
        { kind: 'handoff', reason: 'model', subintentId: null },
      ),
    );

    const msgs = await messagesFor(conversationId);
    expect(msgs).toEqual([
      { author_type: 'system', visibility: 'public', body: HANDOFF_PLAYER_MESSAGE },
    ]);

    const row = await conversationRow(conversationId);
    expect(row.status).toBe('open');
    expect(row.assigned_agent_id).toBe(availableAgent);
    expect(row.subintent_id).toBeNull();

    const events = await eventsFor(conversationId);
    expect(events.map((e) => e.type)).toEqual(['bot_handoff']);
    expect(events[0].payload).toEqual({ reason: 'model' });
  });

  it('unavailable with a loud reason posts a public message and an internal note, appends bot_unavailable, no intent_set', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'unavailable', reason: 'error' }),
    );

    const msgs = await messagesFor(conversationId);
    expect(msgs).toEqual([
      { author_type: 'system', visibility: 'public', body: HANDOFF_PLAYER_MESSAGE },
      { author_type: 'system', visibility: 'internal', body: botFailureNote('error') },
    ]);

    const row = await conversationRow(conversationId);
    expect(row.status).toBe('open');
    expect(row.subintent_id).toBeNull();

    const events = await eventsFor(conversationId);
    expect(events.map((e) => e.type)).toEqual(['bot_unavailable']);
    expect(events[0].payload).toEqual({ reason: 'error' });
  });

  it.each(['not_provisioned', 'not_implemented'] as const)(
    'unavailable with silent reason %s posts no internal note but still appends bot_unavailable',
    async (reason) => {
      const workspaceId = await seedWorkspace();
      const playerId = await seedPlayer(workspaceId);
      const conversationId = await seedConversation({ workspaceId, playerId });

      await withWorkspace(workspaceId, (tx) =>
        applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'unavailable', reason }),
      );

      const msgs = await messagesFor(conversationId);
      expect(msgs).toEqual([
        { author_type: 'system', visibility: 'public', body: HANDOFF_PLAYER_MESSAGE },
      ]);

      const events = await eventsFor(conversationId);
      expect(events.map((e) => e.type)).toEqual(['bot_unavailable']);
      expect(events[0].payload).toEqual({ reason });
    },
  );

  it('no active agent leaves assigned_agent_id null but still flips status to open', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(
        tx,
        { workspaceId, conversationId },
        { kind: 'unavailable', reason: 'not_provisioned' },
      ),
    );

    const row = await conversationRow(conversationId);
    expect(row.status).toBe('open');
    expect(row.assigned_agent_id).toBeNull();
  });

  it('is atomic: an event-append failure rolls back the message and status change', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    // A conversation_id that cannot exist forces appendEvent's insert to violate
    // the FK inside the same transaction applyBotTurn runs its writes in — this
    // proves rollback without mocking anything.
    await expect(
      withWorkspace(workspaceId, async (tx) => {
        await applyBotTurn(
          tx,
          { workspaceId, conversationId: '00000000-0000-0000-0000-000000000000' },
          {
            kind: 'handoff',
            reason: 'model',
            subintentId: null,
          },
        );
      }),
    ).rejects.toThrow();

    const row = await conversationRow(conversationId);
    expect(row.status).toBe('bot_active');
    expect(await messagesFor(conversationId)).toEqual([]);
  });

  it('cross-tenant FK is refused by the database, not a handler', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const playerA = await seedPlayer(workspaceA);
    const conversationId = await seedConversation({ workspaceId: workspaceA, playerId: playerA });
    const intentB = await seedIntent(workspaceB);
    const subintentB = await seedSubintent({ workspaceId: workspaceB, intentId: intentB });

    await expect(
      withWorkspace(workspaceA, async (tx) => {
        await tx.execute(
          // Raw SQL: the point is proving the database's composite FK refuses this,
          // not that application code happens not to attempt it.
          require('drizzle-orm')
            .sql`update conversation set subintent_id = ${subintentB} where id = ${conversationId}`,
        );
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && pnpm vitest run tests/bot.turnSeam.test.ts`
Expected: FAIL — `../src/domain/bot/applyBotTurn.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/domain/bot/applyBotTurn.ts
import { eq, isNull } from 'drizzle-orm';
import type { BotTurnDecision } from './botTurn.ts';
import { SILENT_UNAVAILABLE_REASONS } from './botTurn.ts';
import { botFailureNote, HANDOFF_PLAYER_MESSAGE } from './messages.ts';
import { assignOnHandoff } from './assignOnHandoff.ts';
import { postMessage, type PostedMessageRow } from '../conversations/postMessage.ts';
import { appendEvent } from '../../shared/events/appendEvent.ts';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { conversation, intent, subintent } from '../../shared/db/schema/index.ts';

export type ApplyBotTurnContext = {
  workspaceId: string;
  conversationId: string;
};

export type ApplyBotTurnResult = {
  posted: PostedMessageRow[];
  statusChanged: boolean;
};

/**
 * The only writer of a bot-turn outcome. One transaction per call — the caller
 * (sendPlayerMessage's not-provisioned branch here; runBotTurn once Part 2
 * lands) owns that transaction via `tx`. Socket emits never happen in here —
 * only after the caller's transaction commits.
 */
export async function applyBotTurn(
  tx: Tx,
  ctx: ApplyBotTurnContext,
  decision: BotTurnDecision,
): Promise<ApplyBotTurnResult> {
  switch (decision.kind) {
    case 'noop':
      return { posted: [], statusChanged: false };

    case 'answer': {
      const posted = await postMessage(tx, {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        authorType: 'bot',
        actorId: null,
        body: decision.reply,
        visibility: 'public',
      });
      await classifyIfUnset(tx, ctx, decision.subintentId);
      return { posted: [posted], statusChanged: false };
    }

    case 'handoff': {
      const posted = await postMessage(tx, {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        authorType: 'system',
        actorId: null,
        body: HANDOFF_PLAYER_MESSAGE,
        visibility: 'public',
      });
      if (decision.subintentId) await classifyIfUnset(tx, ctx, decision.subintentId);
      const assignedAgentId = await assignOnHandoff(tx, ctx.workspaceId);
      await tx
        .update(conversation)
        .set({ status: 'open', assignedAgentId })
        .where(eq(conversation.id, ctx.conversationId));
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'bot_handoff',
        conversationId: ctx.conversationId,
        actorId: null,
        actorType: 'bot',
        payload: { reason: decision.reason },
      });
      return { posted: [posted], statusChanged: true };
    }

    case 'unavailable': {
      const posted = [
        await postMessage(tx, {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          authorType: 'system',
          actorId: null,
          body: HANDOFF_PLAYER_MESSAGE,
          visibility: 'public',
        }),
      ];
      if (!SILENT_UNAVAILABLE_REASONS.has(decision.reason)) {
        posted.push(
          await postMessage(tx, {
            workspaceId: ctx.workspaceId,
            conversationId: ctx.conversationId,
            authorType: 'system',
            actorId: null,
            body: botFailureNote(decision.reason),
            visibility: 'internal',
          }),
        );
      }
      const assignedAgentId = await assignOnHandoff(tx, ctx.workspaceId);
      await tx
        .update(conversation)
        .set({ status: 'open', assignedAgentId })
        .where(eq(conversation.id, ctx.conversationId));
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'bot_unavailable',
        conversationId: ctx.conversationId,
        actorId: null,
        actorType: 'bot',
        payload: { reason: decision.reason },
      });
      return { posted, statusChanged: true };
    }
  }
}

/**
 * Written once: only when subintent_id IS NULL. A second bot turn does not get
 * to reclassify — reclassification is the agent console's `intent_corrected`.
 * Snapshots both names as literals so a later rename does not rewrite history.
 */
async function classifyIfUnset(
  tx: Tx,
  ctx: ApplyBotTurnContext,
  subintentId: string,
): Promise<void> {
  const updated = await tx
    .update(conversation)
    .set({ subintentId, classificationSource: 'bot' })
    .where(eq(conversation.id, ctx.conversationId) && isNull(conversation.subintentId))
    .returning({ id: conversation.id });

  if (updated.length === 0) return;

  const [names] = await tx
    .select({ subintentName: subintent.name, intentName: intent.name })
    .from(subintent)
    .innerJoin(intent, eq(intent.id, subintent.intentId))
    .where(eq(subintent.id, subintentId))
    .limit(1);

  await appendEvent(tx, {
    workspaceId: ctx.workspaceId,
    type: 'intent_set',
    conversationId: ctx.conversationId,
    actorId: null,
    actorType: 'bot',
    payload: {
      source: 'bot',
      subintent_name: names?.subintentName ?? null,
      intent_name: names?.intentName ?? null,
    },
  });
}
```

**Note on the `where` clause above:** Drizzle's `and()` combinator, not JS `&&`, must combine two conditions — `eq(...) && isNull(...)` evaluates to the second operand in JS and silently drops the first. Import `and` from `drizzle-orm` and write `where: and(eq(conversation.id, ctx.conversationId), isNull(conversation.subintentId))`. Fix this before running the tests; it is called out here because it is exactly the kind of mistake this task's "classifies once" test is designed to catch — if you see that test pass without this fix, the test is wrong, not the code.

- [ ] **Step 4: Fix the `and()` bug and run the tests**

Update the import line to `import { and, eq, isNull } from 'drizzle-orm'` and the `where` clause to `and(eq(conversation.id, ctx.conversationId), isNull(conversation.subintentId))`.

Run: `cd backend && pnpm vitest run tests/bot.turnSeam.test.ts`
Expected: PASS, all nine tests (seven `it` + two from `it.each`).

- [ ] **Step 5: Add the barrel export**

In `backend/src/domain/bot/index.ts`, add:

```ts
export * from './applyBotTurn.ts';
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain/bot/applyBotTurn.ts backend/src/domain/bot/index.ts backend/tests/bot.turnSeam.test.ts
git commit -m "feat(bot): add applyBotTurn with all four outcomes as one transaction each"
```

---

### Task 8: `sendPlayerMessage` — `bot_active` default and the not-provisioned inline fallback

**Files:**

- Modify: `backend/src/surface/services/messagesService.ts`
- Modify: `backend/tests/surface.messages.test.ts`

**Interfaces:**

- Consumes: `applyBotTurn` from `../../domain/bot/index.ts`, `resolveBotConfig` from `../../domain/bot/index.ts` (already exported via `botConfig.ts`).
- Produces: no new exports — `sendPlayerMessage`'s external signature is unchanged. Internally, the function now computes a `shouldEnqueue: boolean` that this plan does **not** act on (see Global Constraints) — Part 2 adds the `if (shouldEnqueue) enqueueBotTurn(...)` call and the import it needs.

- [ ] **Step 1: Find and update the failing/changing tests in `surface.messages.test.ts`**

Run: `cd backend && grep -n "status.*open\|'bot_active'\|bot_active" tests/surface.messages.test.ts`

Find the existing assertion that a newly created conversation has `status: 'open'` (per the spec, this exact assertion must be **replaced**, not extended). Update it to:

```ts
it('creates a new conversation at bot_active, not open', async () => {
  // ...existing setup (workspace/player/token) unchanged...
  const res = await request(server.url)
    .post('/surface/messages')
    .set('Authorization', `Bearer ${playerToken}`)
    .send({ body: 'hi' })
    .expect(200);

  const { rows } = await ownerPool.query(`select status from conversation where id = $1`, [
    res.body.conversation_id,
  ]);
  expect(rows[0].status).toBe('bot_active');
});
```

Add a new test for the not-provisioned branch:

```ts
it('a not-provisioned bot hands off inline: open, assigned, one public system message, no internal note, one bot_unavailable event, no job', async () => {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const availableAgent = await seedAgent();
  await seedWorkspaceMember({ workspaceId, agentId: availableAgent });
  await seedBotConfig({ workspaceId, isProvisioned: false });
  const playerToken = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'p1',
  });

  const res = await request(server.url)
    .post('/surface/messages')
    .set('Authorization', `Bearer ${playerToken}`)
    .send({ body: 'hi' })
    .expect(200);

  const conversationId = res.body.conversation_id;

  const { rows: convRows } = await ownerPool.query(
    `select status, assigned_agent_id from conversation where id = $1`,
    [conversationId],
  );
  expect(convRows[0].status).toBe('open');
  expect(convRows[0].assigned_agent_id).toBe(availableAgent);

  const { rows: msgRows } = await ownerPool.query(
    `select author_type, visibility from message where conversation_id = $1 and author_type = 'system'`,
    [conversationId],
  );
  expect(msgRows.length).toBe(1);
  expect(msgRows[0].visibility).toBe('public');

  const { rows: eventRows } = await ownerPool.query(
    `select type, payload from event where conversation_id = $1 and type = 'bot_unavailable'`,
    [conversationId],
  );
  expect(eventRows.length).toBe(1);
  expect(eventRows[0].payload).toEqual({ reason: 'not_provisioned' });

  // Only the player's own message comes back in the response body.
  expect(res.body.message.body).toBe('hi');
});
```

(Read the existing top of `tests/surface.messages.test.ts` first for its exact import list and `request`/`mintToken`/`seedWorkspace` helper names — match them exactly; the snippets above assume the same helper names used elsewhere in this plan and in `tests/realtime.internalNote.test.ts`.)

- [ ] **Step 2: Run the tests to verify the new one fails and the changed one fails**

Run: `cd backend && pnpm vitest run tests/surface.messages.test.ts`
Expected: FAIL on both — creation still hardcodes `'open'`, and there is no not-provisioned branch yet.

- [ ] **Step 3: Remove the `status: 'open'` override and add the not-provisioned branch**

In `backend/src/surface/services/messagesService.ts`, add imports:

```ts
import { applyBotTurn, resolveBotConfig } from '../../domain/bot/index.ts';
```

Change the creation branch — remove the explicit `status: 'open'`:

```ts
const [created] = await tx
  .insert(conversation)
  .values({
    workspaceId: ctx.workspaceId,
    playerId: ctx.playerId,
    sessionId: latestSession?.id ?? null,
  })
  .returning({ id: conversation.id });
if (!created) throw new Error('conversation insert returned nothing');
conversationId = created.id;
inboxStatus = 'bot_active';
```

Add the gating logic after `postMessage`, before the `return { conversationId, posted, inboxStatus }` line. Track a `shouldEnqueue` local that this plan does not consume:

```ts
const posted = await postMessage(tx, {
  workspaceId: ctx.workspaceId,
  conversationId,
  authorType: 'player',
  actorId: ctx.playerId,
  body: body.body,
});

let shouldEnqueue = false;
const [afterPost] = await tx
  .select({ status: conversation.status })
  .from(conversation)
  .where(eq(conversation.id, conversationId))
  .limit(1);

if (afterPost?.status === 'bot_active') {
  const config = await resolveBotConfig(tx, ctx.workspaceId);
  if (config.isProvisioned) {
    // Part 2 (2026-08-12-bot-turn-async-pipeline.md) enqueues bot-turns here.
    shouldEnqueue = true;
  } else {
    await applyBotTurn(
      tx,
      { workspaceId: ctx.workspaceId, conversationId },
      { kind: 'unavailable', reason: 'not_provisioned' },
    );
    inboxStatus = 'open';
  }
}

return { conversationId, posted, inboxStatus, shouldEnqueue };
```

`shouldEnqueue` is deliberately unused past the transaction in this plan — it is present on the object `withWorkspace`'s callback returns, but nothing in `sendPlayerMessage` reads it, matching the "produces the value, does not consume it" boundary from Global Constraints. Do not add an `if (result.shouldEnqueue) ...` call; that line belongs to Part 2.

Leave the closing `return` of `sendPlayerMessage` unchanged — `const result = await withWorkspace(...)` already forwards the whole object, so `result.shouldEnqueue` exists for Part 2 to read without any further edit here. TypeScript does not warn on an unread object property the way it does on an unread local variable, so no destructuring or renaming is needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && pnpm vitest run tests/surface.messages.test.ts`
Expected: PASS, including both the updated creation test and the new not-provisioned test. Also re-run the reopen and `awaiting_player` tests in the same file to confirm they still land on `open` and are unaffected (they never reach the new `if (afterPost?.status === 'bot_active')` branch, since neither path leaves status at `bot_active`).

- [ ] **Step 5: Run the full backend suite to catch any other test hardcoding creation-at-`open`**

Run: `cd backend && pnpm test`
Expected: PASS. If any other test file asserted a fresh conversation starts at `'open'` (e.g. an agent-console test that seeds via the surface route rather than `seedConversation`), fix that assertion the same way as Step 1 — a new conversation starting at `bot_active` is this plan's whole point, and it should surface here rather than be missed.

- [ ] **Step 6: Commit**

```bash
git add backend/src/surface/services/messagesService.ts backend/tests/surface.messages.test.ts
git commit -m "feat(bot): sendPlayerMessage creates at bot_active and resolves not-provisioned inline"
```

---

### Task 9: Extend `realtime.internalNote.test.ts` for a bot-authored note

**Files:**

- Modify: `backend/tests/realtime.internalNote.test.ts`

**Interfaces:**

- Consumes: `applyBotTurn`, `withWorkspace`, existing realtime test helpers (`connectClient`, `startRealtimeServer`).

The existing file proves an _agent_-authored internal note never reaches `conv:{id}:player`. This task proves the same guarantee for the bot's failure note, going through `applyBotTurn` → `emitMessageToRooms` rather than the HTTP route (since there is no route here — this plan performs the emit itself is not correct either; **`applyBotTurn` never emits**, so the realistic path to test is: call `applyBotTurn` in a transaction, then call `emitMessageToRooms` with the returned `posted` messages, the same way `sendPlayerMessage`'s not-provisioned branch will after commit). This mirrors Task 8's production code path exactly.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe('internal notes never reach the player room', …)` block in `backend/tests/realtime.internalNote.test.ts`:

```ts
it('a bot unavailable outcome posts an internal note that never reaches conv:{id}:player', async () => {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({ workspaceId, playerId });

  const playerToken = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'p1',
  });
  const playerSocket = connectClient(server.url, { token: playerToken, role: 'player' });
  await waitFor(playerSocket, 'connect');
  await new Promise<boolean>((resolve) =>
    playerSocket.emit('join_conversation', { conversation_id: conversationId }, resolve),
  );

  const playerReceived: unknown[] = [];
  playerSocket.on('message:new', (payload: unknown) => playerReceived.push(payload));

  const { applyBotTurn } = await import('../src/domain/bot/applyBotTurn.ts');
  const { withWorkspace } = await import('../src/shared/db/withWorkspace.ts');
  const { toAgentView, toPlayerView } = await import('../src/domain/conversations/index.ts');
  const { emitMessageToRooms } = await import('../src/shared/realtime/emit.ts');
  const { getIo } = await import('../src/shared/realtime/socketServer.ts');

  const { posted } = await withWorkspace(workspaceId, (tx) =>
    applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'unavailable', reason: 'error' }),
  );
  for (const msg of posted) {
    emitMessageToRooms(getIo(), conversationId, toPlayerView(msg), toAgentView(msg));
  }

  await new Promise((resolve) => setTimeout(resolve, 150));

  // Two messages were posted (public handoff + internal note); only the
  // public one may reach the player.
  expect(playerReceived.length).toBe(1);
  playerSocket.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && pnpm vitest run tests/realtime.internalNote.test.ts`
Expected: FAIL (or errors) until `applyBotTurn` exists — this task runs after Task 7, so it should already exist; if this test fails for a different reason (e.g. `toPlayerView` not filtering internal messages), that is a real bug to fix, not a task-ordering issue, since `toPlayerView`/`toAgentView` predate this plan entirely.

- [ ] **Step 3: Run again to confirm it passes**

Run: `cd backend && pnpm vitest run tests/realtime.internalNote.test.ts`
Expected: PASS. If it does not, the bug is in `toPlayerView`'s existing whitelist, not in anything this plan added — investigate via `backend/src/domain/conversations/serializers.ts` before changing this test's expectations.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/realtime.internalNote.test.ts
git commit -m "test(realtime): extend internal-note guard to a bot-authored failure note"
```

---

### Task 10: Full-suite verification and typecheck

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole workspace**

Run: `pnpm typecheck`
Expected: PASS with zero errors.

- [ ] **Step 2: Run the full backend suite**

Run: `pnpm test`
Expected: PASS. Postgres and Redis must be up (`docker compose up -d`) first.

- [ ] **Step 3: Confirm the OpenAPI doc did not silently need an update**

This plan adds no new route and no new Zod schema — `sendPlayerMessage`'s request/response shape is unchanged. Run `grep -n "surface/messages" backend/src/docs/openapi.ts` to confirm the existing entry needs no edit, and note in the commit message if it somehow does.

- [ ] **Step 4: Commit (if Step 3 required a change; otherwise this task has nothing to commit)**

---

## Self-Review Notes

**Spec coverage:** Every "In scope" row in the spec's table is covered by a task here except the two rows Part 2 owns (`bot-turns` BullMQ queue + worker, `runBotTurn`). `subintent_id`/composite FK → Task 1. `sendPlayerMessage` creates at `bot_active` → Task 8. Synchronous not-provisioned fallback → Task 8. `SILENT_UNAVAILABLE_REASONS` → Task 3. `BotDecider`/`stubDecider` → Task 3. `applyBotTurn` four outcomes → Task 7. `assignOnHandoff` → Task 5. Player/agent messages → Task 4. Three event types → Task 7. `actorId` widening → Task 6.

**Known gap surfaced during exploration, not a task omission:** the spec's §Design decisions text says `conversation` "already carries its own `UNIQUE (workspace_id, id)` from the forms slice" — that unique key does not exist in the current schema (the forms slice hasn't landed). It is irrelevant to this plan: the new composite FK's parent key lives on `subintent`, not `conversation`, so nothing here depends on the missing key. Flagging it here rather than silently building around it.

**Judgment calls made, for the plan's reviewer:**

- `BotTurnInput` is minimal (`{workspaceId, conversationId}`) since no consumer needing more exists until Part 2/spec 2/spec 4.
- The composite FK is the first one in the codebase; Task 1 spells out Drizzle's `foreignKey()` syntax explicitly rather than pointing at a nonexistent precedent.
- Task 9's test reaches into `applyBotTurn` + manual `emitMessageToRooms` rather than through an HTTP route, because no route triggers a bot `unavailable` outcome by itself yet outside `sendPlayerMessage`'s not-provisioned branch (already covered end-to-end in Task 8) — this test exists specifically to pin the realtime-room guarantee at the `applyBotTurn` output layer, which is where Part 2's orchestrator will also plug in.
