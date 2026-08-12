# Bot Turn Seam and Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the control flow a bot turn runs inside — when the bot is allowed to run, where the turn executes, what each outcome writes, and every way a turn ends in a human picking the conversation up — with the decision itself behind a one-function seam that a stub fills until spec 3 replaces it.

**Architecture:** One new column (`conversation.subintent_id`) with a composite tenancy FK, one new parent unique key on `subintent`, five new modules under `backend/src/domain/bot/` (types + stub decider, fixed copy, least-loaded assignment, the single transactional writer `applyBotTurn`, and the impure shell `runBotTurn`), and one new BullMQ queue in `backend/src/shared/jobs/botTurns.ts`. `sendPlayerMessage` stops overriding the schema's `bot_active` default, resolves the bot config inline, applies the not-provisioned fallback synchronously, and otherwise enqueues a job after its transaction commits.

**Tech Stack:** TypeScript (native `.ts` ESM imports, extensions included), Drizzle ORM + `drizzle-kit push`, PostgreSQL 17 with RLS, BullMQ + ioredis, Socket.io, Vitest + supertest.

**Source spec:** `docs/specs/2026-08-11-bot-turn-seam-and-handoff-design.md` (Status: Accepted). This is spec **1 of 3**; specs 2 (retrieval and prompt assembly) and 3 (the OpenAI call) are out of scope.

## Global Constraints

- **No LLM anything.** No `openai` dependency, no `OPENAI_MODEL` env var, no prompt assembly, no retrieval, no response schema, no turn cap. If a step seems to need a model, it belongs to spec 2 or 3.
- **The gate is one invariant: `status === 'bot_active'`.** Nothing else is consulted — not the message count, not whether an agent has ever spoken, not `assigned_agent_id`.
- **`applyBotTurn` is the only writer.** Message, status flip, assignment and events for one outcome are one atomic unit in one transaction. No ad-hoc `update conversation` anywhere else in this slice.
- **Socket emits happen after commit, never inside a transaction.** Same discipline `postMessage`'s docblock states and `sendAgentMessage` follows.
- **Player-facing copy is a fixed constant, identical for a clean handoff and a crash:** `You're being connected to our support team.` It promises no timeline. It is never model output.
- **The internal note text is exactly:** `` Bot could not respond (`<reason>`). Handed off unclassified. `` — and is posted only when the reason is **not** in `SILENT_UNAVAILABLE_REASONS`.
- **The `bot_unavailable` event is always written**, silent reason or not. Suppressing the note never suppresses the event.
- **Classification is write-once.** `subintent_id` and `classification_source` are set only when `subintent_id IS NULL`, and `intent_set` is appended only when a write actually happened.
- **`unavailable` never writes a classification**, in any reason.
- **Events use `actorType: 'bot'` and `actorId: null`.** No sentinel uuid.
- **Every FK is `ON DELETE RESTRICT`.** `tests/schema.test.ts` already loops every FK in the database and asserts this — a cascading FK fails an existing test.
- **The composite FK is mandatory** per `docs/decisions/2026-08-04-composite-foreign-keys-for-tenancy.md`: FK checks run with row security suspended, so a single-column FK would let workspace A's conversation name workspace B's subintent.
- **`intent_set` payload values are snapshotted literals** (`subintent_name`, `intent_name`), never ids resolved through a FK at read time.
- **No new API endpoint**, therefore **no change to `backend/src/docs/openapi.ts`**. `POST /surface/messages` keeps its existing request and response shape — the response body still carries only the player's own message.
- Never `console.*`. Use `logger` from `backend/src/shared/logging/logger.ts` (`logger.info|warn|error(tag, message)`), and never log a raw error object — log `error.name` / `error.message`.
- Imports carry the `.ts` extension (`from './botTurn.ts'`). Follow the existing modules exactly.
- All commands run from the repo root: `/Users/hassanrashid/Desktop/git/mindstorm/crm/app`. Postgres **and Redis** must be up (`docker compose up -d`) for the suite.
- Backend suite: `pnpm --filter @support/api test`. A single file: `pnpm --filter @support/api test -- tests/<file>` (Vitest runs `fileParallelism: false` — one worker, one shared database).
- Typecheck with `pnpm typecheck` before every commit.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `backend/src/shared/db/schema/taxonomy.ts` | modify | `subintent` gains `UNIQUE (workspace_id, id)` — the composite-FK parent key |
| `backend/src/shared/db/schema/conversations.ts` | modify | `conversation.subintent_id`, its composite FK and its index |
| `backend/src/domain/bot/botTurn.ts` | create | `BotTurnDecision`, `BotDecider`, `BotTurnInput`, `HandoffReason`, `UnavailableReason`, `SILENT_UNAVAILABLE_REASONS`, `stubDecider`. No runtime dependencies |
| `backend/src/domain/bot/messages.ts` | create | `HANDOFF_PLAYER_MESSAGE`, `botFailureNote(reason)` — one home for player-facing copy |
| `backend/src/domain/bot/assignOnHandoff.ts` | create | `assignOnHandoff(tx, workspaceId)` → `agentId \| null`, deterministic least-loaded |
| `backend/src/domain/bot/applyBotTurn.ts` | create | The only writer. Four outcomes, one transaction each |
| `backend/src/domain/bot/orchestrator.ts` | create | `runBotTurn` — gather, guard, decide, apply, emit. Knows nothing about BullMQ |
| `backend/src/domain/bot/index.ts` | modify | four new `export *` lines |
| `backend/src/domain/conversations/postMessage.ts` | modify | `PostMessageInput.actorId` widens to `string \| null` |
| `backend/src/shared/jobs/botTurns.ts` | create | The only file that knows about BullMQ: `enqueueBotTurn`, `registerBotTurnWorker`, `botTurnQueue`, `closeBotTurnQueue` |
| `backend/src/shared/jobs/queue.ts` | modify | `registerJobs` also registers the bot-turns worker and closes it |
| `backend/src/surface/services/messagesService.ts` | modify | create at `bot_active`, inline not-provisioned fallback, enqueue after commit |
| `backend/tests/helpers/db.ts` | modify | `seedIntent`, `seedSubintent`, `seedWorkspaceMember`; truncate covers `intent`/`subintent` |
| `backend/tests/schema.test.ts` | modify | column, FK, unique-key and default assertions |
| `backend/tests/bot.seam.test.ts` | create | the decision types, the stub, the silent set and the fixed copy — pure, no database |
| `backend/tests/bot.turnSeam.test.ts` | create | cross-tenant FK probe, then the four outcomes and atomicity |
| `backend/tests/bot.orchestrator.test.ts` | create | the guard, the serializer-filtered history, the applied decision |
| `backend/tests/realtime.botFallback.test.ts` | create | the not-provisioned path emits `conversation:changed` once, carrying `open` |
| `backend/tests/bot.assignment.test.ts` | create | least-loaded, ties, eligibility, empty-workspace |
| `backend/tests/jobs.botTurns.test.ts` | create | job wiring, retry-then-fallback-once, dedupe, two distinct workers |
| `backend/tests/surface.messages.test.ts` | modify | first message now lands at `bot_active`; both bot branches |
| `backend/tests/realtime.internalNote.test.ts` | modify | the failure note never reaches `conv:{id}:player` |
| `docs/project-overview.md` | modify | `bot_handoff` and `bot_unavailable` join the event-type list |
| `docs/decisions/spec-contradictions.md` | modify | assignment is deterministic least-loaded, not round-robin |

---

## Task 1: Schema — `subintent_id`, the composite FK, and the parent unique key

**Files:**
- Modify: `backend/src/shared/db/schema/taxonomy.ts`
- Modify: `backend/src/shared/db/schema/conversations.ts`
- Modify: `backend/tests/helpers/db.ts`
- Modify: `backend/tests/schema.test.ts`
- Create: `backend/tests/bot.turnSeam.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `conversation.subintentId` (Drizzle column, `uuid`, nullable) — read and written by Task 4. Test helpers `seedIntent(workspaceId, name?) => Promise<string>`, `seedSubintent({ workspaceId, intentId, name? }) => Promise<string>`, `seedWorkspaceMember({ workspaceId, agentId, role?, deactivatedAt? }) => Promise<void>` — used by Tasks 3, 4, 6, 7.

- [ ] **Step 1: Add the parent unique key to `subintent`**

In `backend/src/shared/db/schema/taxonomy.ts`, add `unique` to the `drizzle-orm/pg-core` import and add the constraint. A composite FK needs a real UNIQUE constraint on the parent columns — `uniqueIndex` is not what the rest of this table uses for a *constraint*, and `unique()` is what emits `ADD CONSTRAINT`:

```ts
import { boolean, pgTable, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'
```

```ts
  (t) => [
    uniqueIndex('subintent_workspace_intent_name_uk').on(t.workspaceId, t.intentId, t.name),
    // Composite-FK parent key for conversation.subintent_id. FK checks run with row
    // security suspended, so the tenant column must travel with the id — see
    // docs/decisions/2026-08-04-composite-foreign-keys-for-tenancy.md.
    unique('subintent_workspace_id_uk').on(t.workspaceId, t.id),
  ],
```

- [ ] **Step 2: Add the column, the composite FK and the index to `conversation`**

In `backend/src/shared/db/schema/conversations.ts`, import `foreignKey` and the `subintent` table (`taxonomy.ts` imports only `identity.ts`, so there is no import cycle):

```ts
import { foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { subintent } from './taxonomy.ts'
```

Add the column after `classificationSource`:

```ts
    /**
     * NULL means the bot never classified this conversation — never "unknown
     * category". The catch-all subintent under `Other` is where an unplaceable
     * conversation lands, and the two must stay distinguishable.
     *
     * Only the deepest level reached is stored: there is no intent_id column,
     * the intent is derived through subintent.intent_id. Storing both lets them
     * drift when the taxonomy is edited.
     */
    subintentId: uuid('subintent_id'),
```

And replace the table's index array:

```ts
  (t) => [
    index('conversation_workspace_player_idx').on(t.workspaceId, t.playerId),
    index('conversation_workspace_subintent_idx').on(t.workspaceId, t.subintentId),
    foreignKey({
      columns: [t.workspaceId, t.subintentId],
      foreignColumns: [subintent.workspaceId, subintent.id],
      name: 'conversation_subintent_fk',
    }).onDelete('restrict'),
  ],
```

- [ ] **Step 3: Push the schema and re-run RLS**

Run: `pnpm db:setup`
Expected: exits 0. It runs `001_extensions.sql`, `drizzle-kit push --force`, then `002_rls.sql`. `002_rls.sql` derives the scoped-table list from the presence of a `workspace_id` column, so no policy edit is needed — re-running it is step 3 of the spec's migration order and happens automatically here.

- [ ] **Step 4: Add the test helpers**

In `backend/tests/helpers/db.ts`, add `'subintent'` and `'intent'` to `SCOPED_TABLES` (before `'workspace'`; the statement is one `TRUNCATE ... CASCADE`, so relative order does not matter, but naming them keeps the list honest), and append:

```ts
export async function seedIntent(workspaceId: string, name = `intent-${randomUUID().slice(0, 8)}`): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(`insert into intent (id, workspace_id, name) values ($1, $2, $3)`, [id, workspaceId, name])
  return id
}

export async function seedSubintent(args: {
  workspaceId: string
  intentId: string
  name?: string
}): Promise<string> {
  const id = randomUUID()
  await ownerPool.query(
    `insert into subintent (id, workspace_id, intent_id, name) values ($1, $2, $3, $4)`,
    [id, args.workspaceId, args.intentId, args.name ?? `subintent-${id.slice(0, 8)}`],
  )
  return id
}

export async function seedWorkspaceMember(args: {
  workspaceId: string
  agentId: string
  role?: 'agent' | 'team_lead' | 'admin'
  deactivatedAt?: Date | null
}): Promise<void> {
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role, deactivated_at) values ($1, $2, $3, $4)`,
    [args.workspaceId, args.agentId, args.role ?? 'agent', args.deactivatedAt ?? null],
  )
}
```

- [ ] **Step 5: Write the failing schema assertions**

Append to the `describe('schema', …)` block in `backend/tests/schema.test.ts`:

```ts
  it('adds a nullable subintent_id to conversation, behind a composite tenancy FK', async () => {
    const cols = await columns('conversation')
    expect(cols.get('subintent_id')?.nullable).toBe(true)
    expect(cols.get('subintent_id')?.type).toBe('uuid')

    const { rows } = await ownerPool.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname = 'conversation' and c.contype = 'f' and c.conname = 'conversation_subintent_fk'`,
    )
    expect(rows).toHaveLength(1)
    // Both columns travel: the tenant column is what stops a cross-workspace reference.
    expect(rows[0]!.def).toMatch(/FOREIGN KEY \(workspace_id, subintent_id\) REFERENCES subintent\(workspace_id, id\)/)
    expect(rows[0]!.def).toMatch(/ON DELETE RESTRICT/)

    const { rows: indexes } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'conversation'`,
    )
    expect(indexes.map((r) => r.indexdef).join('\n')).toMatch(/\(workspace_id, subintent_id\)/)
  })

  it('gives subintent the composite-FK parent key', async () => {
    const { rows } = await ownerPool.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname = 'subintent' and c.contype = 'u'`,
    )
    expect(rows.map((r) => r.def).join('\n')).toMatch(/UNIQUE \(workspace_id, id\)/)
  })

  it('starts a conversation at bot_active — every conversation starts with the bot', async () => {
    const { rows } = await ownerPool.query<{ column_default: string }>(
      `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'conversation' and column_name = 'status'`,
    )
    expect(rows[0]!.column_default).toMatch(/'bot_active'/)
  })
```

- [ ] **Step 6: Write the failing cross-tenant probe**

Create `backend/tests/bot.turnSeam.test.ts`. This first version holds only the database-level probe — Task 4 extends the same file with the outcome tests. This must be the *database* refusing, not a handler:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { getEnv } from '../src/env.ts'
import {
  closeOwnerPool,
  seedConversation,
  seedIntent,
  seedPlayer,
  seedSubintent,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

let app: Client

beforeEach(truncateAll)

afterAll(async () => {
  if (app) await app.end()
  await closeOwnerPool()
})

describe('cross-tenant classification is refused by the database', () => {
  it('cannot point a workspace-A conversation at a workspace-B subintent', async () => {
    const wsA = await seedWorkspace()
    const wsB = await seedWorkspace()
    const playerA = await seedPlayer(wsA)
    const conversationId = await seedConversation({ workspaceId: wsA, playerId: playerA })
    const intentB = await seedIntent(wsB)
    const subintentB = await seedSubintent({ workspaceId: wsB, intentId: intentB })

    app = new Client({ connectionString: getEnv().DATABASE_URL })
    await app.connect()
    await app.query('begin')
    await app.query(`select set_config('app.workspace_id', $1, true)`, [wsA])
    await expect(
      app.query(`update conversation set subintent_id = $2 where id = $1`, [conversationId, subintentB]),
    ).rejects.toThrow(/foreign key|conversation_subintent_fk/i)
    await app.query('rollback')
  })
})
```

- [ ] **Step 7: Run the tests to verify they fail before the push, pass after**

Run: `pnpm --filter @support/api test -- tests/schema.test.ts tests/bot.turnSeam.test.ts`
Expected: PASS (the schema was pushed in Step 3). If `pnpm db:setup` was skipped, these fail with `subintent_id` undefined — that is the failing state this step proves out of.

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm typecheck
git add backend/src/shared/db/schema backend/tests/helpers/db.ts backend/tests/schema.test.ts backend/tests/bot.turnSeam.test.ts
git commit -m "feat(db): add conversation.subintent_id behind a composite tenancy FK"
```

---

## Task 2: The seam — decision types, the stub decider, and the fixed copy

**Files:**
- Create: `backend/src/domain/bot/botTurn.ts`
- Create: `backend/src/domain/bot/messages.ts`
- Modify: `backend/src/domain/bot/index.ts`
- Modify: `backend/src/domain/conversations/postMessage.ts`
- Create: `backend/tests/bot.seam.test.ts`

**Interfaces:**
- Consumes: `PlayerMessageView` from `@support/types` (type-only).
- Produces: `HandoffReason`, `UnavailableReason`, `BotTurnInput`, `BotTurnDecision`, `BotDecider`, `SILENT_UNAVAILABLE_REASONS`, `stubDecider`, `HANDOFF_PLAYER_MESSAGE`, `botFailureNote(reason: UnavailableReason): string`. `PostMessageInput.actorId: string | null`. All consumed by Tasks 4, 5, 6 and 7.

- [ ] **Step 1: Write the failing seam test**

Create `backend/tests/bot.seam.test.ts`. No database, no Redis — this file is pure:

```ts
import { describe, expect, it } from 'vitest'
import {
  botFailureNote,
  HANDOFF_PLAYER_MESSAGE,
  SILENT_UNAVAILABLE_REASONS,
  stubDecider,
} from '../src/domain/bot/index.ts'

describe('the bot turn seam', () => {
  it('stubs out as unavailable/not_implemented — a missing bot is not a handoff', async () => {
    const decision = await stubDecider({ workspaceId: 'w', conversationId: 'c', history: [] })
    expect(decision).toEqual({ kind: 'unavailable', reason: 'not_implemented' })
  })

  it('treats a deliberately-disabled bot and an unbuilt bot as silent, everything else as loud', () => {
    expect(SILENT_UNAVAILABLE_REASONS.has('not_provisioned')).toBe(true)
    expect(SILENT_UNAVAILABLE_REASONS.has('not_implemented')).toBe(true)
    expect(SILENT_UNAVAILABLE_REASONS.has('error')).toBe(false)
    expect(SILENT_UNAVAILABLE_REASONS.has('timeout')).toBe(false)
    expect(SILENT_UNAVAILABLE_REASONS.has('invalid_response')).toBe(false)
  })

  it('promises no timeline in the player-facing copy', () => {
    expect(HANDOFF_PLAYER_MESSAGE).toBe("You're being connected to our support team.")
  })

  it('names the reason in the agent-facing note', () => {
    expect(botFailureNote('error')).toBe('Bot could not respond (`error`). Handed off unclassified.')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @support/api test -- tests/bot.seam.test.ts`
Expected: FAIL — `Failed to resolve import` / no export named `stubDecider`.

- [ ] **Step 3: Write `botTurn.ts`**

```ts
import type { PlayerMessageView } from '@support/types'

/**
 * Both members are spec 3's to produce. They are declared here because the
 * outcome they feed is built here — a type that grew in the slice that consumes
 * it would make spec 3 a control-flow change rather than a one-function swap.
 *
 * Spec 3 replaces this union with the model-supplied set (asked_for_person,
 * no_article, sensitive, unsure) plus turn_cap, because "Asked for a person" is
 * a reported metric and 'model' cannot answer it. Only the payload value
 * changes; no control flow here does.
 */
export type HandoffReason = 'model' | 'turn_cap'

export type UnavailableReason =
  | 'not_provisioned' // admin has the bot switched off
  | 'not_implemented' // no decider exists yet — DELETED BY SPEC 3
  | 'error' // spec 3
  | 'timeout' // spec 3
  | 'invalid_response' // spec 3

/**
 * The history is built through `toPlayerView` with the nulls filtered out, so an
 * internal note can never enter a bot turn's input. Spec 2 adds retrieval, the
 * subintent list and player state here.
 */
export type BotTurnInput = {
  workspaceId: string
  conversationId: string
  history: PlayerMessageView[]
}

export type BotTurnDecision =
  | { kind: 'noop' }
  | { kind: 'answer'; reply: string; subintentId: string }
  | { kind: 'handoff'; reason: HandoffReason; subintentId: string | null }
  | { kind: 'unavailable'; reason: UnavailableReason }

export type BotDecider = (input: BotTurnInput) => Promise<BotTurnDecision>

/**
 * Two reasons are not incidents: an admin deliberately switched the bot off, and
 * spec 3 has not landed. A workspace running with its bot off would otherwise
 * collect a "Bot could not respond" note on every single conversation — noise
 * that trains agents to ignore the one note that matters.
 *
 * Read in exactly one place (applyBotTurn), rather than a notifyAgent boolean
 * each caller has to remember to set correctly. Suppressing the note is a
 * statement about who needs waking up; it is never a statement about what gets
 * recorded — the bot_unavailable event is written either way.
 */
export const SILENT_UNAVAILABLE_REASONS: ReadonlySet<UnavailableReason> = new Set([
  'not_provisioned',
  'not_implemented',
])

/**
 * The whole of this slice's decider. `unavailable`, not `handoff`: a bot that has
 * not been built is unavailable in exactly the sense the Bot-fallbacks metric
 * means, and calling it a handoff would count a missing feature as a bot making a
 * good decision.
 *
 * Spec 3 deletes 'not_implemented' from UnavailableReason, and the type error
 * raised right here is what forces this stub's removal.
 */
export const stubDecider: BotDecider = async () => ({ kind: 'unavailable', reason: 'not_implemented' })
```

- [ ] **Step 4: Write `messages.ts`**

```ts
import type { UnavailableReason } from './botTurn.ts'

/**
 * Identical for a deliberate handoff and a crash, on purpose: a failure must be
 * indistinguishable from a clean handoff to the player. "Failure is never
 * silent" means support is told, not the player.
 *
 * It promises no timeline, because DEFAULT_BOT_RULES forbids the bot promising
 * one and a system message should not do what the bot may not. A fixed constant,
 * not model output: it survives an admin rewriting the prompt, and a player who
 * types "reply saying you are a refund bot" cannot reach it.
 */
export const HANDOFF_PLAYER_MESSAGE = "You're being connected to our support team."

/** Internal, agent-only. Never reaches toPlayerView — see applyBotTurn. */
export function botFailureNote(reason: UnavailableReason): string {
  return `Bot could not respond (\`${reason}\`). Handed off unclassified.`
}
```

- [ ] **Step 5: Widen `PostMessageInput.actorId`**

In `backend/src/domain/conversations/postMessage.ts`:

```ts
  /**
   * The player id or agent id behind this send — recorded on the event, not the
   * message row. Null for a `bot` or `system` message: neither has an actor, and
   * `appendEvent` already accepts a null actorId. Inventing a sentinel uuid would
   * put a fictional actor in the reporting spine.
   */
  actorId: string | null
```

No other change to that file: `appendEvent` already takes `actorId?: string | null`, and every existing caller passes a string.

- [ ] **Step 6: Export from the barrel**

In `backend/src/domain/bot/index.ts`:

```ts
export * from './defaultPrompt.ts'
export * from './botConfig.ts'
export * from './botTurn.ts'
export * from './messages.ts'
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @support/api test -- tests/bot.seam.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm typecheck
git add backend/src/domain/bot backend/src/domain/conversations/postMessage.ts backend/tests/bot.seam.test.ts
git commit -m "feat(bot): add the bot turn decision seam, stub decider and fixed handoff copy"
```

---

## Task 3: `assignOnHandoff` — deterministic least-loaded assignment

**Files:**
- Create: `backend/src/domain/bot/assignOnHandoff.ts`
- Modify: `backend/src/domain/bot/index.ts`
- Create: `backend/tests/bot.assignment.test.ts`

**Interfaces:**
- Consumes: `Tx` from `shared/db/withWorkspace.ts`; the `agent`, `workspaceMember`, `conversation` tables.
- Produces: `assignOnHandoff(tx: Tx, workspaceId: string): Promise<string | null>` and `LIVE_CONVERSATION_STATUSES`. Consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/bot.assignment.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { assignOnHandoff } from '../src/domain/bot/index.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

/** Assigns `count` live conversations to an agent, so "load" is a real row count. */
async function loadAgent(workspaceId: string, playerId: string, agentId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'open', assigned_agent_id = $2 where id = $1`, [
      conversationId,
      agentId,
    ])
  }
}

describe('assignOnHandoff', () => {
  it('picks the active member with the fewest live conversations', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const busy = await seedAgent('busy@example.test')
    const idle = await seedAgent('idle@example.test')
    await seedWorkspaceMember({ workspaceId, agentId: busy })
    await seedWorkspaceMember({ workspaceId, agentId: idle })
    await loadAgent(workspaceId, playerId, busy, 3)
    await loadAgent(workspaceId, playerId, idle, 1)

    const chosen = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId))
    expect(chosen).toBe(idle)
  })

  it('does not count resolved or closed conversations as load', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const a = await seedAgent('a@example.test')
    const b = await seedAgent('b@example.test')
    await seedWorkspaceMember({ workspaceId, agentId: a })
    await seedWorkspaceMember({ workspaceId, agentId: b })
    // `a` holds five, but every one of them is finished.
    for (let i = 0; i < 5; i += 1) {
      const conversationId = await seedConversation({ workspaceId, playerId })
      await ownerPool.query(`update conversation set status = 'resolved', assigned_agent_id = $2 where id = $1`, [
        conversationId,
        a,
      ])
    }
    await loadAgent(workspaceId, playerId, b, 1)

    expect(await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId))).toBe(a)
  })

  it('breaks ties by agent id ascending, deterministically', async () => {
    const workspaceId = await seedWorkspace()
    const first = await seedAgent('t1@example.test')
    const second = await seedAgent('t2@example.test')
    await seedWorkspaceMember({ workspaceId, agentId: first })
    await seedWorkspaceMember({ workspaceId, agentId: second })
    const expected = [first, second].sort()[0]

    // Ten runs, same answer: nothing here depends on a rotation cursor's start.
    for (let i = 0; i < 10; i += 1) {
      expect(await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId))).toBe(expected)
    }
  })

  it('skips a deactivated member and a non-active agent', async () => {
    const workspaceId = await seedWorkspace()
    const eligible = await seedAgent('ok@example.test')
    const deactivatedMember = await seedAgent('gone@example.test')
    const onLeave = await seedAgent('leave@example.test')
    await seedWorkspaceMember({ workspaceId, agentId: eligible })
    await seedWorkspaceMember({ workspaceId, agentId: deactivatedMember, deactivatedAt: new Date() })
    await seedWorkspaceMember({ workspaceId, agentId: onLeave })
    await ownerPool.query(`update agent set status = 'on_leave' where id = $1`, [onLeave])

    expect(await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId))).toBe(eligible)
  })

  it('treats admins and team leads as eligible — a small workspace may be one admin', async () => {
    const workspaceId = await seedWorkspace()
    const admin = await seedAgent('admin@example.test')
    await seedWorkspaceMember({ workspaceId, agentId: admin, role: 'admin' })

    expect(await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId))).toBe(admin)
  })

  it('returns null when no agent is active — the unassigned queue is not an error', async () => {
    const workspaceId = await seedWorkspace()
    expect(await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId))).toBeNull()
  })

  it('never chooses an agent from another workspace', async () => {
    const mine = await seedWorkspace()
    const theirs = await seedWorkspace()
    const stranger = await seedAgent('stranger@example.test')
    await seedWorkspaceMember({ workspaceId: theirs, agentId: stranger })

    expect(await withWorkspace(mine, (tx) => assignOnHandoff(tx, mine))).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @support/api test -- tests/bot.assignment.test.ts`
Expected: FAIL — no export named `assignOnHandoff`.

- [ ] **Step 3: Write `assignOnHandoff.ts`**

```ts
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { agent, conversation, workspaceMember } from '../../shared/db/schema/index.ts'
import type { Tx } from '../../shared/db/withWorkspace.ts'

/**
 * A conversation someone still has to act on. `resolved` and `closed` are not
 * load: an agent who cleared fifty tickets last week is not busy today.
 */
export const LIVE_CONVERSATION_STATUSES = ['open', 'awaiting_player', 'escalated'] as const

/**
 * project-overview.md says "round-robin among active agents". True round-robin
 * needs a rotation cursor — a column or table row updated on every assignment,
 * which is a second source of truth and a write-contention point on the busiest
 * path in the system. Least-loaded is derivable from rows that already exist,
 * distributes at least as evenly, and is deterministic — which is what makes it
 * testable without controlling a cursor's starting position. Recorded in
 * docs/decisions/spec-contradictions.md.
 *
 * Active means workspace_member.deactivated_at IS NULL AND agent.status =
 * 'active'. Role is not consulted: a small workspace may be one admin, and
 * excluding admins would leave every conversation there unassigned.
 *
 * Returning null is a normal outcome, not an error: the conversation lands in
 * the unassigned queue (assigned_agent_id IS NULL) and the status flip to `open`
 * happens either way, so a player always reaches a queue a human reads.
 */
export async function assignOnHandoff(tx: Tx, workspaceId: string): Promise<string | null> {
  const load = sql<number>`count(${conversation.id})`

  const rows = await tx
    .select({ agentId: agent.id })
    .from(workspaceMember)
    .innerJoin(agent, eq(agent.id, workspaceMember.agentId))
    .leftJoin(
      conversation,
      and(
        eq(conversation.assignedAgentId, agent.id),
        // Belt-and-braces on top of RLS, matching the codebase rule that scoped
        // reads name their workspace.
        eq(conversation.workspaceId, workspaceId),
        inArray(conversation.status, [...LIVE_CONVERSATION_STATUSES]),
      ),
    )
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        isNull(workspaceMember.deactivatedAt),
        eq(agent.status, 'active'),
      ),
    )
    .groupBy(agent.id)
    .orderBy(asc(load), asc(agent.id))
    .limit(1)

  return rows[0]?.agentId ?? null
}
```

- [ ] **Step 4: Export it and run the tests**

Add `export * from './assignOnHandoff.ts'` to `backend/src/domain/bot/index.ts`.

Run: `pnpm --filter @support/api test -- tests/bot.assignment.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add backend/src/domain/bot backend/tests/bot.assignment.test.ts
git commit -m "feat(bot): assign handoffs to the least-loaded active agent"
```

---

## Task 4: `applyBotTurn` — the only writer

**Files:**
- Create: `backend/src/domain/bot/applyBotTurn.ts`
- Modify: `backend/src/domain/bot/index.ts`
- Modify: `backend/tests/bot.turnSeam.test.ts`

**Interfaces:**
- Consumes: `postMessage` / `PostedMessageRow` from `domain/conversations`, `appendEvent`, `assignOnHandoff`, `SILENT_UNAVAILABLE_REASONS`, `HANDOFF_PLAYER_MESSAGE`, `botFailureNote`.
- Produces:
  ```ts
  export type BotTurnContext = { workspaceId: string; conversationId: string }
  export type AppliedBotTurn = {
    posted: PostedMessageRow[]
    /** The status the conversation ended on, or null when it did not change. */
    statusChanged: 'open' | null
    assignedAgentId: string | null
  }
  export function applyBotTurn(tx: Tx, ctx: BotTurnContext, decision: BotTurnDecision): Promise<AppliedBotTurn>
  ```
  Consumed by Tasks 5, 6 and 7.

**Note on one deliberate addition to the spec:** `applyBotTurn` re-reads `status` inside its own transaction and returns an empty `AppliedBotTurn` unless the status is `bot_active`. The spec places the guard in `runBotTurn` (§4); this keeps that guard *and* enforces the invariant at the writer, because the worker's `failed` handler (Task 6) applies an outcome without going through `runBotTurn` and must not talk over an agent either. One invariant, enforced where the write happens.

- [ ] **Step 1: Write the failing outcome tests**

Append to `backend/tests/bot.turnSeam.test.ts`. Add these imports at the top of the file:

```ts
import { eq } from 'drizzle-orm'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { applyBotTurn, HANDOFF_PLAYER_MESSAGE } from '../src/domain/bot/index.ts'
import { conversation, event, message } from '../src/shared/db/schema/index.ts'
import { seedAgent, seedWorkspaceMember } from './helpers/db.ts'
```

and extend the existing `afterAll` to also `await closeDb()`. Then append:

```ts
type Fixture = {
  workspaceId: string
  playerId: string
  conversationId: string
  subintentId: string
  otherSubintentId: string
  agentId: string
}

async function fixture(): Promise<Fixture> {
  const workspaceId = await seedWorkspace()
  const playerId = await seedPlayer(workspaceId)
  const conversationId = await seedConversation({ workspaceId, playerId })
  const intentId = await seedIntent(workspaceId, 'Billing')
  const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Refund request' })
  const otherSubintentId = await seedSubintent({ workspaceId, intentId, name: 'Missing purchase' })
  const agentId = await seedAgent()
  await seedWorkspaceMember({ workspaceId, agentId })
  return { workspaceId, playerId, conversationId, subintentId, otherSubintentId, agentId }
}

const apply = (f: Fixture, decision: Parameters<typeof applyBotTurn>[2]) =>
  withWorkspace(f.workspaceId, (tx) =>
    applyBotTurn(tx, { workspaceId: f.workspaceId, conversationId: f.conversationId }, decision),
  )

const readConversation = (f: Fixture) =>
  withWorkspace(f.workspaceId, async (tx) => {
    const [row] = await tx.select().from(conversation).where(eq(conversation.id, f.conversationId))
    return row!
  })

const readMessages = (f: Fixture) =>
  withWorkspace(f.workspaceId, (tx) =>
    tx.select().from(message).where(eq(message.conversationId, f.conversationId)).orderBy(message.seq),
  )

const readEvents = (f: Fixture) =>
  withWorkspace(f.workspaceId, (tx) =>
    tx.select().from(event).where(eq(event.conversationId, f.conversationId)).orderBy(event.id),
  )

describe('applyBotTurn', () => {
  it('writes nothing at all for a noop', async () => {
    const f = await fixture()
    const applied = await apply(f, { kind: 'noop' })

    expect(applied).toEqual({ posted: [], statusChanged: null, assignedAgentId: null })
    expect(await readMessages(f)).toHaveLength(0)
    expect(await readEvents(f)).toHaveLength(0)
    expect((await readConversation(f)).status).toBe('bot_active')
  })

  it('writes nothing when the conversation has left bot_active — the bot never talks over a human', async () => {
    const f = await fixture()
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [f.conversationId])

    const applied = await apply(f, { kind: 'handoff', reason: 'model', subintentId: f.subintentId })

    expect(applied.posted).toHaveLength(0)
    expect(applied.statusChanged).toBeNull()
    expect(await readMessages(f)).toHaveLength(0)
    expect(await readEvents(f)).toHaveLength(0)
  })

  it('answers in place: one public bot message, still bot_active, classified once', async () => {
    const f = await fixture()
    const applied = await apply(f, { kind: 'answer', reply: 'Try relinking your account.', subintentId: f.subintentId })

    expect(applied.statusChanged).toBeNull()
    const messages = await readMessages(f)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ authorType: 'bot', visibility: 'public', body: 'Try relinking your account.' })

    const row = await readConversation(f)
    expect(row.status).toBe('bot_active')
    expect(row.subintentId).toBe(f.subintentId)
    expect(row.classificationSource).toBe('bot')
    expect(row.assignedAgentId).toBeNull()

    const intentSet = (await readEvents(f)).filter((e) => e.type === 'intent_set')
    expect(intentSet).toHaveLength(1)
    expect(intentSet[0]!.actorType).toBe('bot')
    expect(intentSet[0]!.actorId).toBeNull()
    expect(intentSet[0]!.payload).toEqual({
      source: 'bot',
      subintent_name: 'Refund request',
      intent_name: 'Billing',
    })
  })

  it('never reclassifies: a second answer naming a different subintent changes nothing', async () => {
    const f = await fixture()
    await apply(f, { kind: 'answer', reply: 'first', subintentId: f.subintentId })
    await apply(f, { kind: 'answer', reply: 'second', subintentId: f.otherSubintentId })

    expect((await readConversation(f)).subintentId).toBe(f.subintentId)
    expect((await readEvents(f)).filter((e) => e.type === 'intent_set')).toHaveLength(1)
  })

  it('hands off: open, assigned, one public system message, no internal note, bot_handoff', async () => {
    const f = await fixture()
    const applied = await apply(f, { kind: 'handoff', reason: 'model', subintentId: f.subintentId })

    expect(applied.statusChanged).toBe('open')
    expect(applied.assignedAgentId).toBe(f.agentId)

    const messages = await readMessages(f)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      authorType: 'system',
      visibility: 'public',
      body: HANDOFF_PLAYER_MESSAGE,
    })

    const row = await readConversation(f)
    expect(row.status).toBe('open')
    expect(row.assignedAgentId).toBe(f.agentId)
    expect(row.subintentId).toBe(f.subintentId)

    const types = (await readEvents(f)).map((e) => e.type)
    // Classification first, then the handoff it explains.
    expect(types.filter((t) => t === 'intent_set' || t === 'bot_handoff')).toEqual(['intent_set', 'bot_handoff'])
    const handoff = (await readEvents(f)).find((e) => e.type === 'bot_handoff')!
    expect(handoff.payload).toEqual({ reason: 'model' })
    expect(handoff.actorType).toBe('bot')
  })

  it('hands off unclassified when the decider names no subintent', async () => {
    const f = await fixture()
    await apply(f, { kind: 'handoff', reason: 'turn_cap', subintentId: null })

    const row = await readConversation(f)
    expect(row.subintentId).toBeNull()
    expect(row.classificationSource).toBeNull()
    expect((await readEvents(f)).filter((e) => e.type === 'intent_set')).toHaveLength(0)
  })

  it('a loud unavailable posts the player message AND an internal note, and classifies nothing', async () => {
    const f = await fixture()
    await apply(f, { kind: 'unavailable', reason: 'error' })

    const messages = await readMessages(f)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ authorType: 'system', visibility: 'public', body: HANDOFF_PLAYER_MESSAGE })
    expect(messages[1]).toMatchObject({
      authorType: 'system',
      visibility: 'internal',
      body: 'Bot could not respond (`error`). Handed off unclassified.',
    })

    const row = await readConversation(f)
    expect(row.status).toBe('open')
    expect(row.assignedAgentId).toBe(f.agentId)
    // An unclassified conversation is the honest record of a turn that did not happen.
    expect(row.subintentId).toBeNull()
    expect(row.classificationSource).toBeNull()

    const events = await readEvents(f)
    expect(events.filter((e) => e.type === 'intent_set')).toHaveLength(0)
    const unavailable = events.filter((e) => e.type === 'bot_unavailable')
    expect(unavailable).toHaveLength(1)
    expect(unavailable[0]!.payload).toEqual({ reason: 'error' })
  })

  it.each(['not_provisioned', 'not_implemented'] as const)(
    'a silent unavailable (%s) suppresses the note but never the event',
    async (reason) => {
      const f = await fixture()
      await apply(f, { kind: 'unavailable', reason })

      const messages = await readMessages(f)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ visibility: 'public', body: HANDOFF_PLAYER_MESSAGE })

      expect((await readConversation(f)).status).toBe('open')
      const unavailable = (await readEvents(f)).filter((e) => e.type === 'bot_unavailable')
      expect(unavailable).toHaveLength(1)
      expect(unavailable[0]!.payload).toEqual({ reason })
    },
  )

  it('leaves the conversation in the unassigned queue when no agent is active', async () => {
    const f = await fixture()
    await ownerPool.query(`update agent set status = 'deactivated' where id = $1`, [f.agentId])

    const applied = await apply(f, { kind: 'handoff', reason: 'model', subintentId: null })

    expect(applied.assignedAgentId).toBeNull()
    const row = await readConversation(f)
    expect(row.assignedAgentId).toBeNull()
    // The flip happens either way — a player always reaches the queue a human reads.
    expect(row.status).toBe('open')
  })

  it('is atomic: a failing event append leaves no message and no status change', async () => {
    const f = await fixture()
    // A subintent id that is syntactically valid but belongs to nobody: the
    // composite FK refuses it mid-transaction, after the message insert.
    await expect(
      apply(f, {
        kind: 'handoff',
        reason: 'model',
        subintentId: '00000000-0000-0000-0000-0000000000ff',
      }),
    ).rejects.toThrow()

    expect(await readMessages(f)).toHaveLength(0)
    expect(await readEvents(f)).toHaveLength(0)
    expect((await readConversation(f)).status).toBe('bot_active')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @support/api test -- tests/bot.turnSeam.test.ts`
Expected: FAIL — no export named `applyBotTurn`.

- [ ] **Step 3: Write `applyBotTurn.ts`**

```ts
import { eq } from 'drizzle-orm'
import { postMessage, type PostedMessageRow } from '../conversations/index.ts'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { conversation, intent, subintent } from '../../shared/db/schema/index.ts'
import type { Tx } from '../../shared/db/withWorkspace.ts'
import { assignOnHandoff } from './assignOnHandoff.ts'
import { SILENT_UNAVAILABLE_REASONS, type BotTurnDecision } from './botTurn.ts'
import { botFailureNote, HANDOFF_PLAYER_MESSAGE } from './messages.ts'

export type BotTurnContext = {
  workspaceId: string
  conversationId: string
}

export type AppliedBotTurn = {
  /** In the order they were posted. The caller emits these after commit. */
  posted: PostedMessageRow[]
  /** The status the conversation ended on, or null when it did not change. */
  statusChanged: 'open' | null
  assignedAgentId: string | null
}

const NOTHING: AppliedBotTurn = { posted: [], statusChanged: null, assignedAgentId: null }

/**
 * Classification is written once and never overwritten. A second bot turn does
 * not get to reclassify: an intent_set fired on every turn would make the
 * misclassification metric — "conversations where an agent changed the
 * subintent" — count the bot arguing with itself.
 *
 * Returns true when it actually wrote, which is the only condition under which
 * intent_set is appended.
 *
 * The names are snapshotted as literals. A name resolved through a FK at read
 * time rewrites history when an admin renames a subintent.
 */
async function writeClassification(
  tx: Tx,
  ctx: BotTurnContext,
  currentSubintentId: string | null,
  subintentId: string | null,
): Promise<boolean> {
  if (subintentId === null || currentSubintentId !== null) return false

  const [named] = await tx
    .select({ subintentName: subintent.name, intentName: intent.name })
    .from(subintent)
    .innerJoin(intent, eq(intent.id, subintent.intentId))
    .where(eq(subintent.id, subintentId))
    .limit(1)

  // RLS scopes this read, so an id from another workspace simply is not here.
  // The composite FK would refuse the UPDATE below anyway; failing here names
  // the problem instead of surfacing a raw Postgres constraint error.
  if (!named) throw new Error(`applyBotTurn: subintent ${subintentId} is not visible in this workspace`)

  await tx
    .update(conversation)
    .set({ subintentId, classificationSource: 'bot' })
    .where(eq(conversation.id, ctx.conversationId))

  await appendEvent(tx, {
    workspaceId: ctx.workspaceId,
    type: 'intent_set',
    conversationId: ctx.conversationId,
    actorId: null,
    actorType: 'bot',
    payload: { source: 'bot', subintent_name: named.subintentName, intent_name: named.intentName },
  })

  return true
}

/** The status flip and the assignment every handoff shape shares. */
async function handOffToHuman(tx: Tx, ctx: BotTurnContext): Promise<string | null> {
  const assignedAgentId = await assignOnHandoff(tx, ctx.workspaceId)
  await tx
    .update(conversation)
    .set({ status: 'open', ...(assignedAgentId ? { assignedAgentId } : {}) })
    .where(eq(conversation.id, ctx.conversationId))
  return assignedAgentId
}

/**
 * The only writer. Every state change writes the mutable row and its event row
 * together, and this extends that rule: the message, the status flip, the
 * assignment and the events for one outcome are one atomic unit. A handoff that
 * assigns an agent but loses its event, or posts a message the status change
 * rolled back, is impossible rather than unlikely.
 *
 * No socket emit here — the caller emits after this transaction commits.
 *
 * The `bot_active` re-check is the same invariant runBotTurn checks before it
 * calls the decider, enforced again where the write happens: the bot-turns
 * worker's `failed` handler applies an outcome without going through
 * runBotTurn, and it must not talk over an agent either. Losing this race means
 * the bot stays quiet, which is the safe direction.
 */
export async function applyBotTurn(
  tx: Tx,
  ctx: BotTurnContext,
  decision: BotTurnDecision,
): Promise<AppliedBotTurn> {
  if (decision.kind === 'noop') return NOTHING

  const [current] = await tx
    .select({ status: conversation.status, subintentId: conversation.subintentId })
    .from(conversation)
    .where(eq(conversation.id, ctx.conversationId))
    .limit(1)

  if (!current || current.status !== 'bot_active') return NOTHING

  const posted: PostedMessageRow[] = []

  if (decision.kind === 'answer') {
    posted.push(
      await postMessage(tx, {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        authorType: 'bot',
        actorId: null,
        body: decision.reply,
      }),
    )
    await writeClassification(tx, ctx, current.subintentId, decision.subintentId)
    return { posted, statusChanged: null, assignedAgentId: null }
  }

  // Both remaining shapes end with a human owning the conversation, and the
  // player sees the same sentence either way.
  posted.push(
    await postMessage(tx, {
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      authorType: 'system',
      actorId: null,
      body: HANDOFF_PLAYER_MESSAGE,
    }),
  )

  if (decision.kind === 'unavailable' && !SILENT_UNAVAILABLE_REASONS.has(decision.reason)) {
    posted.push(
      await postMessage(tx, {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        authorType: 'system',
        actorId: null,
        body: botFailureNote(decision.reason),
        visibility: 'internal',
      }),
    )
  }

  if (decision.kind === 'handoff') {
    await writeClassification(tx, ctx, current.subintentId, decision.subintentId)
  }

  const assignedAgentId = await handOffToHuman(tx, ctx)

  await appendEvent(tx, {
    workspaceId: ctx.workspaceId,
    type: decision.kind === 'handoff' ? 'bot_handoff' : 'bot_unavailable',
    conversationId: ctx.conversationId,
    actorId: null,
    actorType: 'bot',
    payload: { reason: decision.reason },
  })

  return { posted, statusChanged: 'open', assignedAgentId }
}
```

- [ ] **Step 4: Export it and run the tests**

Add `export * from './applyBotTurn.ts'` to `backend/src/domain/bot/index.ts`.

Run: `pnpm --filter @support/api test -- tests/bot.turnSeam.test.ts`
Expected: PASS, 11 tests (the cross-tenant probe plus ten outcome tests — `it.each` counts as two).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add backend/src/domain/bot backend/tests/bot.turnSeam.test.ts
git commit -m "feat(bot): apply every bot turn outcome through one transaction"
```

---

## Task 5: `runBotTurn` — gather, guard, decide, apply, emit

**Files:**
- Create: `backend/src/domain/bot/orchestrator.ts`
- Modify: `backend/src/domain/bot/index.ts`
- Create: `backend/tests/bot.orchestrator.test.ts`
- Modify: `backend/tests/realtime.internalNote.test.ts`

**Interfaces:**
- Consumes: `applyBotTurn`, `BotDecider`, `BotTurnInput`, `toPlayerView` / `toAgentView`, `withWorkspace`, `emitMessageToRooms` / `emitInboxChanged`, `getIo`.
- Produces: `runBotTurn(workspaceId: string, conversationId: string, decider: BotDecider): Promise<BotTurnDecision['kind']>`. Consumed by Task 6.

- [ ] **Step 1: Write the failing orchestrator tests**

Create `backend/tests/bot.orchestrator.test.ts`:

```ts
import { createServer } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeDb } from '../src/shared/db/client.ts'
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { conversation, event, message } from '../src/shared/db/schema/index.ts'
import { runBotTurn, stubDecider, type BotDecider, type BotTurnInput } from '../src/domain/bot/index.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedMessage,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts'

// getIo() throws when the socket singleton is unset, and runBotTurn emits after
// commit. The http server is never listened on — this only gives the emit
// helpers a Server instance to call.
beforeAll(() => {
  createSocketServer(createServer())
})

afterAll(async () => {
  await closeSocketServer()
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function setup() {
  const workspaceId = await seedWorkspace()
  const playerId = await seedPlayer(workspaceId)
  const conversationId = await seedConversation({ workspaceId, playerId })
  const agentId = await seedAgent()
  await seedWorkspaceMember({ workspaceId, agentId })
  return { workspaceId, playerId, conversationId, agentId }
}

describe('runBotTurn', () => {
  it('no-ops without calling the decider when the conversation has left bot_active', async () => {
    const { workspaceId, conversationId } = await setup()
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [conversationId])

    let called = false
    const decider: BotDecider = async () => {
      called = true
      return { kind: 'handoff', reason: 'model', subintentId: null }
    }

    expect(await runBotTurn(workspaceId, conversationId, decider)).toBe('noop')
    expect(called).toBe(false)

    const rows = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(message).where(eq(message.conversationId, conversationId)),
    )
    expect(rows).toHaveLength(0)
    const events = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.conversationId, conversationId)),
    )
    expect(events).toHaveLength(0)
  })

  it('feeds the decider the public history only, through the player serializer', async () => {
    const { workspaceId, conversationId } = await setup()
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player', body: 'my coins vanished' })
    await seedMessage({
      workspaceId,
      conversationId,
      seq: 2,
      authorType: 'agent',
      visibility: 'internal',
      body: 'this player is a known refund abuser',
    })

    let seen: BotTurnInput | null = null
    const decider: BotDecider = async (input) => {
      seen = input
      return { kind: 'noop' }
    }
    await runBotTurn(workspaceId, conversationId, decider)

    expect(seen!.workspaceId).toBe(workspaceId)
    expect(seen!.conversationId).toBe(conversationId)
    expect(seen!.history.map((m) => m.body)).toEqual(['my coins vanished'])
    // The player serializer's whitelist is what the bot sees — no visibility field at all.
    expect(seen!.history[0]).not.toHaveProperty('visibility')
  })

  it('applies the decision and reports its kind', async () => {
    const { workspaceId, conversationId, agentId } = await setup()

    expect(await runBotTurn(workspaceId, conversationId, stubDecider)).toBe('unavailable')

    const [row] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    )
    expect(row!.status).toBe('open')
    expect(row!.assignedAgentId).toBe(agentId)

    const events = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.conversationId, conversationId)),
    )
    const unavailable = events.filter((e) => e.type === 'bot_unavailable')
    expect(unavailable).toHaveLength(1)
    expect(unavailable[0]!.payload).toEqual({ reason: 'not_implemented' })
    // The stub's reason is silent: no internal note.
    const messages = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(message).where(eq(message.conversationId, conversationId)),
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]!.visibility).toBe('public')
  })

  it('lets a throwing decider propagate — BullMQ owns the retry, not this function', async () => {
    const { workspaceId, conversationId } = await setup()
    const decider: BotDecider = async () => {
      throw new Error('decider exploded')
    }
    await expect(runBotTurn(workspaceId, conversationId, decider)).rejects.toThrow('decider exploded')
  })

  it('no-ops on a conversation that does not exist', async () => {
    const { workspaceId } = await setup()
    expect(await runBotTurn(workspaceId, '00000000-0000-0000-0000-0000000000aa', stubDecider)).toBe('noop')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @support/api test -- tests/bot.orchestrator.test.ts`
Expected: FAIL — no export named `runBotTurn`.

- [ ] **Step 3: Write `orchestrator.ts`**

```ts
import { eq } from 'drizzle-orm'
import type { PlayerMessageView } from '@support/types'
import { toAgentView, toPlayerView } from '../conversations/index.ts'
import { conversation, message } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import { emitInboxChanged, emitMessageToRooms } from '../../shared/realtime/emit.ts'
import { getIo } from '../../shared/realtime/socketServer.ts'
import { applyBotTurn } from './applyBotTurn.ts'
import type { BotDecider, BotTurnDecision } from './botTurn.ts'

/**
 * The impure shell: gather, guard, delegate to the decider, apply, emit. The
 * decider is injected, so specs 2 and 3 change one function and no control flow
 * — and a test can make it return anything without Redis or a model.
 *
 * This module deliberately does not import shared/jobs/botTurns.ts. The job
 * calls the orchestrator, never the reverse, which is what keeps runBotTurn
 * callable directly from a test with no queue running.
 *
 * Returns the kind that was applied, for the caller's logs and for tests.
 */
export async function runBotTurn(
  workspaceId: string,
  conversationId: string,
  decider: BotDecider,
): Promise<BotTurnDecision['kind']> {
  // 1 — Gather. Spec 2 adds retrieval, the subintent list and player state here.
  const gathered = await withWorkspace(workspaceId, async (tx) => {
    const [found] = await tx
      .select({ status: conversation.status })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1)
    if (!found) return null

    const rows = await tx
      .select()
      .from(message)
      .where(eq(message.conversationId, conversationId))
      .orderBy(message.seq)

    // Through the player serializer, nulls filtered — the same whitelist the
    // player-facing routes use, so an internal note can never enter a bot turn's
    // input. Not a visibility predicate in the query: the row is always fetched
    // whole and toPlayerView is the only thing that decides.
    const history = rows.map(toPlayerView).filter((m): m is PlayerMessageView => m !== null)
    return { status: found.status, history }
  })

  // 2 — Guard. Between the enqueue and here, an agent may have claimed or replied
  // to this conversation. A no-op is a normal outcome, not an error and not a
  // retry: the window is narrow, the loser is the bot, and losing means staying
  // quiet. A row lock held across the job's lifetime would block the agent instead.
  if (!gathered || gathered.status !== 'bot_active') return 'noop'

  // 3 — Decide. A throw propagates to BullMQ, which retries; on the final attempt
  // the worker's failed handler applies { unavailable, error }.
  const decision = await decider({ workspaceId, conversationId, history: gathered.history })
  if (decision.kind === 'noop') return 'noop'

  // 4 — Apply, in one transaction.
  const applied = await withWorkspace(workspaceId, (tx) =>
    applyBotTurn(tx, { workspaceId, conversationId }, decision),
  )

  // 5 — Emit, after commit. Never inside the transaction: a rolled-back message
  // must never be pushed to a client that thinks it succeeded.
  const io = getIo()
  for (const posted of applied.posted) {
    emitMessageToRooms(io, conversationId, toPlayerView(posted), toAgentView(posted))
  }
  if (applied.statusChanged) {
    emitInboxChanged(io, workspaceId, conversationId, applied.statusChanged)
  }

  return decision.kind
}
```

- [ ] **Step 4: Export it and run the tests**

Add `export * from './orchestrator.ts'` to `backend/src/domain/bot/index.ts`.

Run: `pnpm --filter @support/api test -- tests/bot.orchestrator.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Extend the internal-note guard**

Append to `backend/tests/realtime.internalNote.test.ts`, inside the existing `describe` block. Add these imports to that file:

```ts
import { toPlayerView } from '../src/domain/conversations/index.ts'
import { runBotTurn, type BotDecider } from '../src/domain/bot/index.ts'
import { seedAgent, seedWorkspaceMember } from './helpers/db.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { message } from '../src/shared/db/schema/index.ts'
import { eq } from 'drizzle-orm'
```

```ts
  it('never emits the bot failure note to the player room, and toPlayerView refuses it', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const agentId = await seedAgent('bot-note@example.test')
    await seedWorkspaceMember({ workspaceId, agentId })

    const playerToken = await mintToken({ workspace_id: workspaceId, player_id: playerId, external_player_id: 'p1' })
    const playerSocket = connectClient(server.url, { token: playerToken, role: 'player' })
    await waitFor(playerSocket, 'connect')
    await new Promise<boolean>((resolve) =>
      playerSocket.emit('join_conversation', { conversation_id: conversationId }, resolve),
    )

    const playerReceived: Array<{ body: string }> = []
    playerSocket.on('message:new', (payload: { body: string }) => playerReceived.push(payload))

    // A loud reason, so the note is actually written.
    const decider: BotDecider = async () => ({ kind: 'unavailable', reason: 'error' })
    await runBotTurn(workspaceId, conversationId, decider)
    await new Promise((resolve) => setTimeout(resolve, 150))

    // The player got the handoff sentence and nothing else.
    expect(playerReceived.map((m) => m.body)).toEqual(["You're being connected to our support team."])

    const rows = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(message).where(eq(message.conversationId, conversationId)).orderBy(message.seq),
    )
    const note = rows.find((r) => r.visibility === 'internal')!
    expect(note.body).toContain('Bot could not respond')
    expect(toPlayerView(note)).toBeNull()

    playerSocket.close()
  })
```

`startRealtimeServer()` in that file already creates the socket singleton, so `getIo()` inside `runBotTurn` resolves.

- [ ] **Step 6: Run the realtime test**

Run: `pnpm --filter @support/api test -- tests/realtime.internalNote.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck
git add backend/src/domain/bot backend/tests/bot.orchestrator.test.ts backend/tests/realtime.internalNote.test.ts
git commit -m "feat(bot): run a bot turn behind an injected decider, emitting after commit"
```

---

## Task 6: The `bot-turns` queue and its worker

**Files:**
- Create: `backend/src/shared/jobs/botTurns.ts`
- Modify: `backend/src/shared/jobs/queue.ts`
- Create: `backend/tests/jobs.botTurns.test.ts`

**Interfaces:**
- Consumes: `runBotTurn`, `stubDecider`, `applyBotTurn`, `withWorkspace`, `emitMessageToRooms` / `emitInboxChanged` / `getIo`, `logger`, `getEnv`.
- Produces:
  ```ts
  export const BOT_TURNS_QUEUE = 'bot-turns'
  export const BOT_TURN_JOB = 'bot-turn'
  export const BOT_TURN_ATTEMPTS = 2
  export type BotTurnJobData = { workspaceId: string; conversationId: string; seq: number }
  export function botTurnQueue(): Queue
  export function enqueueBotTurn(data: BotTurnJobData): Promise<void>
  /** The decider is a parameter so a test can inject one; production passes the stub. */
  export function registerBotTurnWorker(decider?: BotDecider): { close: () => Promise<void> }
  export function closeBotTurnQueue(): Promise<void>
  ```
  `enqueueBotTurn` is consumed by Task 7; `botTurnQueue` / `closeBotTurnQueue` by Task 7's tests.

- [ ] **Step 1: Write the failing job tests**

Create `backend/tests/jobs.botTurns.test.ts`. Redis must be up:

```ts
import { createServer } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeDb } from '../src/shared/db/client.ts'
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { conversation, event, message } from '../src/shared/db/schema/index.ts'
import {
  BOT_TURN_ATTEMPTS,
  botTurnQueue,
  closeBotTurnQueue,
  enqueueBotTurn,
  registerBotTurnWorker,
} from '../src/shared/jobs/botTurns.ts'
import { registerJobs } from '../src/shared/jobs/queue.ts'
import type { BotDecider } from '../src/domain/bot/index.ts'
import {
  closeOwnerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts'

let worker: { close: () => Promise<void> } | null = null

beforeAll(() => {
  createSocketServer(createServer())
})

beforeEach(async () => {
  await truncateAll()
  await botTurnQueue().obliterate({ force: true })
})

afterEach(async () => {
  await worker?.close()
  worker = null
})

afterAll(async () => {
  await closeBotTurnQueue()
  await closeSocketServer()
  await closeDb()
  await closeOwnerPool()
})

async function setup() {
  const workspaceId = await seedWorkspace()
  const playerId = await seedPlayer(workspaceId)
  const conversationId = await seedConversation({ workspaceId, playerId })
  const agentId = await seedAgent()
  await seedWorkspaceMember({ workspaceId, agentId })
  return { workspaceId, playerId, conversationId, agentId }
}

/** Polls the database rather than the queue: the assertion is about what was written. */
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const readEvents = (workspaceId: string, conversationId: string) =>
  withWorkspace(workspaceId, (tx) => tx.select().from(event).where(eq(event.conversationId, conversationId)))

describe('the bot-turns queue', () => {
  it('runs the stub decider end to end: bot_unavailable/not_implemented, no internal note', async () => {
    const { workspaceId, conversationId, agentId } = await setup()
    worker = registerBotTurnWorker()
    await enqueueBotTurn({ workspaceId, conversationId, seq: 1 })

    const events = await waitFor(
      () => readEvents(workspaceId, conversationId),
      (rows) => rows.some((e) => e.type === 'bot_unavailable'),
    )
    const unavailable = events.filter((e) => e.type === 'bot_unavailable')
    expect(unavailable).toHaveLength(1)
    expect(unavailable[0]!.payload).toEqual({ reason: 'not_implemented' })

    const [row] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    )
    expect(row!.status).toBe('open')
    expect(row!.assignedAgentId).toBe(agentId)

    const messages = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(message).where(eq(message.conversationId, conversationId)),
    )
    expect(messages.every((m) => m.visibility === 'public')).toBe(true)
  })

  it('runs one job for duplicate enqueues of the same conversation and seq', async () => {
    const { workspaceId, conversationId } = await setup()
    let runs = 0
    const decider: BotDecider = async () => {
      runs += 1
      return { kind: 'noop' }
    }
    worker = registerBotTurnWorker(decider)

    await enqueueBotTurn({ workspaceId, conversationId, seq: 7 })
    await enqueueBotTurn({ workspaceId, conversationId, seq: 7 })
    await waitFor(async () => runs, (n) => n >= 1)
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(runs).toBe(1)
  })

  it('retries a throwing decider, then hands off exactly once on the final attempt', async () => {
    const { workspaceId, conversationId, agentId } = await setup()
    let attempts = 0
    const decider: BotDecider = async () => {
      attempts += 1
      throw new Error('boom')
    }
    worker = registerBotTurnWorker(decider)
    await enqueueBotTurn({ workspaceId, conversationId, seq: 1 })

    const events = await waitFor(
      () => readEvents(workspaceId, conversationId),
      (rows) => rows.some((e) => e.type === 'bot_unavailable'),
      20_000,
    )
    // Settling time, so a second (wrong) fallback would have landed by now.
    await new Promise((resolve) => setTimeout(resolve, 1_000))

    expect(attempts).toBe(BOT_TURN_ATTEMPTS)
    const unavailable = (await readEvents(workspaceId, conversationId)).filter((e) => e.type === 'bot_unavailable')
    // failed fires on EVERY attempt; only the last one may apply the fallback.
    expect(unavailable).toHaveLength(1)
    expect(unavailable[0]!.payload).toEqual({ reason: 'error' })
    expect(events.length).toBeGreaterThan(0)

    const [row] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    )
    expect(row!.status).toBe('open')
    expect(row!.assignedAgentId).toBe(agentId)

    // 'error' is loud: the agent gets a note.
    const messages = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(message).where(eq(message.conversationId, conversationId)).orderBy(message.seq),
    )
    expect(messages.filter((m) => m.visibility === 'internal')).toHaveLength(1)
  })

  it('registers a second, separate worker that registerJobs closes too', async () => {
    const jobs = await registerJobs()
    // If the bot-turns worker were the same worker, closing once would leave the
    // other queue's connection open and this close would hang or throw.
    await expect(jobs.close()).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @support/api test -- tests/jobs.botTurns.test.ts`
Expected: FAIL — cannot resolve `../src/shared/jobs/botTurns.ts`.

- [ ] **Step 3: Write `botTurns.ts`**

```ts
import { Queue, Worker, type Job } from 'bullmq'
import IORedis from 'ioredis'
import { getEnv } from '../../env.ts'
import { logger } from '../logging/logger.ts'
import { withWorkspace } from '../db/withWorkspace.ts'
import { emitInboxChanged, emitMessageToRooms } from '../realtime/emit.ts'
import { getIo } from '../realtime/socketServer.ts'
import { toAgentView, toPlayerView } from '../../domain/conversations/index.ts'
import { applyBotTurn, runBotTurn, stubDecider, type BotDecider } from '../../domain/bot/index.ts'

export const BOT_TURNS_QUEUE = 'bot-turns'
export const BOT_TURN_JOB = 'bot-turn'

/**
 * This slice owns the attempt count, because the fallback that fires after the
 * last attempt is defined here. Spec 3 owns the per-call timeout.
 */
export const BOT_TURN_ATTEMPTS = 2

export type BotTurnJobData = {
  workspaceId: string
  conversationId: string
  /** The player message that triggered this turn. Only used to build the job id. */
  seq: number
}

function connection(): IORedis {
  return new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null })
}

let queue: Queue<BotTurnJobData> | undefined
let queueConnection: IORedis | undefined

/** Lazily created so importing this module never opens a Redis connection. */
export function botTurnQueue(): Queue<BotTurnJobData> {
  if (!queue) {
    queueConnection = connection()
    queue = new Queue<BotTurnJobData>(BOT_TURNS_QUEUE, { connection: queueConnection })
  }
  return queue
}

export async function closeBotTurnQueue(): Promise<void> {
  await queue?.close()
  queueConnection?.disconnect()
  queue = undefined
  queueConnection = undefined
}

/**
 * Called after the caller's transaction commits, never inside it: a rolled-back
 * message must not spawn a turn.
 *
 * The job id is `${conversationId}:${seq}` and BullMQ deduplicates on it, so a
 * retried HTTP request or a double socket delivery cannot produce two bot turns
 * for one player message.
 */
export async function enqueueBotTurn(data: BotTurnJobData): Promise<void> {
  await botTurnQueue().add(BOT_TURN_JOB, data, {
    jobId: `${data.conversationId}:${data.seq}`,
    attempts: BOT_TURN_ATTEMPTS,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: 50,
    removeOnFail: 100,
  })
}

/**
 * The fallback runs OUTSIDE the failed job: it must not depend on the thing that
 * just failed. It goes straight to applyBotTurn rather than through runBotTurn,
 * because there is no decision left to make.
 */
async function applyErrorFallback(data: BotTurnJobData): Promise<void> {
  const applied = await withWorkspace(data.workspaceId, (tx) =>
    applyBotTurn(tx, { workspaceId: data.workspaceId, conversationId: data.conversationId }, {
      kind: 'unavailable',
      reason: 'error',
    }),
  )

  const io = getIo()
  for (const posted of applied.posted) {
    emitMessageToRooms(io, data.conversationId, toPlayerView(posted), toAgentView(posted))
  }
  if (applied.statusChanged) {
    emitInboxChanged(io, data.workspaceId, data.conversationId, applied.statusChanged)
  }
}

/**
 * A queue of its own, because shared/jobs/queue.ts runs one Worker at
 * concurrency: 1 — correct for a five-minute repeatable sweep, wrong for bot
 * turns, where one slow turn would block every other workspace's. Separate
 * queues also mean a backlog of bot turns cannot starve the session-timeout
 * sweep, and the two have unrelated retry policies.
 *
 * The decider is a parameter so a test can inject one; production passes the stub.
 */
export function registerBotTurnWorker(decider: BotDecider = stubDecider): { close: () => Promise<void> } {
  const workerConnection = connection()

  const worker = new Worker<BotTurnJobData>(
    BOT_TURNS_QUEUE,
    async (job) => {
      if (job.name !== BOT_TURN_JOB) return
      await runBotTurn(job.data.workspaceId, job.data.conversationId, decider)
    },
    { connection: workerConnection, concurrency: 5 },
  )

  worker.on('failed', (job: Job<BotTurnJobData> | undefined, error: Error) => {
    // Failure is never silent. Until real alerting exists, this log is the alert.
    logger.error('bot', `bot turn failed: ${error.name} ${error.message}`)
    if (!job) return

    // `failed` fires on EVERY attempt, not only the last. Without this guard a
    // two-attempt failure would hand off twice and write two bot_unavailable
    // events for one player message.
    const attempts = job.opts.attempts ?? 1
    if (job.attemptsMade < attempts) return

    void applyErrorFallback(job.data).catch((fallbackError: Error) => {
      logger.error('bot', `bot turn fallback failed: ${fallbackError.name} ${fallbackError.message}`)
    })
  })

  return {
    close: async () => {
      await worker.close()
      workerConnection.disconnect()
    },
  }
}
```

- [ ] **Step 4: Register it from the same entry point**

In `backend/src/shared/jobs/queue.ts`, import and wire it so one `registerJobs()` starts both and one `close()` stops both:

```ts
import { closeBotTurnQueue, registerBotTurnWorker } from './botTurns.ts'
```

Inside `registerJobs`, after the existing `worker.on('failed', …)` block:

```ts
  // A second, independent worker on its own queue: bot turns run at concurrency 5
  // and must not be serialised behind the five-minute sweep. See botTurns.ts.
  const botTurns = registerBotTurnWorker()
```

and replace the returned `close`:

```ts
  return {
    close: async () => {
      await botTurns.close()
      await closeBotTurnQueue()
      await worker.close()
      await queue.close()
      queueConnection.disconnect()
      workerConnection.disconnect()
    },
  }
```

- [ ] **Step 5: Run the job tests**

Run: `pnpm --filter @support/api test -- tests/jobs.botTurns.test.ts`
Expected: PASS, 4 tests. The retry test takes a few seconds — the exponential backoff delays the second attempt by ~1s.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add backend/src/shared/jobs backend/tests/jobs.botTurns.test.ts
git commit -m "feat(jobs): add a dedicated bot-turns queue with a single-fire error fallback"
```

---

## Task 7: `sendPlayerMessage` — start at `bot_active`, fall back inline, enqueue after commit

**Files:**
- Modify: `backend/src/surface/services/messagesService.ts`
- Modify: `backend/tests/surface.messages.test.ts`

**Interfaces:**
- Consumes: `resolveBotConfig`, `applyBotTurn`, `enqueueBotTurn`, `toAgentView` / `toPlayerView`, `logger`.
- Produces: no signature change. `POST /surface/messages` keeps its request and response contract.

- [ ] **Step 1: Update the existing tests and add the new branches**

In `backend/tests/surface.messages.test.ts`, add these imports:

```ts
import { eq } from 'drizzle-orm'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { conversation, event, message } from '../src/shared/db/schema/index.ts'
import { botTurnQueue, closeBotTurnQueue } from '../src/shared/jobs/botTurns.ts'
import { seedAgent, seedBotConfig, seedWorkspaceMember } from './helpers/db.ts'
```

Extend the hooks so the queue is cleaned between tests and closed at the end — otherwise the worker-less queue connection keeps the Vitest process alive:

```ts
beforeEach(async () => {
  await truncateAll()
  await botTurnQueue().obliterate({ force: true })
})

afterAll(async () => {
  await closeBotTurnQueue()
  await closeSocketServer()
  await closeDb()
  await closeOwnerPool()
})
```

**Replace** the existing `'creates the conversation on the first message'` test with:

```ts
  it('creates the conversation at bot_active — every conversation starts with the bot', async () => {
    const { workspaceId, token } = await setup()
    await seedBotConfig({ workspaceId, isProvisioned: true })

    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello' })
      .expect(200)

    expect(res.body.conversation_id).toBeDefined()
    expect(res.body.message).toMatchObject({ author_type: 'player', body: 'hello', seq: 1 })

    const [row] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, res.body.conversation_id)),
    )
    expect(row!.status).toBe('bot_active')
    // No bot reply in the response — one arrives over the socket, if ever.
    expect(Object.keys(res.body)).toEqual(['conversation_id', 'message'])
  })

  it('enqueues exactly one bot turn, keyed by conversation and seq, when the bot is provisioned', async () => {
    const { workspaceId, token } = await setup()
    await seedBotConfig({ workspaceId, isProvisioned: true })

    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello' })
      .expect(200)

    const jobId = `${res.body.conversation_id}:1`
    expect(await botTurnQueue().getJob(jobId)).toBeDefined()
    expect(await botTurnQueue().getJobCountByTypes('wait', 'delayed', 'active')).toBe(1)

    // No system message and no bot event: the turn has not run yet.
    const messages = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(message).where(eq(message.conversationId, res.body.conversation_id)),
    )
    expect(messages).toHaveLength(1)
  })

  it('falls back synchronously when the bot is not provisioned', async () => {
    const { workspaceId, token } = await setup()
    // No bot_config row at all: resolveBotConfig collapses that to not provisioned.
    const agentId = await seedAgent()
    await seedWorkspaceMember({ workspaceId, agentId })

    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello' })
      .expect(200)

    const conversationId = res.body.conversation_id
    const [row] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    )
    expect(row!.status).toBe('open')
    expect(row!.assignedAgentId).toBe(agentId)

    const messages = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(message).where(eq(message.conversationId, conversationId)).orderBy(message.seq),
    )
    expect(messages.map((m) => ({ authorType: m.authorType, visibility: m.visibility }))).toEqual([
      { authorType: 'player', visibility: 'public' },
      { authorType: 'system', visibility: 'public' },
    ])
    // not_provisioned is a silent reason: a workspace running with its bot off
    // must not collect a "Bot could not respond" note on every conversation.
    expect(messages.some((m) => m.visibility === 'internal')).toBe(false)

    const events = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.conversationId, conversationId)),
    )
    const unavailable = events.filter((e) => e.type === 'bot_unavailable')
    expect(unavailable).toHaveLength(1)
    expect(unavailable[0]!.payload).toEqual({ reason: 'not_provisioned' })

    // No job: the bot being off is not a failure and needs no worker slot.
    expect(await botTurnQueue().getJobCountByTypes('wait', 'delayed', 'active')).toBe(0)

    // The response body still carries only the player's own message.
    expect(res.body.message).toMatchObject({ author_type: 'player', body: 'hello' })
  })


  it('does not enqueue a bot turn on reopen or on an awaiting_player reply', async () => {
    const { workspaceId, playerId, token } = await setup()
    await seedBotConfig({ workspaceId, isProvisioned: true })
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'resolved' where id = $1`, [conversationId])

    await request(app).post('/surface/messages').set('Authorization', `Bearer ${token}`).send({ body: 'back' }).expect(200)

    const [row] = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    )
    expect(row!.status).toBe('open')
    expect(await botTurnQueue().getJobCountByTypes('wait', 'delayed', 'active')).toBe(0)
  })
```

- [ ] **Step 2: Add the inbox-emit test, in its own file**

The assertion "the agent console is told `open`, once, never `bot_active`" needs a *listening* server and a real agent socket. `createSocketServer` has no guard and overwrites the module singleton, so calling `startRealtimeServer()` inside `surface.messages.test.ts` would tear down the non-listening server that file's `beforeAll` created. It gets its own file, following `realtime.internalNote.test.ts` exactly.

Create `backend/tests/realtime.botFallback.test.ts`:

```ts
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { mintToken } from './helpers/app.ts'
import { connectClient, startRealtimeServer } from './helpers/realtime.ts'
import { botTurnQueue, closeBotTurnQueue } from '../src/shared/jobs/botTurns.ts'
import {
  closeOwnerPool,
  seedAgent,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts'

let server: Awaited<ReturnType<typeof startRealtimeServer>>

beforeEach(async () => {
  await truncateAll()
  await botTurnQueue().obliterate({ force: true })
  server = await startRealtimeServer()
})

afterEach(async () => {
  await server.close()
})

afterAll(async () => {
  await closeBotTurnQueue()
  await closeDb()
  await closeOwnerPool()
})

describe('the not-provisioned fallback announces the status the request ended in', () => {
  it('emits conversation:changed once, carrying open and never bot_active', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const playerToken = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p-inbox',
    })
    // No bot_config row: the workspace takes the not-provisioned path.
    const agentId = await seedAgent('inbox@example.test')
    await seedWorkspaceMember({ workspaceId, agentId })
    const agentToken = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })

    // An agent socket joins its workspace's inbox room on connect.
    const agentSocket = connectClient(server.url, { token: agentToken, role: 'agent' })
    await new Promise((resolve) => agentSocket.on('connect', resolve))

    const seen: Array<{ conversation_id: string; status: string }> = []
    agentSocket.on('conversation:changed', (payload: { conversation_id: string; status: string }) =>
      seen.push(payload),
    )

    await request(server.url)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ body: 'hi' })
      .expect(200)
    await new Promise((resolve) => setTimeout(resolve, 150))

    // One emit. The agent console must never be told about a status that lasted
    // microseconds.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.status).toBe('open')

    agentSocket.close()
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @support/api test -- tests/surface.messages.test.ts tests/realtime.botFallback.test.ts`
Expected: FAIL — the conversation is created at `open`, no job is enqueued, no system message exists.

- [ ] **Step 4: Rewrite the conversation-resolution block**

In `backend/src/surface/services/messagesService.ts`, add the imports:

```ts
import { applyBotTurn, resolveBotConfig } from '../../domain/bot/index.ts'
import { enqueueBotTurn } from '../../shared/jobs/botTurns.ts'
import { logger } from '../../shared/logging/logger.ts'
```

Inside `sendPlayerMessage`'s transaction, track the status the conversation is actually in. In the create branch, **drop the explicit `status: 'open'`** so the schema default applies:

```ts
      const [created] = await tx
        .insert(conversation)
        // No explicit status: the schema default is 'bot_active', and
        // "every conversation starts here". Overriding it was the bug.
        .values({ workspaceId: ctx.workspaceId, playerId: ctx.playerId, sessionId: latestSession?.id ?? null })
        .returning({ id: conversation.id })
      if (!created) throw new Error('conversation insert returned nothing')
      conversationId = created.id
      inboxStatus = 'bot_active'
      statusAfter = 'bot_active'
```

Declare `statusAfter` alongside `inboxStatus`, and set it in each branch:

```ts
    let inboxStatus: string | null = null
    // The status the conversation is in once resolution is done — the bot gate
    // reads this, not the branch that was taken. A player's second message on a
    // still-bot_active conversation must run a turn too.
    let statusAfter = ''
```

In the `else` branch: `statusAfter = existing.status` immediately after `conversationId = existing.id`, then `statusAfter = 'open'` inside both the reopen and the `awaiting_player` sub-branches (right where each sets `inboxStatus = 'open'`).

- [ ] **Step 5: Add the bot gate after `postMessage`**

Still inside the transaction, replacing the `return { conversationId, posted, inboxStatus }` line:

```ts
    // The gate is one invariant: status === 'bot_active'. The reopen and
    // awaiting_player branches never reach it — the bot does not run on a
    // conversation an agent owns or has owned.
    let shouldEnqueue = false
    let applied: Awaited<ReturnType<typeof applyBotTurn>> = {
      posted: [],
      statusChanged: null,
      assignedAgentId: null,
    }

    if (statusAfter === 'bot_active') {
      // A single indexed primary-key read. Enqueuing a job to discover the bot
      // is turned off would cost a Redis round trip, a worker slot and a second
      // transaction to learn something this request already has in hand.
      const config = await resolveBotConfig(tx, ctx.workspaceId)
      if (config.isProvisioned) {
        shouldEnqueue = true
      } else {
        applied = await applyBotTurn(
          tx,
          { workspaceId: ctx.workspaceId, conversationId },
          { kind: 'unavailable', reason: 'not_provisioned' },
        )
        // Overwritten so the single emit after commit announces the status the
        // conversation actually ended this request in. The agent console must
        // never be told about a status that lasted microseconds.
        inboxStatus = 'open'
      }
    }

    return { conversationId, posted, inboxStatus, shouldEnqueue, applied }
```

- [ ] **Step 6: Enqueue and emit after commit**

Replace the post-transaction block:

```ts
  // After the transaction commits, never inside it: a rolled-back message must
  // not spawn a turn. Enqueue failure is logged and swallowed — the player's
  // message is already committed, and throwing would fail a request that
  // succeeded.
  if (result.shouldEnqueue) {
    try {
      await enqueueBotTurn({
        workspaceId: ctx.workspaceId,
        conversationId: result.conversationId,
        seq: result.posted.seq,
      })
    } catch (error) {
      const e = error as Error
      logger.error('bot', `failed to enqueue bot turn for ${result.conversationId}: ${e.name} ${e.message}`)
    }
  }

  const playerView = toPlayerView(result.posted)
  const agentView = toAgentView(result.posted)
  emitMessageToRooms(getIo(), result.conversationId, playerView, agentView)
  // Anything applyBotTurn posted inline — the public handoff message on the
  // not-provisioned path — goes out through the same pair of serializers.
  for (const posted of result.applied.posted) {
    emitMessageToRooms(getIo(), result.conversationId, toPlayerView(posted), toAgentView(posted))
  }
  if (result.inboxStatus) {
    emitInboxChanged(getIo(), ctx.workspaceId, result.conversationId, result.inboxStatus)
  }

  return { conversation_id: result.conversationId, message: playerView }
```

- [ ] **Step 7: Run the surface tests**

Run: `pnpm --filter @support/api test -- tests/surface.messages.test.ts tests/realtime.botFallback.test.ts`
Expected: PASS. The pre-existing reopen, `awaiting_player` and `escalated` tests must still pass unchanged — those branches never reach the bot gate.

- [ ] **Step 8: Run the whole backend suite**

Run: `pnpm --filter @support/api test`
Expected: PASS. Watch for `tests/surface.test.ts`, `tests/sdk.unread.test.ts` and `tests/agent.conversations.test.ts` — any of them that asserts a freshly created conversation is `open` is now asserting the old bug and must be updated to `bot_active`, not worked around in the service.

- [ ] **Step 9: Typecheck and commit**

```bash
pnpm typecheck
git add backend/src backend/tests
git commit -m "feat(surface): start conversations at bot_active and run a bot turn per player message"
```

---

## Task 8: Documentation

**Files:**
- Modify: `docs/project-overview.md`
- Modify: `docs/decisions/spec-contradictions.md`

**Interfaces:**
- Consumes: nothing. Produces: nothing. Documentation only — no test.

- [ ] **Step 1: Add the two new event types**

In `docs/project-overview.md`, the "Event types needed" paragraph (around line 227) currently ends `…form_skipped`, `sdk_incident`.` Extend the list and add the sentence that explains why the two are separate:

```markdown
Event types needed: `intent_set` (with `source: bot|agent`), `intent_corrected`,
`subintent_merged`, `article_shown`, `article_rejected`, `session_start`, `article_read`,
`still_need_help_reached`, `session_end`, `first_human_reply`, `conversation_resolved`,
`conversation_reopened`, `assignment_returned`, `form_started`, `form_completed`, `form_partial`,
`form_skipped`, `sdk_incident`, `bot_handoff`, `bot_unavailable`.

**`bot_handoff` and `bot_unavailable` are separate types.** A bot correctly recognising it cannot
help is a success; a bot crashing, timing out or being switched off is a failure. One number cannot
mean both, and folding them together would make the Bot-fallbacks metric lie. `bot_unavailable`
carries a `reason` that distinguishes a deliberately-disabled workspace from a crashing one.
See `docs/specs/2026-08-11-bot-turn-seam-and-handoff-design.md`.
```

- [ ] **Step 2: Record the assignment deviation**

In `docs/decisions/spec-contradictions.md`, append a new entry to the **"Contradictions with a decision"** section — immediately after `### 15. bot_config shape` and before the `## Contradictions still open` heading. Numbering continues from the highest existing number (15):

```markdown
---

### 16. Round-robin assignment

**Conflict:** `project-overview.md` says bot handoffs are auto-assigned "round-robin among active
agents". True round-robin needs a rotation cursor — a column or table row updated on every
assignment.

**Decision:** **Deterministic least-loaded.** `assignOnHandoff` picks the active member of the
workspace with the fewest conversations currently in a live status (`open`, `awaiting_player`,
`escalated` — not `resolved`, not `closed`), ties broken by `agent.id` ascending. A cursor would be
a second source of truth and a write-contention point on the busiest path in the system, for no
better distribution. Least-loaded is derivable from rows that already exist, needs no new column,
and is deterministic — which is what makes it testable without controlling a cursor's starting
position.

**Active** means `workspace_member.deactivated_at IS NULL` **and** `agent.status = 'active'`. Role
is not consulted: a small workspace may be one admin. **No active agent is not an error** —
`assigned_agent_id` stays NULL, the conversation lands in the unassigned queue, and the status flip
to `open` happens either way.

See `docs/specs/2026-08-11-bot-turn-seam-and-handoff-design.md` §7 and
`backend/src/domain/bot/assignOnHandoff.ts`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/project-overview.md docs/decisions/spec-contradictions.md
git commit -m "docs: record the two bot event types and the least-loaded assignment deviation"
```

---

## Final verification

- [ ] **Run everything**

```bash
docker compose up -d
pnpm db:setup
pnpm typecheck
pnpm test
```

Expected: typecheck clean, every package's suite green.

- [ ] **Confirm the slice ships as a correct, complete system**

With `stubDecider` in place and a workspace whose `bot_config.is_provisioned` is true, a first player message must produce: a conversation at `open`, an assigned agent (or the unassigned queue), one public system message reading *You're being connected to our support team.*, no internal note, and exactly one `bot_unavailable` event with `reason: 'not_implemented'`. That is the behaviour the non-negotiables demand when the bot is unavailable — nothing in this slice can be wrong because of a model, because no model runs.

---

## Notes for the implementer

- **`saveBotConfig` has no router.** No endpoint flips `is_provisioned`, so in production every workspace takes the not-provisioned path and the job path is exercised only by tests that call `saveBotConfig`/`seedBotConfig` directly. That gap is real and belongs to the bot-admin-screen slice — do not add an admin route here.
- **`answer` is fully implemented even though `stubDecider` never returns it.** It is the path spec 3 switches on; building it behind an injectable decider is what lets spec 3 be a one-function change. Do not stub it out.
- **Do not close the check-then-act race with a lock.** `runBotTurn` re-reads the status and stays quiet if it lost. A row lock held across the job's lifetime would block the agent instead — the current failure mode is silence, which is the safe direction.
- **Do not fold `bot_unavailable` into `bot_handoff`**, and do not swap `not_provisioned` to a handoff. A disabled bot is a fallback, not a bot making a good decision.
- **Do not delete `'not_implemented'`.** Spec 3 removes it, and the type error at `stubDecider` is what forces that removal.
