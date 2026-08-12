# Bot tool-calling decider — design

**Date:** 2026-08-12
**Status:** Accepted
**Supersedes:** `2026-08-11-bot-openai-call-and-decision-design.md` (spec 3)
**Scope:** The decider, as a bounded tool loop rather than a single structured-output call. One
dependency, one new column, one new outcome kind, five tools, four new event types.

---

## What this slice is

Spec 1 defined `BotDecider` and filled it with `stubDecider`. Spec 2 filled `BotTurnInput` with a
fully assembled prompt. Spec 3 proposed replacing the stub with one structured-output call that
returned `answer` or `handoff`.

**This replaces spec 3.** One call cannot express the bot the product describes: retrieval has to
happen *after* the model has read the problem and phrased a query, the article offer has to be
followed by a confirmation the player owns, and classification has to land before a human is
reached. Those are sequential decisions within one player turn, which is what a tool loop is.

Specs 1 and 2 stand, with the deltas named in *Deltas* below. `runBotTurn`, `applyBotTurn`,
`assignOnHandoff`, the `bot-turns` queue and its `failed`-handler fallback are unchanged.

| Spec | Contents |
|---|---|
| 1 — bot turn seam and handoff | Gating, queue, outcome application, handoff, assignment, events |
| 2 — retrieval and prompt assembly | Hybrid retrieval, taxonomy view, player context, history, substitution |
| ~~3 — OpenAI call and decision~~ | Superseded by this document |
| **4 — this one** | The tool loop, five tools, budgets, `bot_phase`, context assembly, reopen |

### In scope

| Thing | Why here |
|---|---|
| `openai` dependency, `OPENAI_MODEL` env | The call |
| `openaiClient.ts` | One chat completion with tools, 15 s timeout, `temperature: 0` |
| `tools.ts` — five tool definitions and handlers | The decider's vocabulary |
| `toolLoop.ts` — bounded loop → `BotTurnDecision` | The real `BotDecider` |
| `conversation.bot_phase` | The guard that makes a turn resumable without a checkpointer |
| Context assembly — deterministic state block, pinned first message, windowing | *"It doesn't start asking questions again"* |
| Fifth outcome `resolve` | `bot_active → resolved`, player-confirmed |
| Article-offer lifecycle | `bot_article_offered`, `bot_article_rejected` |
| Reopen posts the handoff message and assigns | Spec 1 leaves the reopen branch bare |
| Turn budgets — 4 tool calls, 8 bot messages | The runaway guards |
| `Other` intent + catch-all subintent, seeded | Carried unchanged from spec 3 §5 |
| Delete `stubDecider`, remove `not_implemented` | The scaffolding spec 1 named for removal |

### Out of scope — named so nobody wonders

- **Forms.** The builder, the player modal, versioning, submission storage, `skip_form`. `handoff`
  performs the `subintent → form` lookup and finds nothing mapped, because nothing can be mapped
  yet. The forms slice populates that map and adds a `form` value to `bot_phase`; no control flow
  here changes.
- **The inactivity turn.** The 24 h *"Is your issue resolved?"* message and `resolution_cycle`. A
  worker slice with its own clock semantics.
- **LangChain and LangGraph.** Reasoning in §9.
- **Streaming.** The reply is posted as one message after the turn commits.
- **LLM summarisation of history.** §7 — the state block is rendered from columns and events.
- **Per-workspace model choice, token accounting, spend caps.** Usage is logged; nothing caps it.
- **Tuning.** The budgets, `alpha`, the temperature and the model are constants and env vars.

---

## Design decisions

### 1 · The model acts within a turn; the code owns every transition between turns

The model may search, classify, offer an article, read a confirmation and ask for a human. It may
not decide when a turn begins, when one ends, what a handoff says to the player, which form is
shown, or that a conversation is finished.

This is the same line spec 1 drew for the handoff copy and spec 3 drew for the turn cap, applied
generally: **a guarantee the product makes is never left to the model's judgment when the code can
hold it.** Every one of the guarantees below is structural rather than prompted.

| Guarantee | Held by |
|---|---|
| The player can always reach a human | `handoff` offered in every phase; fallback in the `failed` handler |
| The bot never decides it is done | No `resolve` tool. `confirm_resolution` exists only while the player has been asked |
| The form is never skipped on the way to a human | Form and handoff are one tool, not two |
| An admin's form mapping is authoritative | The form is a lookup, not a model choice |
| Classification is written once | `classify` is write-once in code |
| The handoff copy is fixed | A constant spec 1 never lets the model write |

### 2 · Nothing infers when code runs

There is no scheduler. Every path has a concrete trigger, and only one involves the model.

| Trigger | Model? | Effect |
|---|---|---|
| `POST /surface/messages` | **yes** — the tool loop | Enqueue a turn; `applyBotTurn` when the loop returns |
| Tap **Yes** on "Did this solve it?" | no | Same path as `confirm_resolution(true)` |
| Tap **No** | no | Same path as `confirm_resolution(false)` |
| Tap **Talk to a person** | no | Same path as `handoff('asked_for_person')` |
| Inactivity job at 24 h | no | Fixed copy (out of scope here) |
| The loop returns | — | `applyBotTurn`, one transaction |

**The chat is the interface; buttons are accelerators.** Every transition is reachable by typing,
and a tap converges on identical code and identical events. The buttons exist because a tap is
unambiguous and free, not because they are the primary path.

### 3 · Five tools

| Tool | Available | Effect |
|---|---|---|
| `search_articles(query)` | always, ≤3 per turn | Hybrid Weaviate query (spec 2). No side effects. Returns `{id, title, summary}[]` |
| `classify(subintent_index)` | always, **write-once per conversation** | A second call is accepted and ignored |
| `offer_article(article_id)` | always; the id must have been returned by `search_articles` **in this turn** | Posts the article, sets `bot_phase = 'article_confirm'` |
| `confirm_resolution(helped)` | **only while `bot_phase = 'article_confirm'`** | `true` → `resolve`. `false` → `handoff('article_rejected')` |
| `handoff(reason)` | **always, every phase** | Terminal. Reason drives the metrics, not the mechanism |

**`search_articles` is a tool rather than a prefetch**, which is the substantive change from spec 2's
one-shot retrieval. Retrieval fired against the player's raw words runs BM25 over *"paid, got
nothing"*; a model that reads the message, queries *"missing in-app purchase not delivered"*, reads
the titles and re-queries will beat it. Retrieval is cheap, side-effect-free and idempotent — the
textbook case for letting the model drive it.

**`offer_article` validates against this turn's search results**, so a hallucinated or remembered
article id cannot reach a player. The check is on the id set returned by `search_articles` during
the current loop, not on the articles table.

**`confirm_resolution` is scoped, and that scope is the whole safety argument.** Outside the window
where the bot has actually asked *"did this solve it?"*, a model reading *"ok thanks"* as
confirmation would let the bot close its own conversations — the one thing
`project-overview.md` forbids it. Inside that window the player is answering a direct yes/no
question, which is precisely what *player-confirmed* means. The tool is not offered to the model at
all when the phase is anything else, so this is a property of the request, not of the prompt.

**There is no `resolve` tool and no `show_form` tool.** Ever.

### 4 · Form and handoff are one tool, because the form is how handoff happens

The form exists so an agent does not re-ask what the bot already gathered. As two tools, the model
could reach a human without one, and that guarantee would depend on the model choosing correctly
every time. As one tool it is structurally unreachable around.

```
handoff(reason)
  → classify never called?        → no form possible, assign now
  → subintent has no form mapped? → assign now
  → otherwise                     → show form → submitted or skipped → assign
```

**In this slice every conversation takes one of the first two branches**, because no form can be
mapped yet. The third is written, unreachable, and tested against a seeded mapping so the forms
slice is a data change rather than a control-flow change.

Form-before-human is therefore **the rule with named exceptions, not an invariant** — a distinction
worth writing down so nobody later reads "always" and builds on it. The exceptions are the two
above plus a bot that never ran at all.

### 5 · `classify` never called means NULL, and the code never fabricates a classification

| Situation | `subintent_id` |
|---|---|
| Bot down, disabled, or errored — no model ran | **NULL** |
| Player asked for a human without describing a problem — `classify` never called | **NULL** |
| `classify` called, model picked a real subintent | that subintent |
| `classify` called, model picked `Other`, or the index did not resolve | **`Other`** |

The discriminator is mechanical: **was `classify` invoked**. Not "did the bot run", and not a
judgment about whether the message contained a problem.

The two values carry different meanings and feed different numbers, and folding them together
breaks both:

- **`Other`** — the bot read a problem and found no subintent that fits. *"Rising volume in Other is
  itself a signal: the taxonomy is missing something real."*
- **NULL** — nothing was classified. This is the *Bot fallbacks* metric.

Stamping `Other` on conversations where the player simply demanded a human would flood it — the
reporting mockup puts *"asked for a person"* at 23% of conversations — and turn a content signal
into a queue-impatience signal.

**No ticket reaches an agent looking blank.** The console renders NULL as an explicit state,
qualified by `handoff_reason` (`asked_for_person` / `error` / `not_provisioned`), the same way the
player-state panel renders missing data — *"never a blank panel and never an error"*. That is a
display rule. It is not a licence to write something untrue into the column.

### 6 · One column, no checkpointer

`conversation.bot_phase` is an enum: `none | article_confirm`. The forms slice adds `form`.

It is a **guard, not a scheduler**. It decides whether `confirm_resolution` is offered to the model
at all, and it rejects a replayed or forged confirmation on a conversation that was never asked —
the same job `status === 'bot_active'` does in spec 1 §4.

**No LangGraph checkpointer, and resumability is the reason rather than the obstacle.** Every
message is already a durable row with a server-assigned sequence, so rebuilding a turn's context is
a `SELECT` and a five-day gap costs exactly what a five-second one does. A checkpointer would store
the same messages a second time, in tables with no RLS policy, no `workspace_id` and hard deletes,
holding player text and player-state-adjacent data that is PII by default. It would also be
invisible to the agent console, which has to render the same history, and would put
cross-version deserialisation of five-day-old serialised objects on the critical path.

The database is the checkpoint. It is a better one.

### 7 · Context is assembled from structured state, not summarised

A resumed turn must not re-ask what has already been asked. Most of what has to survive a gap is
**already in columns and events**, not buried in the transcript, so it is rendered rather than
recalled:

```
system    the assembled prompt (spec 2) — admin prompt, rules, {{subintents}}, {{articles}}
user      player context (spec 3 §3) — "reported by the game client, not verified"
user      ── conversation state ──
          Classified as: Purchases → Missing purchase
          Article offered: "Why didn't my gems arrive?" — rejected
          Player was last here 5 days ago
messages  transcript — player → user, bot → assistant, in seq order
```

The state block is generated from `subintent_id`, `bot_phase` and the event rows. **Not by an LLM
summarisation pass:** that costs a call, is non-deterministic against `temperature: 0`, and can
hallucinate that the bot asked something it did not — which is the exact failure this block exists
to prevent. Rendering from columns is assertable with a string comparison.

Windowing, which a `bot_active` conversation will rarely reach given §8's ceiling:

- **The first player message is always included, pinned.** It is the original problem statement, and
  recency-truncation drops it precisely when a conversation is long enough to need it.
- The last 20 messages verbatim; anything elided is replaced by a marked count.
- Internal notes never enter — already enforced by spec 1's `toPlayerView` filter, not by a second
  predicate here.

### 8 · Two budgets, and neither is a product rule

| Budget | Counts | Limit | On exhaust |
|---|---|---|---|
| `MAX_TOOL_CALLS_PER_TURN` | tool calls within one loop | 4 | Force `handoff('unsure')` |
| `MAX_BOT_MESSAGES` | `bot`-authored messages in the conversation | 8 | Force `handoff('turn_cap')`, **no model call** |

Spec 3's `MAX_BOT_TURNS = 2` is replaced. Counted as bot messages it conflated *turns spent
classifying* with *turns spent answering*, and a greeting exhausted it:

```
player: hi
bot:    what seems to be the problem?     ← turn 1
player: I've got a problem
bot:    can you tell me more?             ← turn 2
→ handoff, unclassified, to a human
```

A bare *"hi"* now produces a reply with **zero tool calls** and costs nothing, because the loop's
budget is tool calls rather than messages. The message ceiling remains as a runaway guard and is
deliberately generous — it is not the mechanism by which conversations reach humans, `handoff` is.

Both caps are enforced in code, not in `rules`. `rules` is an admin-editable free-text field with no
validation; the only thing between a player and an unbounded loop must not be a string someone can
delete. Both fail toward a human.

### 9 · The `openai` SDK, and neither LangChain nor LangGraph

**LangChain's primary value is its integration ecosystem, and we do not use it.** Spec 2 queries
Weaviate directly through `weaviate-client` v3 with a tuned hybrid `alpha`. Adopting LangChain would
mean surrendering direct control of that query to gain a wrapper around it.

**Its secondary value is provider portability, which is already built and better sized.** Spec 1's
`BotDecider` and spec 3's *"the SDK stays behind one file"* are two layers of abstraction over a
system that makes one call shape. Per-workspace model choice is explicitly out of scope, so the
multi-provider case does not exist.

**LangGraph's primary value is durable execution, checkpoints and `interrupt()`,** all of which §6
rejects on tenancy and PII grounds. What remains of the graph runtime is a bounded `while` loop.

**LangSmith tracing does not require either.** `wrapOpenAI` from the `langsmith` package traces a
plain client, so the observability is available without the framework. *Verify against current
docs before adopting — same treatment as the model id below.*

The cost side is not neutral: the hard constraint is *nothing may prevent a player reaching a
human*, and that path having one vendor-maintained dependency rather than four fast-moving ones is
worth something real.

**When this decision should be revisited** — any one of these and LangGraph earns its place:

- Per-workspace model choice becomes a requirement.
- The bot must suspend mid-reasoning and resume days later with intermediate state intact — not
  *"wait for a form submission"*, which `bot_phase` handles.
- Parallel fan-out within one turn (search several phrasings concurrently, merge).
- Streaming partial replies with mid-stream interrupts.

`BotDecider` makes any of those a one-file change, which is what spec 1 built the seam for.

### 10 · `bot_active` is one-way

Once a conversation leaves `bot_active` it never returns. `open` means a human owns it, and it means
only that.

**Every reopen goes to `open` and posts `HANDOFF_PLAYER_MESSAGE`.** Spec 1 leaves its reopen branch
bare; the player needs to know a human is coming, and the copy is the one they have already seen in
that situation. This fires on reopen from `resolved` / `closed` only — **not** on
`awaiting_player → open`, where the player is replying to an agent mid-conversation and *"you're
being connected to our support team"* would be noise.

**Reopen assignment**, which spec 1 also lacks:

| Previous state | Assignment |
|---|---|
| Bot-resolved — never assigned to anyone | `assignOnHandoff` |
| Agent-resolved, previous owner still active | Keep them — *"the player never has to re-explain"* |
| Agent-resolved, previous owner deactivated | `assignOnHandoff` |

This rule is why §7's five-day case is a human pickup by design, and it is reinforced by the
inactivity clock: a conversation idle for five days has already been asked *"is your issue
resolved?"* and resolved on no reply, so the returning player reopens rather than resuming.

It also simplifies two things downstream — `bot_phase` never needs resetting, and `classify`'s
write-once rule never needs a reset path.

---

## Schema

### `conversation` — delta

```
bot_phase  text not null default 'none'   CHECK (bot_phase IN ('none','article_confirm'))
```

The forms slice widens the check to include `'form'`. Existing rows take `'none'`, which is correct:
none of them has been offered an article.

No index. It is read only alongside the conversation row itself, always by primary key.

`subintent_id`, its composite FK and its index land in spec 1 and are unchanged here.

---

## Control flow

`toolLoop(input)` — the `BotDecider`.

1. **Budget guard.** `botMessageCount >= MAX_BOT_MESSAGES` → return
   `{ kind: 'handoff', reason: 'turn_cap' }`. **No model call.**
2. **Assemble** messages per §7.
3. **Loop**, up to `MAX_TOOL_CALLS_PER_TURN`:
   - Call the model with the tool set for the current `bot_phase`.
   - No tool call → the model produced text. Exit with `{ kind: 'answer', reply }`.
   - `search_articles` → run it, append the result, continue.
   - `classify` → record the resolved subintent, append an acknowledgement, continue.
   - `offer_article` → validate the id against this turn's results, exit with
     `{ kind: 'answer', reply, articleId }`.
   - `confirm_resolution(true)` → exit `{ kind: 'resolve' }`. `(false)` → exit
     `{ kind: 'handoff', reason: 'article_rejected' }`.
   - `handoff(reason)` → exit `{ kind: 'handoff', reason }`.
4. **Budget exhausted** → `{ kind: 'handoff', reason: 'unsure' }`.

The loop never writes. It returns a `BotTurnDecision` and `applyBotTurn` performs every write in one
transaction, exactly as spec 1 requires. Socket emits happen after commit, in `runBotTurn`.

A throw — API error, non-2xx, network failure, 15 s timeout — propagates to BullMQ, which retries
once; the `failed` handler applies `{ kind: 'unavailable', reason: 'error' | 'timeout' }`. A refusal
or an unparseable tool argument returns `{ kind: 'unavailable', reason: 'invalid_response' }` and is
**not** retried: a deterministic input that produced a refusal will produce it again.

---

## Outcomes

`applyBotTurn` gains a fifth shape. The other four are spec 1's, unchanged.

| `kind` | Message(s) | Status | Phase | Assign | Classification | Events |
|---|---|---|---|---|---|---|
| `noop` | — | unchanged | unchanged | — | — | — |
| `answer` | `bot`, public | stays `bot_active` | `article_confirm` if an article was offered | — | set if `classify` ran and NULL | `intent_set`, `bot_article_offered` |
| `resolve` | **none** | → `resolved` | → `none` | — | set if written | `conversation_resolved` with `source: 'bot'` |
| `handoff` | `system`, public | → `open` | → `none` | `assignOnHandoff` | set if written | `intent_set`, `bot_article_rejected` if the reason is `article_rejected`, `bot_handoff` |
| `unavailable` | `system` public **+** `system` internal unless silent | → `open` | → `none` | `assignOnHandoff` | untouched, stays NULL | `bot_unavailable` |

**`resolve` posts no message.** The player has just answered *"did this solve it?"* with yes; a bot
replying *"great, marking this resolved"* adds a turn to a conversation that is over. The
player-visible status changes to **Resolved**, which is the confirmation, and the event carries the
record. Every other outcome posts because the player is being told something they do not already
know.

### Events

Four new types on top of spec 1's three, all `actorType: 'bot'`, `actorId: null`.

| Type | Payload |
|---|---|
| `bot_article_offered` | `{ article_id, article_title }` — title snapshotted, per the `intent_set` precedent |
| `bot_article_rejected` | `{ article_id }` |
| `conversation_resolved` | `{ source: 'bot', confirmed_by: 'player' }` |
| `conversation_reopened` | `{ previous_resolution_source: 'bot' \| 'agent' \| 'timeout' }` |

`bot_article_offered` / `bot_article_rejected` are what make *"which article the bot offered, and
whether the player rejected it"* recoverable — a record `project-overview.md` lists as required and
which the article-rejection panel in reporting cannot exist without.

`conversation_reopened` carries the previous resolution source because a bot-resolved conversation
that reopens is a bot-quality signal — the answer did not actually work — and an agent-resolved one
that reopens is a different fact entirely. One number cannot mean both.

Article titles are snapshotted as literals. A name resolved through a FK at read time rewrites
history when an admin edits an article, and *"deleting an article must not break the record of which
article the bot offered on past conversations."*

---

## Environment

```
OPENAI_APIKEY   required   already exists
OPENAI_MODEL    required   no default — an unset value fails at boot through the Zod env schema
```

`.env.example` carries `gpt-5.4-mini`.

> **Verify before implementing:** that exact model id, and that it supports parallel tool calling
> with `strict` tool schemas. This spec was written past the author's knowledge cutoff; the id is
> what the project owner intends to run, not a verified value.

---

## Modules

All under `backend/src/domain/bot/`, exported through `index.ts`.

| File | Exports | Notes |
|---|---|---|
| `openaiClient.ts` | `callModel(messages, tools)` | The only file that imports `openai`. Timeout, temperature, retries-off live here |
| `tools.ts` | `TOOL_DEFS`, `toolsForPhase(phase)`, handlers | The five tools and the phase gate on `confirm_resolution` |
| `toolLoop.ts` | `toolLoopDecider: BotDecider` | The loop, both budgets, outcome mapping |
| `contextAssembly.ts` | `buildMessages(input)` | §7 — state block, pinning, windowing, role split |
| `fallbackSubintent.ts` | `resolveFallbackSubintent(tx, workspaceId)` | The `Other` lookup, carried from spec 3 §5 |

`callModel` returns a validated response or throws a typed error, so `toolLoop` maps errors to
reasons and never inspects an SDK exception shape.

### Deltas to specs 1 and 2

- `botTurn.ts` — `HandoffReason` becomes `asked_for_person | article_rejected | no_article |
  sensitive | unsure | turn_cap`; `not_implemented` removed from `UnavailableReason`;
  `stubDecider` **deleted**;
  `BotTurnDecision` gains `{ kind: 'resolve' }`; `answer` gains an optional `articleId`.
- `applyBotTurn.ts` — the `resolve` outcome, the `bot_phase` write, the two article events.
- `orchestrator.ts` — passes `toolLoopDecider`. One line.
- `sendPlayerMessage` — the reopen branch posts `HANDOFF_PLAYER_MESSAGE` and assigns per §10.
- **Spec 2's prefetched retrieval is removed from `BotTurnInput`.** Retrieval is now `search_articles`,
  called from the tool handler outside any transaction.
- **`{{articles}}` changes meaning** — from the three prefetched articles with bodies to the full
  published catalogue of titles and summaries, no bodies, no ids. Reasoning in spec 2 §10, which this
  slice adds. It is what lets the model report `no_article` honestly, since retrieval has no score
  floor and can never establish absence.
- Spec 2's taxonomy view, substitution, player context, history construction and size caps are
  unchanged.
- `BotTurnInput` gains `botPhase`, `botMessageCount` and `lastPlayerMessageAt`.
- `defaultPrompt.ts` — `DEFAULT_BOT_PROMPT` loses its player-context block (spec 3 §3, carried).
- `seedTaxonomy.ts` — the `Other` entry (spec 3 §5, carried).

---

## Verification

`openaiClient` is stubbed in every test. **No test makes a live model call**, including in CI.

### New `tests/bot.toolLoop.test.ts`

- A greeting — model replies with **no tool call** — produces one `bot` message, stays `bot_active`,
  writes no classification and **no event**. Asserting the absence of `intent_set` is the point.
- `search_articles` → `offer_article` produces `{ kind: 'answer', articleId }` and sets
  `bot_phase = 'article_confirm'`.
- `offer_article` with an id **not** returned by `search_articles` this turn is rejected; the loop
  continues rather than posting it.
- `classify` twice in one conversation writes the first and ignores the second; exactly one
  `intent_set`.
- `handoff` from a turn where `classify` was never called leaves `subintent_id` **NULL** — asserted
  explicitly, because the temptation to fabricate `Other` here is the whole of §5.
- `confirm_resolution` is **absent from the tool set** when `bot_phase = 'none'`, and present when
  `'article_confirm'`. Asserted on the request payload, not on behaviour.
- Budget: a model that calls `search_articles` forever stops at 4 and returns
  `handoff('unsure')`.
- Budget: with 8 bot messages present, `callModel` is **never called** and the result is
  `handoff('turn_cap')`. Asserting the absence of the call is the point.
- A refusal and an unparseable tool argument each produce `invalid_response` and are asserted
  **not** retried. A network error and a timeout each throw.

### New `tests/bot.contextAssembly.test.ts`

- The state block renders the classification and the offered/rejected article from event rows, and
  contains **no model-generated text**.
- With 40 messages, the first player message is present, the last 20 are present, and the elision
  marker carries the dropped count.
- An internal note never appears, at any window size.
- No `system`-role message after the first. The load-bearing assertion: it is what stops a future
  edit moving player-controlled text back into an instruction role.
- A conversation resumed after a simulated five-day gap produces the same state block as one
  resumed immediately, plus the gap line.

### New `tests/bot.phase.test.ts`

- `confirm_resolution(true)` from `article_confirm` resolves the conversation, writes
  `conversation_resolved` with `source: 'bot'`, and sets `bot_phase = 'none'`.
- `confirm_resolution(false)` hands off and writes `bot_article_rejected`.
- A confirmation arriving while `bot_phase = 'none'` — a replayed request — is rejected and writes
  nothing.
- Tapping **Yes** and the model calling `confirm_resolution(true)` produce **identical** rows and
  events. The buttons-and-typing convergence, asserted rather than assumed.

### `tests/bot.reopen.test.ts` — new

- Reopen from `resolved` posts `HANDOFF_PLAYER_MESSAGE` and lands on `open`, never `bot_active`.
- `awaiting_player → open` posts **no** system message.
- A bot-resolved conversation reopens to `assignOnHandoff`; an agent-resolved one keeps its previous
  owner; a deactivated owner falls back to `assignOnHandoff`.
- `conversation_reopened` carries the correct `previous_resolution_source`.

### Updates

- `tests/schema.test.ts` — `bot_phase` exists, defaults to `'none'`, and its check constraint rejects
  an unknown value.
- `tests/jobs.botTurns.test.ts` — the worker runs `toolLoopDecider`; a stubbed answering model
  produces a `bot` message and the conversation stays `bot_active`.
- `tests/bot.config.test.ts` — `DEFAULT_BOT_PROMPT` contains `{{subintents}}` and `{{articles}}` and
  **not** `{{player_level}}` or `{{spend_tier}}`; `BOT_PROMPT_PLACEHOLDERS` still lists all four.
- `tests/env.test.ts` — `OPENAI_MODEL` and `OPENAI_APIKEY` missing each fail validation.
- `tests/seed.test.ts` — the seed creates exactly one `is_system` intent named `Other`; re-running
  does not duplicate it.

---

## Deviations from `project-overview.md`

Recorded in `docs/decisions/spec-contradictions.md`:

1. **Assignment is deterministic least-loaded, not round-robin.** Carried from spec 1 §7.

Additions rather than contradictions: `bot_article_offered`, `bot_article_rejected`,
`conversation_resolved` and `conversation_reopened` join the event-type list, and
`conversation.bot_phase` joins the schema.

Three things `project-overview.md` leaves open are decided here: the article-offer lifecycle is
event-backed (§Events), the bot's budgets are code rather than `rules` (§8), and `bot_active` is
one-way (§10).

Two prerequisites are recorded rather than resolved: **workspace provisioning must seed `Other`**,
and **nothing yet caps a workspace's model spend**.
