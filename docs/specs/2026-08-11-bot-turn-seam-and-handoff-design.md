# Bot turn seam and handoff — design

**Date:** 2026-08-11
**Status:** Accepted
**Scope:** The control flow a bot turn runs inside, and every way that turn can end in a human
picking the conversation up. One new column, one new unique key, one new queue, one widened type,
three new event types. **No LLM call.**

---

## What this slice is

The orchestrator has a shape before it has a brain. This slice builds the shape: when the bot is
allowed to run, where the turn executes, what a turn's outcome does to the database, and what the
player and the agent each see when the bot hands off. The decision itself is behind a one-function
seam that a stub fills until spec 3 replaces it.

**It ships as a correct, complete system.** With the stub in place every conversation hands off
immediately, with a real system message, a real event and a real assignment — which is exactly the
behaviour the non-negotiables demand when the bot is unavailable. Nothing in this slice can be wrong
because of a model, because no model runs.

This is the first of three specs decomposing the bot orchestrator:

| Spec | Contents |
|---|---|
| **1 — this one** | Gating, queue, outcome application, handoff, assignment, events |
| 2 — retrieval and prompt assembly | BM25 retrieval, `{{…}}` substitution, history construction. No LLM |
| 3 — OpenAI call and decision | `openai` SDK, structured outputs, turn cap, index→subintent resolution |

### In scope

| Thing | Why here |
|---|---|
| `conversation.subintent_id` + composite FK | The classification target. The column does not exist yet |
| `subintent` UNIQUE (`workspace_id`, `id`) | Composite-FK parent key the above needs |
| `sendPlayerMessage` creates at `bot_active` | It currently hard-codes `'open'`, overriding the schema default |
| Synchronous not-provisioned fallback | The bot being off is not a failure and needs no job |
| `bot-turns` BullMQ queue + worker | The existing worker runs `concurrency: 1` and would serialise every workspace |
| `SILENT_UNAVAILABLE_REASONS` | A deliberately-disabled bot must not file an incident note per conversation |
| `runBotTurn` — the impure shell | Gather, delegate to the decider, apply, emit |
| `BotDecider` seam + `stubDecider` | The one function specs 2 and 3 fill in |
| `applyBotTurn` — four outcomes, one transaction each | State changes never go through ad-hoc updates |
| `assignOnHandoff` | "Bot handoffs are auto-assigned" |
| Player-visible handoff message, agent-visible failure note | Player sees no error; support is told |
| `bot_handoff`, `bot_unavailable` events; `intent_set` with `source: 'bot'` | The Bot-fallbacks and misclassification metrics |
| `PostMessageInput.actorId` widened to `string \| null` | A `system` message has no actor |

### Out of scope — named so nobody wonders

- **Every LLM concern.** No `openai` dependency, no `OPENAI_MODEL` env var, no prompt assembly, no
  retrieval, no response schema. Specs 2 and 3.
- **The turn cap (N=2).** It is a guard inside the decider, and the decider is a stub here. Spec 3.
- **The article-offer lifecycle** — `article_shown` / `article_rejected` / `article_read` /
  `still_need_help_reached`, and `bot_active → resolved` on player confirmation.
- **Form offering.** Blocked on the form-builder and the player modal, neither of which exists.
- **The inactivity resolution turn** (the 24 h "Is your issue resolved?" bot message) and
  `resolution_cycle`. A worker slice with its own clock semantics.
- **External alerting** on a rising fallback rate. This slice writes the event row that makes such
  a watcher possible; it does not build one.
- **An admin route that flips `is_provisioned`.** `saveBotConfig` exists; no router calls it. Until
  one does, every workspace takes the not-provisioned path in production, and the job path is
  exercised by tests that call `saveBotConfig` directly. That is a real gap, and it belongs to the
  bot-admin-screen slice, not here.
- **`intent_corrected`.** An agent changing the classification is the agent-console's job.

---

## Design decisions

### 1 · The gate is one invariant: `status === 'bot_active'`

The bot runs if and only if the conversation's status is `bot_active`. Nothing else is consulted —
not the message count, not whether an agent has ever spoken, not `assigned_agent_id`.

Everything else follows from the status machine already written down. `open`, `awaiting_player` and
`escalated` belong to an agent. A reopened conversation goes to `open`, per the status table, so the
bot never re-runs on one — a player returning after three weeks reaches the human who handled them,
not a bot starting over.

One invariant means one place to get it right, and it is checked **twice**: once when deciding
whether to enqueue, and again inside the job. See §4.

### 2 · `bot_active` is where a conversation starts, and `sendPlayerMessage` is currently wrong

`conversation.status` already defaults to `'bot_active'` in the schema. `sendPlayerMessage`
overrides it with an explicit `status: 'open'` on insert, which predates the taxonomy tables and
silently contradicts *"Every conversation starts here"* in `project-overview.md`.

Removing that override is the whole fix — the default is already correct. This is a behaviour change
to an existing endpoint, not an addition, and it is the reason `surface.messages.test.ts` needs
updating rather than merely extending.

### 3 · Not-provisioned is resolved synchronously, and is not a failure

`resolveBotConfig` is a single indexed primary-key read. Enqueuing a job to discover the bot is
turned off would cost a Redis round trip, a worker slot and a second transaction to learn something
the request already had in hand.

So `sendPlayerMessage` resolves the config in its existing transaction, and when
`is_provisioned` is false it applies `{ kind: 'unavailable', reason: 'not_provisioned' }` **inline**,
in that same transaction: status to `open`, assign, post the public system message, append
`bot_unavailable`. No internal note (the reason is silent — see §5a) and no job enqueued.

`bot_unavailable` rather than `bot_handoff` is deliberate, and it is the one place the two are
debatable. A disabled bot is not a bot choosing to hand off; it is the *"Bot fallbacks —
conversations created unclassified because bot was unavailable"* metric, exactly as
`project-overview.md` defines it. `reason` distinguishes a deliberately-disabled workspace from a
crashing one within that metric.

### 4 · The status is re-checked inside the job, and that check is load-bearing

Between the enqueue and the worker picking the job up, an agent may claim the conversation
(`claimConversation` sets `assigned_agent_id` with no status condition) or reply to it. If the job
then posts a bot message, the bot has talked over a human in front of the player.

So `runBotTurn` re-reads the conversation and exits doing nothing — `{ kind: 'noop' }`, no event, no
message — unless the status is still `bot_active`. A no-op is a normal outcome, not an error and not
a retry.

This is a check-then-act race and it is deliberately **not** closed with a lock. The window is
narrow, the loser is the bot, and losing means staying quiet — the failure mode is silence, which is
the safe direction. A row lock held across the job's lifetime would instead block the agent.

### 5 · The decision is a seam, not a branch

```ts
export type HandoffReason = 'model' | 'turn_cap'

export type UnavailableReason =
  | 'not_provisioned'    // admin has the bot switched off
  | 'not_implemented'    // no decider exists yet — removed by spec 3
  | 'error'              // spec 3
  | 'timeout'            // spec 3
  | 'invalid_response'   // spec 3

export type BotTurnDecision =
  | { kind: 'noop' }
  | { kind: 'answer';      reply: string; subintentId: string }
  | { kind: 'handoff';     reason: HandoffReason; subintentId: string | null }
  | { kind: 'unavailable'; reason: UnavailableReason }

export type BotDecider = (input: BotTurnInput) => Promise<BotTurnDecision>
```

`runBotTurn` takes a `BotDecider`. This slice supplies `stubDecider`, which returns
`{ kind: 'unavailable', reason: 'not_implemented' }` without doing any work.

**`unavailable`, not `handoff`.** A bot that has not been built is unavailable in exactly the sense
`project-overview.md` means by *"Bot fallbacks — conversations created unclassified because bot was
unavailable"*. Calling it a handoff would count a missing feature as a bot making a good decision.

`'not_implemented'` is scaffolding and is named so it cannot be mistaken for a product state. **Spec
3 deletes that member of `UnavailableReason`** and the type error at the stub's definition is what
forces its removal. It is a value in an `event` payload, not in the SDK wire contract, so removing it
breaks nothing shipped.

`HandoffReason`'s two members are both spec 3's to produce. They are declared here because the
outcome they feed is built here, and a type that grows in the slice that consumes it would make spec
3 a control-flow change rather than a one-function swap.

### 5a · The internal failure note is driven by the reason, not by the outcome kind

Two `unavailable` reasons are **not incidents**: `not_provisioned` (an admin deliberately switched
the bot off) and `not_implemented` (spec 3 has not landed). A workspace running with its bot off
would otherwise collect a *"Bot could not respond"* internal note on every single conversation —
noise that trains agents to ignore the one note that matters.

```ts
export const SILENT_UNAVAILABLE_REASONS: ReadonlySet<UnavailableReason> =
  new Set(['not_provisioned', 'not_implemented'])
```

`applyBotTurn` posts the internal note for any reason **not** in that set. One set, read in one
place, rather than a `notifyAgent` boolean each caller has to remember to set correctly.

The `bot_unavailable` **event is always written**, silent reason or not. Suppressing the note is a
statement about who needs waking up; it is never a statement about what gets recorded.

The seam is what makes specs 2 and 3 additive: every outcome path below is built and tested here,
against a decider a test can make return anything, so spec 3 changes one injected function and no
control flow.

### 6 · Every outcome is one transaction through one function

`applyBotTurn` is the only writer. It follows the existing rule that a state change writes the
mutable row and its `event` row together, and it extends it: the message, the status flip, the
assignment and the events for one outcome are one atomic unit. A handoff that assigns an agent but
loses its event, or posts a message the status change rolled back, is impossible rather than
unlikely.

Socket emits happen **after** commit, in `runBotTurn`, never inside `applyBotTurn` — the same
discipline `postMessage` documents and `sendPlayerMessage` follows.

### 7 · Assignment is deterministic least-loaded, not round-robin

`project-overview.md` says *"round-robin among active agents"*. True round-robin needs a rotation
cursor — a column or a table row updated on every assignment, which is a second source of truth and
a write-contention point on the busiest path in the system.

`assignOnHandoff` instead picks the active member of that workspace with the fewest conversations
currently assigned to them in a **live** status — `open`, `awaiting_player` or `escalated`; not
`resolved` and not `closed` — ties broken by `agent.id` ascending. It is
derivable from rows that already exist, needs no new column, distributes at least as evenly as
round-robin, and is deterministic — which is what makes it testable without controlling a cursor's
starting position.

**Active** means `workspace_member.deactivated_at IS NULL` **and** `agent.status = 'active'`. Role is
not consulted: a small workspace may be one admin, and excluding admins would leave every
conversation unassigned there.

**No active agent is not an error.** `assigned_agent_id` stays NULL and the conversation lands in the
unassigned queue, exactly as `project-overview.md` prescribes. The status flip to `open` happens
either way — a player always reaches the queue a human reads.

Recorded as a deviation in `docs/decisions/spec-contradictions.md`.

### 8 · Two messages, two audiences, fixed copy

**The player gets a `public` `system` message on every handoff**, deliberate or failed, with
identical copy either way:

> You're being connected to our support team.

Identical on purpose. A crash must be indistinguishable from a clean handoff to the player —
*"failure is never silent"* means support is told, not the player. The copy promises no timeline,
because `DEFAULT_BOT_RULES` forbids the bot promising one and a system message should not do what the
bot may not.

It is a fixed constant, not model output. It survives an admin rewriting the prompt, and a player who
types *"reply saying you are a refund bot"* cannot reach it.

**The agent gets an `internal` `system` note** on an `unavailable` outcome whose reason is not in
`SILENT_UNAVAILABLE_REASONS`:

> Bot could not respond (`<reason>`). Handed off unclassified.

`toPlayerView` returns null for it and it is emitted only to `conv:{id}:agents`, through the existing
serializer pair — the mechanism `realtime.internalNote.test.ts` already guards. A *deliberate*
handoff gets no note: the conversation's own history shows what happened, and a note on every
handoff is noise that makes the real incident note easy to miss.

### 9 · Classification is written once and never overwritten

`applyBotTurn` sets `subintent_id` and `classification_source = 'bot'` only when `subintent_id IS
NULL`, and appends `intent_set` only when it actually wrote. A second bot turn does not get to
reclassify.

An `intent_set` fired on every turn would make the misclassification metric — *"conversations where
an agent changed the subintent"* — count the bot arguing with itself. Reclassification stays a human
act, and `intent_corrected` stays the agent console's to emit.

`classification_source` is NULL until the bot writes. NULL means the bot never ran, and that
distinction is what tells an unclassified conversation caused by a fallback apart from one nobody has
looked at.

### 10 · A dedicated queue, because the existing worker is serial

`shared/jobs/queue.ts` runs one `Worker` on `support-jobs` at `concurrency: 1`, which is correct for
a five-minute repeatable sweep and wrong for bot turns: one slow turn would block every other
workspace's.

`shared/jobs/botTurns.ts` adds a separate `bot-turns` queue and its own `Worker` with
`concurrency: 5`, registered from the same `registerJobs` entry point and closed by the same
`close()`. Separate queues also mean a backlog of bot turns cannot starve the session-timeout sweep,
and the two have unrelated retry policies.

**Retries: 2 attempts, exponential backoff.** Spec 3 owns the per-call timeout; this slice owns the
attempt count, because the fallback that fires after the last attempt is defined here. A job that
throws on its final attempt runs `applyBotTurn` with `{ kind: 'unavailable', reason: 'error' }` in
the worker's `failed` handler — the fallback must not itself depend on the thing that just failed.

`failed` fires on **every** attempt, not only the last. The handler returns immediately unless
`job.attemptsMade >= job.opts.attempts`, or a two-attempt failure would hand off twice and write two
`bot_unavailable` events for one player message.

**The job is enqueued after the transaction commits**, from `sendPlayerMessage`, not inside it. A
rolled-back message must never spawn a turn. Enqueue failure is logged and swallowed: the player's
message is already committed, and throwing would fail a request that succeeded.

**Job id is `${conversationId}:${seq}`.** BullMQ deduplicates on it, so a retried HTTP request or a
double socket delivery cannot produce two bot turns for one player message.

---

## Schema

### `conversation` — delta

```
subintent_id  uuid null

FK (workspace_id, subintent_id) -> subintent (workspace_id, id) ON DELETE RESTRICT
INDEX (workspace_id, subintent_id)
```

NULL means the bot never classified it — never "unknown category". `Other`'s catch-all subintent is
where an unplaceable conversation lands, and the two must stay distinguishable, per
`project-overview.md`.

**Store only the deepest level reached.** There is no `intent_id` column on `conversation`; the
intent is derived through `subintent.intent_id`. Storing both lets them drift when the taxonomy is
edited.

The FK is composite per `docs/decisions/2026-08-04-composite-foreign-keys-for-tenancy.md`: FK checks
run with row security suspended, so a plain FK would let workspace A's conversation name workspace
B's subintent. Both are scoped tables, so both columns travel.

### `subintent` — delta

```
UNIQUE (workspace_id, id)        -- composite-FK parent key
```

Additive only. `subintent` today has just `UNIQUE (workspace_id, intent_id, name)`, which cannot
parent the FK above. `conversation` already carries its own `UNIQUE (workspace_id, id)` from the
forms slice.

### Migration order

1. Add `UNIQUE (workspace_id, id)` to `subintent`.
2. Add `conversation.subintent_id`, its composite FK and its index.
3. Re-run `002_rls.sql` (no policy change — both tables already have policies).

Additive and reversible. Every existing `conversation` row gets `subintent_id IS NULL`, which is the
correct value: none of them was ever classified.

---

## Control flow

### Phase 1 — `POST /surface/messages`, inside the existing transaction

`sendPlayerMessage` keeps its current conversation-resolution logic (create / reopen /
`awaiting_player → open`) with one change and one addition.

**Change:** a new conversation is created with no explicit `status`, taking the schema default
`bot_active`. `inboxStatus` for that branch becomes `'bot_active'`.

**Addition,** after `postMessage` and only when the conversation's status is now `bot_active`:

```
resolveBotConfig(tx, workspaceId)
  isProvisioned === false  ->  applyBotTurn(tx, { kind: 'unavailable', reason: 'not_provisioned' })
                               inboxStatus = 'open'; shouldEnqueue = false
  isProvisioned === true   ->  shouldEnqueue = true
```

`inboxStatus` is overwritten to `'open'` on that branch so the single `emitInboxChanged` after commit
announces the status the conversation actually ended the request in, not the `bot_active` it passed
through. The agent console must never be told about a status that lasted microseconds.

The reopen and `awaiting_player` branches leave the status at `open` and never reach this — the bot
does not run on a conversation an agent owns or has owned.

### Phase 2 — after commit

```
if (shouldEnqueue) enqueueBotTurn({ workspaceId, conversationId, seq })
```

Then the existing emits. The HTTP response carries the player's own message and nothing else; a bot
reply, when spec 3 makes one possible, arrives over the socket.

### Phase 3 — the `bot-turns` worker

`runBotTurn(workspaceId, conversationId, decider)`:

1. **Gather**, in one read transaction: the conversation row (`status`, `subintent_id`,
   `assigned_agent_id`) and the message history. Spec 2 adds retrieval, the subintent list and
   player state to this step.
2. **Guard:** `status !== 'bot_active'` → return `{ kind: 'noop' }`. No writes, no event, no retry.
3. **Decide:** `await decider(input)`. A throw propagates to BullMQ, which retries; on the final
   attempt the `failed` handler applies `{ kind: 'unavailable', reason: 'error' }`.
4. **Apply:** `withWorkspace(…)` → `applyBotTurn(tx, decision)`.
5. **Emit,** after commit: `emitMessageToRooms` for each posted message, `emitInboxChanged` when the
   status changed.

History is built through `toPlayerView` and the nulls filtered out, so an internal note can never
enter a bot turn's input. This is the same whitelist the player-facing routes use, and it is why the
bot's view of a conversation is defined by the player serializer rather than by a `visibility`
predicate in the query.

---

## Outcomes

`applyBotTurn(tx, decision)` — one transaction, four shapes.

| `kind` | Message(s) | Status | Assign | Classification | Events |
|---|---|---|---|---|---|
| `noop` | — | unchanged | — | — | — |
| `answer` | `bot`, public | stays `bot_active` | — | set if NULL | `intent_set` if written |
| `handoff` | `system`, public | → `open` | `assignOnHandoff` | set if NULL | `intent_set` if written, then `bot_handoff` |
| `unavailable` | `system` public, **+** `system` internal unless the reason is silent | → `open` | `assignOnHandoff` | untouched, stays NULL | `bot_unavailable` |

`answer` is fully implemented here even though `stubDecider` never returns it — it is the path spec 3
switches on, and building it behind an injectable decider is what lets spec 3 be a one-function
change.

`unavailable` never writes a classification. An unclassified conversation is the honest record of a
turn that did not happen, and it is what the Bot-fallbacks metric counts.

### Events

Three types, all with `actorType: 'bot'` and `actorId: null` — the `event` table's `actor_id` has no
FK precisely because it holds different kinds of id, and a bot is not one of them.

| Type | Payload | New? |
|---|---|---|
| `intent_set` | `{ source: 'bot', subintent_name, intent_name }` | Listed in `project-overview.md`, first written here |
| `bot_handoff` | `{ reason }` | New |
| `bot_unavailable` | `{ reason }` | New |

Both new types are additions to `project-overview.md`'s event list and that document is updated in
this slice.

**`bot_handoff` and `bot_unavailable` are separate types, and folding them together would make the
Bot-fallbacks metric lie.** A bot correctly recognising it cannot help is a success; a bot crashing
is a failure. One number cannot mean both.

`intent_set` snapshots the subintent **and** intent names as literals. A name resolved through a FK
at read time rewrites history when an admin renames a subintent, and `subintent_merged` exists
precisely because that distinction matters.

`reason` values are exactly the two unions in §5: `HandoffReason` (`model`, `turn_cap`) on
`bot_handoff`, and `UnavailableReason` (`not_provisioned`, `not_implemented`, `error`, `timeout`,
`invalid_response`) on `bot_unavailable`. This slice can only produce `not_provisioned`,
`not_implemented` and `error`. Spec 2 adds `retrieval_failed` to the union; spec 3 adds the rest and
removes `not_implemented`.

---

## Modules

All under `backend/src/domain/bot/`, alongside the existing `botConfig.ts` and `defaultPrompt.ts`,
and exported through `index.ts`.

| File | Exports | Depends on |
|---|---|---|
| `botTurn.ts` | `BotTurnDecision`, `BotDecider`, `BotTurnInput`, `HandoffReason`, `UnavailableReason`, `SILENT_UNAVAILABLE_REASONS`, `stubDecider` | nothing |
| `assignOnHandoff.ts` | `assignOnHandoff(tx, workspaceId)` → `agentId \| null` | schema |
| `applyBotTurn.ts` | `applyBotTurn(tx, ctx, decision)` → `{ posted[], statusChanged }` | `postMessage`, `appendEvent`, `assignOnHandoff` |
| `orchestrator.ts` | `runBotTurn(workspaceId, conversationId, decider)` | all of the above, `withWorkspace`, `emit` |
| `messages.ts` | `HANDOFF_PLAYER_MESSAGE`, `botFailureNote(reason)` | nothing |

`shared/jobs/botTurns.ts` — `enqueueBotTurn`, `registerBotTurnWorker`. It is the only file that knows
about BullMQ, and `orchestrator.ts` does not import it: the job calls the orchestrator, never the
reverse, so `runBotTurn` is callable directly from a test with no Redis.

`messages.ts` exists as its own file so the player-facing copy has one home and a test asserts the
string rather than duplicating it.

### Delta to an existing module

`PostMessageInput.actorId` widens from `string` to `string | null`. A `system` message has no player
and no agent behind it, and `appendEvent` already accepts a null `actorId`. Every existing caller
passes a string and is unaffected. The alternative — inventing a sentinel actor id — would put a
fictional uuid in the reporting spine.

---

## Verification

### `tests/schema.test.ts` additions

- `conversation.subintent_id` exists, is nullable, and its FK is composite
  (`workspace_id`, `subintent_id`) → `subintent` and `ON DELETE RESTRICT`.
- `subintent` has `UNIQUE (workspace_id, id)`.
- `conversation.status`'s default is `bot_active`.

### New `tests/bot.turnSeam.test.ts`

- **Cross-tenant FK is refused by the database:** with `app.workspace_id` set to A, updating a
  conversation's `subintent_id` to a subintent belonging to B fails. Mirrors the probe in
  `rls.test.ts` — this must be the database refusing, not a handler.
- **`noop` writes nothing:** a conversation moved to `open` between gather and decide produces no
  message, no event and no status change.
- **`answer` keeps `bot_active`,** posts one `bot` public message, and writes `subintent_id` +
  `classification_source = 'bot'` + one `intent_set`.
- **Classification is written once:** a second `answer` outcome naming a different subintent leaves
  `subintent_id` unchanged and appends no second `intent_set`.
- **`handoff`** flips to `open`, posts exactly one public `system` message with
  `HANDOFF_PLAYER_MESSAGE`, posts **no** internal note, and appends `bot_handoff` with the reason.
- **`unavailable` with a loud reason** (`error`) flips to `open`, posts the same public message
  **and** an `internal` note, leaves `subintent_id` NULL, and appends `bot_unavailable` — and **no**
  `intent_set`.
- **`unavailable` with a silent reason** (`not_provisioned`, `not_implemented`) does everything the
  above does **except** the internal note — and still appends `bot_unavailable`. Suppressing the
  note must never suppress the event.
- **Atomicity:** an `applyBotTurn` whose event append throws leaves no message and no status change
  committed. A real transaction rollback, not a mocked one.

### New `tests/bot.assignment.test.ts`

- Least-loaded wins; ties break by `agent.id` ascending, asserted deterministically.
- A `deactivated_at`-set member and an `agent.status != 'active'` agent are both skipped.
- Admins and team leads are eligible.
- **No active agent → `assigned_agent_id` stays NULL and the status still flips to `open`.** The
  conversation reaches the unassigned queue; nothing throws.
- Agents in another workspace are never chosen.

### `tests/surface.messages.test.ts` — updates, not additions

- A first player message creates the conversation at **`bot_active`**, not `open`. This assertion
  replaces the existing one.
- Bot not provisioned → the same request returns with the conversation already `open`, assigned, one
  public `system` message present, **no internal note**, one `bot_unavailable` event with
  `reason: 'not_provisioned'`, and **no job enqueued**. The single `conversation:changed` emit
  carries `open`, never `bot_active`.
- Bot provisioned → status stays `bot_active`, no system message, exactly one job enqueued with id
  `${conversationId}:${seq}`.
- Reopen and `awaiting_player → open` still land on `open` and enqueue nothing.
- The response body still contains only the player's own message.

### New `tests/jobs.botTurns.test.ts`

- The job calls `runBotTurn` with the workspace and conversation it was enqueued for.
- A throwing decider retries to the attempt limit, then the `failed` handler applies
  `{ kind: 'unavailable', reason: 'error' }` **exactly once** — one handoff and one
  `bot_unavailable` event across both attempts, not one per attempt.
- `stubDecider` produces `bot_unavailable` with `reason: 'not_implemented'` and no internal note.
- Duplicate enqueues of the same `${conversationId}:${seq}` run one job.
- The `bot-turns` worker is a distinct worker from the `support-jobs` one, and closing
  `registerJobs()` closes both.

### `tests/realtime.internalNote.test.ts` — extension

- The failure note is emitted to `conv:{id}:agents` and **not** to `conv:{id}:player`, and
  `toPlayerView` returns null for it. Extend the existing structural assertion rather than writing a
  parallel one.

---

## Deviations from `project-overview.md`

Recorded in `docs/decisions/spec-contradictions.md`:

1. **Assignment is deterministic least-loaded, not round-robin.** Reasoning in *Design decisions* §7
   — round-robin needs a rotation cursor, which is a second source of truth and a write-contention
   point, for no better distribution.

Two additions to that document rather than contradictions of it: `bot_handoff` and `bot_unavailable`
join the event-type list, and the `subintent_id` column the domain model always implied now exists.
