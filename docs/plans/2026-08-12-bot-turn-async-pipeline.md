# Bot Turn Async Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `bot-turns` BullMQ queue and worker, the `runBotTurn` orchestrator that gathers a conversation's state, calls an injected decider, applies the outcome and emits over sockets, and the one-line change to `sendPlayerMessage` that enqueues a turn after its transaction commits.

**Architecture:** One new domain module (`backend/src/domain/bot/orchestrator.ts`) holding the pure control flow — gather, guard, decide, apply, emit — decoupled from BullMQ so it is callable directly from a test with no Redis. One new jobs module (`backend/src/shared/jobs/botTurns.ts`) that owns everything BullMQ-shaped: the queue, the worker, retry policy, and the `failed` handler that runs the fallback outcome after the final attempt. `shared/jobs/queue.ts` is extended, not replaced, so `registerJobs()` stays the single entry point `server.ts` calls and the single `close()` it awaits on shutdown.

**Tech Stack:** TypeScript (native `.ts` ESM imports), BullMQ (already a dependency, see `shared/jobs/queue.ts`), ioredis, PostgreSQL 17 + Drizzle, Socket.io, Vitest.

**Source spec:** `docs/specs/2026-08-11-bot-turn-seam-and-handoff-design.md` (Status: Accepted, revised in part by spec 4). This plan implements **only** the async job pipeline half of that spec — see Global Constraints.

## Amendments (post-implementation, 2026-08-13)

This plan shipped as commits `08b3135`, `a761502`, `490e0cc`, `5031aa2`, `3263ea5`.
Three constraints were amended against what the code could actually do; the
Global Constraints below carry the corrected text and the reasoning:

1. Job id separator is `__`, not `:` — BullMQ rejects `:` in custom ids.
2. `BotTurnInput` is widened in Part 1's `botTurn.ts`, not redefined in `orchestrator.ts`.
3. The status guard is atomic with the apply (`applyDecisionIfBotActive`, `SELECT … FOR UPDATE`),
   and the error fallback goes through it — the original unguarded fallback let a
   bot handoff land on top of an agent's claim.

**The sample code blocks inside Tasks 1-3 predate these amendments** (they still
show `applyDecisionAndEmit` and a non-atomic guard). Where a sample block and the
Global Constraints disagree, the constraints and the landed code are authoritative.

## Global Constraints

- **This is Part 2 of 2.** Part 1 (`docs/plans/2026-08-12-bot-turn-domain-core.md`) builds and tests, independently of this plan: the schema delta (`conversation.subintent_id`, `subintent` `UNIQUE (workspace_id, id)`), `backend/src/domain/bot/botTurn.ts` (`BotTurnDecision`, `BotDecider`, `HandoffReason`, `UnavailableReason`, `SILENT_UNAVAILABLE_REASONS`, `stubDecider`), `backend/src/domain/bot/applyBotTurn.ts` (`applyBotTurn(tx, ctx, decision) => { posted, statusChanged }`), `backend/src/domain/bot/assignOnHandoff.ts`, `backend/src/domain/bot/messages.ts`, the `PostMessageInput.actorId` widening, and the not-provisioned synchronous branch and `bot_active`-default change inside `sendPlayerMessage`. **Do not reimplement any of that here** — import it. If a task below can't find one of these exports, that means Part 1 hasn't landed yet, not that this plan should build a substitute.
- **Interface contract this plan assumes from Part 1** (coordinate before merging if Part 1 lands with different names/shapes):
  - `applyBotTurn(tx: Tx, ctx: { workspaceId: string; conversationId: string }, decision: BotTurnDecision): Promise<{ posted: PostedMessageRow[]; statusChanged: boolean }>`
  - `stubDecider: BotDecider` where `BotDecider = (input: BotTurnInput) => Promise<BotTurnDecision>`
  - `sendPlayerMessage` computes a local `shouldEnqueue: boolean` inside its transaction (`true` when the conversation's status is `bot_active` and the bot is provisioned; `false` otherwise) and returns it alongside `conversationId`, `posted`, `inboxStatus` from the `withWorkspace` callback, plus a `seq` value equal to the conversation's post-increment `message_seq` (already returned by `postMessage` as part of `PostedMessageRow.seq`).
- **`BotTurnInput` lives in Part 1's `backend/src/domain/bot/botTurn.ts`, widened there by this plan** (`orchestrator.ts` imports and re-exports it). An earlier revision of this plan put the definition in `orchestrator.ts` on the grounds that `botTurn.ts` "depends on nothing" per the spec's Modules table — that does not work: `BotDecider` is declared in `botTurn.ts`, so a second `BotTurnInput` defined downstream would leave every decider's parameter typed as the narrow `{ workspaceId, conversationId }` and force a cast at the orchestrator's call site. The cost of widening in place is one type-only `import type { PlayerMessageView } from '@support/types'` in `botTurn.ts` — the shared wire-contract package, erased at compile time, no cycle — so that module is no longer literally dependency-free. The shape is unchanged:
  ```ts
  export type BotTurnInput = {
    workspaceId: string
    conversationId: string
    subintentId: string | null
    history: PlayerMessageView[]
  }
  ```
- **No LLM concerns, no turn budgets, no article-offer lifecycle, no form offering, no inactivity-resolution turn, no external alerting, no admin route, no `intent_corrected`.** All out of scope per the spec's own "Out of scope" section.
- **The orchestrator never imports BullMQ.** `runBotTurn` must be callable directly from a test with no Redis (spec §Modules: "the job calls the orchestrator, never the reverse").
- **Socket emits happen only after commit, and only in `orchestrator.ts` / `botTurns.ts` — never inside `applyBotTurn`.** Same discipline `postMessage` and `sendPlayerMessage` already follow.
- **Retries: 2 attempts, exponential backoff. The `failed` handler fires on every attempt** but only acts (`applyBotTurn` with `{ kind: 'unavailable', reason: 'error' }`) when `job.attemptsMade >= job.opts.attempts` — otherwise a two-attempt failure hands off twice.
- **The status guard must be atomic with the apply.** Both the error fallback and `runBotTurn`'s own apply go through `applyDecisionIfBotActive`, which inside one transaction does `SELECT status … FOR UPDATE` on the conversation, skips without applying (and without emitting) when the status is not `bot_active`, and otherwise calls `applyBotTurn` against that locked read. A guard in an earlier, separate transaction only narrows the race — an agent who claims the conversation after the check still gets a bot message written over their claim. `runBotTurn` keeps a cheap pre-decide status read so it does not invoke the decider needlessly, but that read is not the authoritative guard. Re-reading status is not the same as re-invoking the decider: the fallback still never depends on the thing that just failed.
- **Job id is `${conversationId}__${seq}`.** BullMQ dedups on it so a retried HTTP request or a double socket delivery cannot produce two bot turns for one player message. The separator is `__`, not `:`: BullMQ composes its Redis keys as `bull:<queue>:<jobId>`, so it rejects a custom id containing `:` outright (`Custom Id cannot contain :`, verified in bullmq 5.81.3, `classes/job.js:1075`). `__` keeps the split unambiguous — a UUID cannot contain `_` and `seq` is an integer.
- **Enqueue happens after the transaction commits, from `sendPlayerMessage`, never inside it.** Enqueue failure is logged and swallowed — the player's message already committed, and throwing would fail a request that succeeded.
- **`bot-turns` is a separate queue and worker from `support-jobs`, concurrency 5, registered from the same `registerJobs()` entry point and closed by the same `close()`.**
- Imports carry the `.ts` extension. Never `console.*` — use `logger` from `backend/src/shared/logging/logger.ts`.
- All commands run from the repo root: `/Users/hassanrashid/Desktop/git/mindstorm/crm/app`. Postgres **and Redis** must be up (`docker compose up -d`) for every test in this plan — `jobs.botTurns.test.ts` drives real BullMQ against real Redis, matching how `jobs.sessionTimeout.test.ts` drives real Postgres.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `backend/src/domain/bot/orchestrator.ts` | create | `runBotTurn(workspaceId, conversationId, decider)` — gather/guard/decide/apply/emit. Also exports `applyDecisionIfBotActive(workspaceId, conversationId, decision)`, the shared guarded apply+emit tail both `runBotTurn` and the worker's `failed` handler call. |
| `backend/src/domain/bot/botTurn.ts` | modify | Part 1's module — `BotTurnInput` widened here with `subintentId` and `history` (see Global Constraints). |
| `backend/src/shared/jobs/botTurns.ts` | create | `enqueueBotTurn(input)`, `registerBotTurnWorker(decider?)` — the only file that knows about BullMQ for bot turns. |
| `backend/src/shared/jobs/queue.ts` | modify | `registerJobs()` also calls `registerBotTurnWorker()` and merges its `close()` into the returned one. |
| `backend/src/surface/services/messagesService.ts` | modify | After commit, `if (result.shouldEnqueue) enqueueBotTurn({ workspaceId, conversationId, seq })`. |
| `backend/tests/bot.orchestrator.test.ts` | create | `runBotTurn` gather/guard/decide/apply/emit, driven directly with a fake decider — no Redis. |
| `backend/tests/jobs.botTurns.test.ts` | create | Queue/worker wiring: job calls the orchestrator with the right ids, retry-then-fail-once, `stubDecider` → `not_implemented` with no note, jobId dedup, distinct worker closed alongside `support-jobs`. |
| `backend/tests/surface.messages.test.ts` | modify | Provisioned branch enqueues exactly one job with id `${conversationId}:${seq}`; reopen and `awaiting_player → open` enqueue nothing. |

---

### Task 1: `runBotTurn` orchestrator

**Files:**
- Create: `backend/src/domain/bot/orchestrator.ts`
- Test: `backend/tests/bot.orchestrator.test.ts`

**Interfaces:**
- Consumes (from Part 1, assumed to already exist): `BotTurnDecision`, `BotDecider`, `HandoffReason`, `UnavailableReason` from `../../src/domain/bot/botTurn.ts`; `applyBotTurn` from `../../src/domain/bot/applyBotTurn.ts`. Also consumes `toPlayerView`, `PostedMessageRow` from `../../src/domain/conversations/index.ts`; `withWorkspace`, `Tx` from `../../src/shared/db/withWorkspace.ts`; `conversation`, `message` from `../../src/shared/db/schema/index.ts`; `emitInboxChanged`, `emitMessageToRooms` from `../../src/shared/realtime/emit.ts`; `getIo` from `../../src/shared/realtime/socketServer.ts`; `toAgentView` from `../../src/domain/conversations/index.ts`.
- Produces: the widened `BotTurnInput` in `botTurn.ts`, re-exported here (see Global Constraints), `runBotTurn(workspaceId: string, conversationId: string, decider: BotDecider): Promise<void>`, `applyDecisionIfBotActive(workspaceId: string, conversationId: string, decision: BotTurnDecision): Promise<{ applied: true; posted: PostedMessageRow[]; statusChanged: boolean } | { applied: false }>` — both used by Task 2's worker.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/bot.orchestrator.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { conversation, event, message } from '../src/shared/db/schema/index.ts'
import { runBotTurn } from '../src/domain/bot/orchestrator.ts'
import type { BotTurnDecision, BotTurnInput } from '../src/domain/bot/botTurn.ts'
import { closeOwnerPool, seedConversation, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function setConversationStatus(conversationId: string, status: string): Promise<void> {
  await withWorkspace('', async () => {}).catch(() => {}) // no-op placeholder removed below
}

describe('runBotTurn', () => {
  it('re-reads status and no-ops when the conversation left bot_active before the job ran', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })
    await withWorkspace(workspaceId, (tx) =>
      tx.update(conversation).set({ status: 'open' }).where(eq(conversation.id, conversationId)),
    )

    let deciderCalled = false
    const decider = async (_input: BotTurnInput): Promise<BotTurnDecision> => {
      deciderCalled = true
      return { kind: 'answer', reply: 'hi', subintentId: null }
    }

    await runBotTurn(workspaceId, conversationId, decider)

    expect(deciderCalled).toBe(false)
    const rows = await withWorkspace(workspaceId, (tx) => tx.select().from(message).where(eq(message.conversationId, conversationId)))
    expect(rows).toHaveLength(0)
    const events = await withWorkspace(workspaceId, (tx) => tx.select().from(event))
    expect(events).toHaveLength(0)
  })

  it('gathers subintent_id and public history, passes them to the decider, and applies + emits the result', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })

    let seenInput: BotTurnInput | null = null
    const decider = async (input: BotTurnInput): Promise<BotTurnDecision> => {
      seenInput = input
      return { kind: 'unavailable', reason: 'error' }
    }

    await runBotTurn(workspaceId, conversationId, decider)

    expect(seenInput).not.toBeNull()
    expect(seenInput!.workspaceId).toBe(workspaceId)
    expect(seenInput!.conversationId).toBe(conversationId)
    expect(seenInput!.subintentId).toBeNull()
    expect(seenInput!.history).toEqual([])

    const rows = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    )
    expect(rows[0]!.status).toBe('open')

    const events = await withWorkspace(workspaceId, (tx) => tx.select().from(event).where(eq(event.type, 'bot_unavailable')))
    expect(events).toHaveLength(1)
  })

  it('filters internal messages out of the history handed to the decider', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })
    const { seedMessage } = await import('./helpers/db.ts')
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player', visibility: 'public', body: 'hello' })
    await seedMessage({ workspaceId, conversationId, seq: 2, authorType: 'agent', visibility: 'internal', body: 'secret note' })

    let seenInput: BotTurnInput | null = null
    const decider = async (input: BotTurnInput): Promise<BotTurnDecision> => {
      seenInput = input
      return { kind: 'noop' }
    }

    await runBotTurn(workspaceId, conversationId, decider)

    expect(seenInput!.history.map((m) => m.body)).toEqual(['hello'])
  })

  it('propagates a throw from the decider without applying anything', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })

    const decider = async (): Promise<BotTurnDecision> => {
      throw new Error('decider blew up')
    }

    await expect(runBotTurn(workspaceId, conversationId, decider)).rejects.toThrow('decider blew up')

    const rows = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    )
    expect(rows[0]!.status).toBe('bot_active')
  })
})
```

Delete the unused `setConversationStatus` placeholder function above before running — it was left in accidentally; the test body updates status inline with `withWorkspace` directly, as shown in the first `it`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter backend test bot.orchestrator -- --run`
Expected: FAIL with "Cannot find module '../src/domain/bot/orchestrator.ts'" (or similar — the file doesn't exist yet).

- [ ] **Step 3: Implement `orchestrator.ts`**

```ts
import { eq } from 'drizzle-orm'
import type { Server } from 'socket.io'
import type { PlayerMessageView } from '@support/types'
import { applyBotTurn } from './applyBotTurn.ts'
import type { BotDecider, BotTurnDecision } from './botTurn.ts'
import { toAgentView, toPlayerView, type PostedMessageRow } from '../conversations/index.ts'
import { conversation, message } from '../../shared/db/schema/index.ts'
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts'
import { emitInboxChanged, emitMessageToRooms } from '../../shared/realtime/emit.ts'
import { getIo } from '../../shared/realtime/socketServer.ts'

export type BotTurnInput = {
  workspaceId: string
  conversationId: string
  subintentId: string | null
  history: PlayerMessageView[]
}

type GatherResult = {
  status: string
  subintentId: string | null
} | null

async function gather(tx: Tx, conversationId: string): Promise<{ conv: GatherResult; history: PlayerMessageView[] }> {
  const [conv] = await tx
    .select({ status: conversation.status, subintentId: conversation.subintentId })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1)

  const rows = await tx.select().from(message).where(eq(message.conversationId, conversationId)).orderBy(message.seq)
  const history = rows.map(toPlayerView).filter((m): m is PlayerMessageView => m !== null)

  return { conv: conv ?? null, history }
}

function emitApplied(io: Server, workspaceId: string, conversationId: string, result: { posted: PostedMessageRow[]; statusChanged: boolean }): void {
  for (const row of result.posted) {
    emitMessageToRooms(io, conversationId, toPlayerView(row), toAgentView(row))
  }
  if (result.statusChanged) {
    emitInboxChanged(io, workspaceId, conversationId, 'open')
  }
}

/**
 * Shared by `runBotTurn`'s own apply/emit step and the BullMQ `failed` handler
 * (`shared/jobs/botTurns.ts`) — the fallback outcome after a final retry attempt
 * runs through the exact same apply-then-emit path a successful decide does.
 */
export async function applyDecisionAndEmit(
  workspaceId: string,
  conversationId: string,
  decision: BotTurnDecision,
): Promise<{ posted: PostedMessageRow[]; statusChanged: boolean }> {
  const result = await withWorkspace(workspaceId, (tx) => applyBotTurn(tx, { workspaceId, conversationId }, decision))
  emitApplied(getIo(), workspaceId, conversationId, result)
  return result
}

/**
 * The status is re-read here, not trusted from the enqueue site: an agent may have
 * claimed or replied to the conversation in the window between enqueue and this job
 * running. A no-op is the safe outcome of that race — see spec §4.
 */
export async function runBotTurn(workspaceId: string, conversationId: string, decider: BotDecider): Promise<void> {
  const { conv, history } = await withWorkspace(workspaceId, (tx) => gather(tx, conversationId))

  if (!conv || conv.status !== 'bot_active') return

  const decision = await decider({ workspaceId, conversationId, subintentId: conv.subintentId, history })

  await applyDecisionAndEmit(workspaceId, conversationId, decision)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter backend test bot.orchestrator -- --run`
Expected: PASS (all four tests). If `applyBotTurn` or `botTurn.ts` don't exist yet because Part 1 hasn't landed, these tests fail at import time — land Part 1 first, or stub those two modules locally with the exact shapes from the Interface contract above, then swap in Part 1's real modules before merging.

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/bot/orchestrator.ts backend/tests/bot.orchestrator.test.ts
git commit -m "feat: add runBotTurn orchestrator with gather/guard/decide/apply/emit"
```

---

### Task 2: `bot-turns` BullMQ queue and worker

**Files:**
- Create: `backend/src/shared/jobs/botTurns.ts`
- Modify: `backend/src/shared/jobs/queue.ts`
- Test: `backend/tests/jobs.botTurns.test.ts`

**Interfaces:**
- Consumes: `runBotTurn`, `applyDecisionIfBotActive` from `../../domain/bot/orchestrator.ts` (Task 1); `stubDecider` from `../../domain/bot/botTurn.ts` (Part 1); `getEnv` from `../../env.ts`; `logger` from `../logging/logger.ts`.
- Produces: `enqueueBotTurn(input: { workspaceId: string; conversationId: string; seq: number }): Promise<void>`, `registerBotTurnWorker(decider?: BotDecider): { close(): Promise<void> }` — both consumed by Task 3 (`messagesService.ts`) and by `queue.ts`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/jobs.botTurns.test.ts`:

```ts
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { conversation, event, message } from '../src/shared/db/schema/index.ts'
import { enqueueBotTurn, registerBotTurnWorker } from '../src/shared/jobs/botTurns.ts'
import type { BotDecider, BotTurnDecision } from '../src/domain/bot/botTurn.ts'
import { closeOwnerPool, seedConversation, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

let activeWorker: { close: () => Promise<void> } | null = null

afterEach(async () => {
  if (activeWorker) {
    await activeWorker.close()
    activeWorker = null
  }
})

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('waitFor timed out')
}

describe('bot-turns queue and worker', () => {
  it('runs a job against the workspace and conversation it was enqueued for', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })

    let seenWorkspaceId = ''
    let seenConversationId = ''
    const decider: BotDecider = async (input) => {
      seenWorkspaceId = input.workspaceId
      seenConversationId = input.conversationId
      return { kind: 'unavailable', reason: 'error' }
    }
    activeWorker = registerBotTurnWorker(decider)

    await enqueueBotTurn({ workspaceId, conversationId, seq: 1 })

    await waitFor(async () => seenConversationId === conversationId)
    expect(seenWorkspaceId).toBe(workspaceId)
  })

  it('retries a throwing decider to the attempt limit, then applies the error fallback exactly once', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })

    let attempts = 0
    const decider: BotDecider = async () => {
      attempts += 1
      throw new Error('decider blew up')
    }
    activeWorker = registerBotTurnWorker(decider)

    await enqueueBotTurn({ workspaceId, conversationId, seq: 1 })

    await waitFor(async () => {
      const events = await withWorkspace(workspaceId, (tx) => tx.select().from(event).where(eq(event.type, 'bot_unavailable')))
      return events.length === 1
    }, 10_000)

    expect(attempts).toBe(2)
    const events = await withWorkspace(workspaceId, (tx) => tx.select().from(event).where(eq(event.type, 'bot_unavailable')))
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({ reason: 'error' })

    const rows = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, conversationId)),
    )
    expect(rows[0]!.status).toBe('open')
  })

  it('the default worker uses stubDecider, producing bot_unavailable(not_implemented) with no internal note', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })

    activeWorker = registerBotTurnWorker()
    await enqueueBotTurn({ workspaceId, conversationId, seq: 1 })

    await waitFor(async () => {
      const events = await withWorkspace(workspaceId, (tx) => tx.select().from(event).where(eq(event.type, 'bot_unavailable')))
      return events.length === 1
    })

    const events = await withWorkspace(workspaceId, (tx) => tx.select().from(event).where(eq(event.type, 'bot_unavailable')))
    expect(events[0]!.payload).toMatchObject({ reason: 'not_implemented' })

    const rows = await withWorkspace(workspaceId, (tx) => tx.select().from(message).where(eq(message.conversationId, conversationId)))
    expect(rows.filter((r) => r.visibility === 'internal')).toHaveLength(0)
    expect(rows.filter((r) => r.visibility === 'public')).toHaveLength(1)
  })

  it('deduplicates two enqueues of the same conversationId:seq into one job', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' })
    const playerId = await seedPlayer(workspaceId, 'UserId1')
    const conversationId = await seedConversation({ workspaceId, playerId })

    let runCount = 0
    const decider: BotDecider = async (): Promise<BotTurnDecision> => {
      runCount += 1
      return { kind: 'unavailable', reason: 'error' }
    }
    activeWorker = registerBotTurnWorker(decider)

    await enqueueBotTurn({ workspaceId, conversationId, seq: 7 })
    await enqueueBotTurn({ workspaceId, conversationId, seq: 7 })

    await waitFor(async () => runCount >= 1)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(runCount).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter backend test jobs.botTurns -- --run`
Expected: FAIL with "Cannot find module '../src/shared/jobs/botTurns.ts'".

- [ ] **Step 3: Implement `botTurns.ts`**

```ts
import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'
import { getEnv } from '../../env.ts'
import { logger } from '../logging/logger.ts'
import { applyDecisionAndEmit, runBotTurn } from '../../domain/bot/orchestrator.ts'
import { stubDecider, type BotDecider } from '../../domain/bot/botTurn.ts'

const QUEUE_NAME = 'bot-turns'

type BotTurnJobData = { workspaceId: string; conversationId: string; seq: number }

function connection(): IORedis {
  return new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null })
}

let queueConnection: IORedis | undefined
let queue: Queue<BotTurnJobData> | undefined

function getQueue(): Queue<BotTurnJobData> {
  if (!queue) {
    queueConnection = connection()
    queue = new Queue<BotTurnJobData>(QUEUE_NAME, { connection: queueConnection })
  }
  return queue
}

/**
 * Enqueued after sendPlayerMessage's transaction commits — never inside it, so a
 * rolled-back message can never spawn a turn. Failure here is logged and
 * swallowed: the player's message already committed, and throwing would fail a
 * request that succeeded (spec §10).
 */
export async function enqueueBotTurn(input: BotTurnJobData): Promise<void> {
  try {
    await getQueue().add('bot-turn', input, {
      jobId: `${input.conversationId}:${input.seq}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    })
  } catch (error) {
    const err = error as Error
    logger.error('jobs', `enqueueBotTurn failed: ${err.name} ${err.message}`)
  }
}

/**
 * `decider` defaults to `stubDecider` for production use; tests inject their own
 * to exercise retry and fallback behaviour without a real model.
 */
export function registerBotTurnWorker(decider: BotDecider = stubDecider): { close: () => Promise<void> } {
  const workerConnection = connection()

  const worker = new Worker<BotTurnJobData>(
    QUEUE_NAME,
    async (job) => {
      await runBotTurn(job.data.workspaceId, job.data.conversationId, decider)
    },
    { connection: workerConnection, concurrency: 5 },
  )

  worker.on('failed', (job, error) => {
    logger.error('jobs', `bot-turn failed: ${error.name} ${error.message}`)
    if (!job) return
    const attempts = job.opts.attempts ?? 1
    if (job.attemptsMade < attempts) return
    // Last attempt exhausted: the fallback must not itself depend on the thing
    // that just failed, so this calls applyDecisionAndEmit directly rather than
    // going through the decider again.
    void applyDecisionAndEmit(job.data.workspaceId, job.data.conversationId, { kind: 'unavailable', reason: 'error' }).catch(
      (fallbackError: Error) => {
        logger.error('jobs', `bot-turn error fallback failed: ${fallbackError.name} ${fallbackError.message}`)
      },
    )
  })

  return {
    close: async () => {
      await worker.close()
      await getQueue().close()
      workerConnection.disconnect()
      queueConnection?.disconnect()
      queue = undefined
      queueConnection = undefined
    },
  }
}
```

- [ ] **Step 4: Wire the worker into `registerJobs()`**

Modify `backend/src/shared/jobs/queue.ts`:

```ts
import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'
import { getEnv } from '../../env.ts'
import { logger } from '../logging/logger.ts'
import { closeStaleSessions } from './sessionTimeout.ts'
import { registerBotTurnWorker } from './botTurns.ts'

const QUEUE_NAME = 'support-jobs'
const SESSION_TIMEOUT_JOB = 'session-timeout'

function connection(): IORedis {
  return new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null })
}

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
      if (closed > 0) logger.info('jobs', `closed ${closed} stale session(s)`)
    },
    { connection: workerConnection, concurrency: 1 },
  )

  worker.on('failed', (job, error) => {
    logger.error('jobs', `${job?.name ?? 'unknown'} failed: ${error.name} ${error.message}`)
  })

  const botTurns = registerBotTurnWorker()

  return {
    close: async () => {
      await worker.close()
      await queue.close()
      queueConnection.disconnect()
      workerConnection.disconnect()
      await botTurns.close()
    },
  }
}
```

Only the three marked lines changed: the new import, the `registerBotTurnWorker()` call, and the `await botTurns.close()` line — everything else is the existing file unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `docker compose up -d && pnpm --filter backend test jobs.botTurns -- --run`
Expected: PASS (all five tests). These hit real Redis, so a flaky first run (Redis still warming up) should be re-run once before treating it as a real failure.

- [ ] **Step 6: Run the full backend suite to check nothing broke**

Run: `pnpm --filter backend test -- --run`
Expected: PASS, including the unmodified `jobs.sessionTimeout.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/shared/jobs/botTurns.ts backend/src/shared/jobs/queue.ts backend/tests/jobs.botTurns.test.ts
git commit -m "feat: add bot-turns BullMQ queue and worker with retry fallback"
```

---

### Task 3: Enqueue from `sendPlayerMessage`

**Files:**
- Modify: `backend/src/surface/services/messagesService.ts`
- Test: `backend/tests/surface.messages.test.ts`

**Interfaces:**
- Consumes: `enqueueBotTurn` from `../../shared/jobs/botTurns.ts` (Task 2). Consumes `shouldEnqueue: boolean` and `seq: number`, both assumed already present on the object `withWorkspace`'s callback returns in the post-Part-1 version of this file (see Global Constraints' Interface Contract). If Part 1 lands with different field names, adjust the destructuring in Step 3 to match — the enqueue call itself does not change.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/surface.messages.test.ts` (alongside the existing suite — do not replace it; these are additive assertions on top of Part 1's not-provisioned tests):

```ts
import { enqueueBotTurn } from '../src/shared/jobs/botTurns.ts'

vi.mock('../src/shared/jobs/botTurns.ts', () => ({ enqueueBotTurn: vi.fn().mockResolvedValue(undefined) }))

// ... inside the existing describe block, alongside the not-provisioned tests already
// written for Part 1:

it('enqueues exactly one bot-turn job with id conversationId:seq when the bot is provisioned', async () => {
  const workspaceId = await seedWorkspace({ slug: 'demo-game' })
  await seedBotConfig({ workspaceId, isProvisioned: true })
  const token = await issuePlayerToken(workspaceId, 'UserId1')

  const response = await request(app)
    .post('/surface/messages')
    .set('Authorization', `Bearer ${token}`)
    .send({ body: 'hello' })
  expect(response.status).toBe(200)

  expect(enqueueBotTurn).toHaveBeenCalledTimes(1)
  const call = vi.mocked(enqueueBotTurn).mock.calls[0]![0]
  expect(call.workspaceId).toBe(workspaceId)
  expect(call.conversationId).toBe(response.body.conversation_id)
  expect(typeof call.seq).toBe('number')
})

it('does not enqueue on the reopen branch', async () => {
  // ...seed a resolved conversation for a returning player, as the existing
  // reopen test above this one already does, then send a message and assert
  // enqueueBotTurn was not called.
  const workspaceId = await seedWorkspace({ slug: 'demo-game' })
  await seedBotConfig({ workspaceId, isProvisioned: true })
  const playerId = await seedPlayer(workspaceId, 'UserId1')
  const conversationId = await seedConversation({ workspaceId, playerId })
  await withWorkspace(workspaceId, (tx) => tx.update(conversation).set({ status: 'resolved' }).where(eq(conversation.id, conversationId)))
  const token = await issuePlayerToken(workspaceId, 'UserId1')

  await request(app).post('/surface/messages').set('Authorization', `Bearer ${token}`).send({ body: 'hello again' })

  expect(enqueueBotTurn).not.toHaveBeenCalled()
})

it('does not enqueue on the awaiting_player -> open branch', async () => {
  const workspaceId = await seedWorkspace({ slug: 'demo-game' })
  await seedBotConfig({ workspaceId, isProvisioned: true })
  const playerId = await seedPlayer(workspaceId, 'UserId1')
  const conversationId = await seedConversation({ workspaceId, playerId })
  await withWorkspace(workspaceId, (tx) =>
    tx.update(conversation).set({ status: 'awaiting_player' }).where(eq(conversation.id, conversationId)),
  )
  const token = await issuePlayerToken(workspaceId, 'UserId1')

  await request(app).post('/surface/messages').set('Authorization', `Bearer ${token}`).send({ body: 'answer' })

  expect(enqueueBotTurn).not.toHaveBeenCalled()
})
```

Adjust the exact request-building helpers (`issuePlayerToken`, `app`, import paths for `eq`/`withWorkspace`/`conversation`/`seedConversation`/`seedPlayer`/`seedBotConfig`) to match whatever this file already imports for its existing tests — these three tests are meant to sit inside the existing `describe`/`beforeEach` structure, not stand alone.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter backend test surface.messages -- --run`
Expected: FAIL — `enqueueBotTurn` is never called because `messagesService.ts` doesn't call it yet.

- [ ] **Step 3: Add the enqueue call**

Modify `backend/src/surface/services/messagesService.ts` — add the import and the one post-commit line (everything else in the function is Part 1's, unchanged):

```ts
import { enqueueBotTurn } from '../../shared/jobs/botTurns.ts'
```

```ts
  const playerView = toPlayerView(result.posted)
  const agentView = toAgentView(result.posted)
  emitMessageToRooms(getIo(), result.conversationId, playerView, agentView)
  if (result.inboxStatus) {
    emitInboxChanged(getIo(), ctx.workspaceId, result.conversationId, result.inboxStatus)
  }
  if (result.shouldEnqueue) {
    await enqueueBotTurn({ workspaceId: ctx.workspaceId, conversationId: result.conversationId, seq: result.posted.seq })
  }

  return { conversation_id: result.conversationId, message: playerView }
```

If Part 1's actual return shape from the `withWorkspace` callback names the flag or the seq field differently, destructure accordingly — the call to `enqueueBotTurn` itself is exactly this shape regardless.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter backend test surface.messages -- --run`
Expected: PASS, including Part 1's not-provisioned tests (unaffected) and the three new ones above.

- [ ] **Step 5: Run the full backend suite**

Run: `pnpm --filter backend test -- --run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/surface/services/messagesService.ts backend/tests/surface.messages.test.ts
git commit -m "feat: enqueue a bot turn after sendPlayerMessage commits"
```

---

## Self-Review

**Spec coverage:**
- §10 dedicated queue, `concurrency: 5`, separate from `support-jobs`, registered/closed from the same entry point → Task 2.
- §10 retries: 2 attempts, exponential backoff, `failed` fires every attempt but only acts on the last → Task 2.
- §10 job id `${conversationId}:${seq}`, dedup → Task 2 (test 4).
- §10 enqueue after commit, swallow failure → Task 2 Step 3 (`try/catch` + `logger.error`), Task 3 (call site).
- Phase 3 (gather/guard/decide/apply/emit, history via `toPlayerView` with nulls filtered) → Task 1.
- `tests/jobs.botTurns.test.ts` bullet list (job runs with right ids, retry-then-fail-once, stub → not_implemented no note, dedup, distinct worker closed together) → Task 2 tests 1–4 plus Step 4's wiring into `queue.ts`'s single `close()`.
- `tests/surface.messages.test.ts` provisioned/reopen/`awaiting_player` enqueue assertions → Task 3.
- Everything under the spec's "Out of scope" heading is untouched by any task here.

**Placeholder scan:** the stray `setConversationStatus` helper in Task 1 Step 1 is flagged inline for deletion rather than left as dead code — replaced by the direct `withWorkspace` call in the same test. No other `TBD`/"add appropriate" language present.

**Type consistency:** `BotTurnInput` (widened in `botTurn.ts` by Task 1) is used identically in Task 2's tests (`input.workspaceId`, `input.conversationId`) and matches the Interface Contract in Global Constraints. `applyDecisionIfBotActive`'s signature is identical between its Task 1 definition and its Task 2 call site (worker's `failed` handler). `enqueueBotTurn`'s parameter shape (`{ workspaceId, conversationId, seq }`) matches between its Task 2 definition and its Task 3 call site.
