# Bot OpenAI call and decision — design

**Date:** 2026-08-11
**Status:** Accepted
**Scope:** The decider. One dependency, two env vars, one structured-output schema, one seed row,
one edit to the shipped default prompt. The slice that makes the bot talk.

---

## What this slice is

Specs 1 and 2 built a bot-shaped hole. Spec 1 defined `BotDecider` and filled it with `stubDecider`;
spec 2 filled `BotTurnInput` with a fully assembled prompt. This slice replaces the stub with a real
one and deletes the scaffolding behind it.

**This is the only spec that can be broken by a third party**, and it is deliberately last, smallest
and behind a seam the first two proved. Nothing in the control flow changes: `runBotTurn` takes a
different function and every outcome path it can return already exists and is already tested.

| Spec | Contents |
|---|---|
| 1 — bot turn seam and handoff | Gating, queue, outcome application, handoff, assignment, events |
| 2 — retrieval and prompt assembly | Hybrid retrieval, taxonomy view, player context, history, substitution |
| **3 — this one** | The OpenAI call, the response schema, the turn cap, index resolution, the `Other` seed |

### In scope

| Thing | Why here |
|---|---|
| `openai` dependency, `OPENAI_MODEL` env | The call |
| `openaiClient.ts` | One chat completion, strict structured output, 15 s timeout |
| `openaiDecider.ts` | The real `BotDecider`: guards, call, response → `BotTurnDecision` |
| Turn cap `MAX_BOT_TURNS = 2` | The runaway guard, decided in brainstorming |
| Message-role split | Admin text in `system`; player-controlled text in `user` |
| `DEFAULT_BOT_PROMPT` loses its player-context block | Consequence of the role split |
| `Other` intent + catch-all subintent, seeded | Where an unresolvable index lands |
| Index → subintent resolution | Decoding `indexToSubintentId` |
| `HandoffReason` becomes model-supplied | *"Asked for a person"* is a listed metric |
| Delete `stubDecider`, remove `not_implemented` | The scaffolding spec 1 named for removal |

### Out of scope — named so nobody wonders

- **The article-offer lifecycle**, form offering, the inactivity turn. Unchanged from spec 1.
- **Streaming.** The reply is posted as one message after the turn commits; there is no partial
  message to stream into. Streaming is a socket-protocol change, not a model change.
- **Token accounting or spend limits per workspace.** Usage is logged; nothing caps it. A workspace
  cannot yet turn its own bot into a bill.
- **Prompt-injection defence beyond the role split.** §3 states what the split does and does not buy.
- **Tuning.** `alpha`, the turn cap, the temperature and the model are named constants and env vars,
  not configuration, and they move when there is traffic to move them against.
- **Per-workspace model choice.** A model id is not admin-editable content; it does not belong in
  `bot_config`.

---

## Design decisions

### 1 · Strict structured outputs, not JSON-mode-and-hope

```ts
const BOT_TURN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'reply', 'subintent_index', 'handoff_reason'],
  properties: {
    action:          { type: 'string', enum: ['answer', 'handoff'] },
    reply:           { type: 'string' },
    subintent_index: { type: 'integer' },
    handoff_reason:  { type: ['string', 'null'],
                       enum: ['asked_for_person', 'no_article', 'sensitive', 'unsure', null] },
  },
} as const
```

Sent as `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`.

`strict: true` is the reason `invalid_response` is a rare path rather than a routine one: the API
enforces the schema rather than the prompt asking politely. Every field is `required` because strict
mode requires it; optionality is expressed with a nullable type, which is why `handoff_reason` is
`null` on an `answer` rather than absent.

**`reply` is required on both actions** even though spec 1 discards it on a handoff. Making it
conditional would need a union schema for no gain — the orchestrator ignores it, and the fixed
handoff copy stays uninfluenceable by the model.

### 2 · `handoff_reason` exists because *"Asked for a person"* is a metric

`project-overview.md` lists **Asked for a person — conversations where the player bypassed the bot**
as a reported metric. That is a fact about *why* the bot handed off, it is only knowable at the
moment of the turn, and it cannot be reconstructed afterwards from the conversation. So the model
reports it and spec 1's union changes:

```ts
export type HandoffReason =
  | 'asked_for_person'   // the player asked for a human
  | 'no_article'         // nothing supplied answers the question
  | 'sensitive'          // upset player, financial loss, legal or safety issue
  | 'unsure'             // not confident enough to answer
  | 'turn_cap'           // orchestrator-supplied, not model-supplied
```

`'model'` is gone; it said nothing. `'turn_cap'` is the one value the model cannot produce.

`no_article` is the second reason to want this, and it is the one spec 2 pointed at: with no
retrieval floor, *"the player asked something we have no article for"* is otherwise invisible. It is
the raw material for deciding which articles to write next, and it costs one enum value.

**No `confidence` score.** A self-reported float has no calibration and would immediately be
threshold-ed against as though it did. The `unsure` branch is the same signal, discretised by the
model that actually holds it.

### 3 · Admin text is `system`; player-controlled text is `user`

| Role | Content |
|---|---|
| `system` | Spec 2's assembled prompt — admin `prompt` + `rules`, `{{subintents}}`, `{{articles}}` |
| `user` | The player-context block (see below) |
| `user` / `assistant` | The history, `player` → `user`, `bot` → `assistant` |

Everything in `system` is admin-authored or admin-curated: the prompt, the rules, the workspace's own
taxonomy, its own published articles. Everything a player can influence sits in `user`, where
adversarial text carries no more authority than the question it arrived with.

This is why **`DEFAULT_BOT_PROMPT` loses its `Context about this player` block.** Player context is
now delivered as a `user` message ahead of the history:

```
Player context (reported by the game client, not verified):
- Progress: 47
- Spending tier: unknown
```

*"reported by the game client, not verified"* is not decoration. It is the one sentence that tells the
model these values are claims rather than facts, and it costs nothing.

**`{{player_level}}` and `{{spend_tier}}` remain supported placeholders.** `BOT_PROMPT_PLACEHOLDERS`
is unchanged and spec 2's substitution still resolves them — an admin who writes one into a custom
prompt gets it, and the values are then delivered twice, which is harmless. What changes is that the
*default* no longer puts player-controlled text in the system role, so the exposure exists only where
an admin deliberately opts into it. `tests/bot.config.test.ts` moves from asserting the default
contains all four placeholders to asserting it contains `{{subintents}}` and `{{articles}}`.

**What this buys and what it does not.** The role split removes the *structural* privilege of
player text — it is no longer sitting inside the instruction block. It does **not** make injection
impossible: a model can still be talked out of its instructions by a sufficiently determined `user`
turn. The remaining defences are the ones that do not depend on the model behaving: the handoff copy
is a fixed constant spec 1 never lets the model write, the bot cannot take any action but reply or
hand off, and both lead to a human. **A successfully injected bot can say something wrong; it cannot
do anything.** That containment, not the role split, is what makes this acceptable.

### 4 · The turn cap is a guard before the call, not a rule in the prompt

```ts
export const MAX_BOT_TURNS = 2
```

Counted as `bot`-authored messages already in the conversation. At 2, the decider returns
`{ kind: 'handoff', reason: 'turn_cap' }` **without calling OpenAI at all** — no tokens, no latency,
no chance of the model talking its way past.

A prompt-level instruction would be the alternative, and it is the wrong one: `rules` is an
admin-editable text field with no validation, so the only thing standing between a player and an
unbounded loop would be a string someone can delete. The cap fails toward a human, which is the
direction everything in this system fails.

The player never sees "you have used up your bot turns" — a `turn_cap` handoff posts the same fixed
copy as every other handoff. The distinction is for the metric, not the player.

### 5 · An unresolvable index lands on `Other`, and `Other` has to exist first

`indexToSubintentId.get(subintent_index)` resolves the model's answer. A miss — out of range, or an
index the map does not carry — resolves to the workspace's catch-all subintent under `Other`. Not an
error, and never NULL.

That distinction is load-bearing and already written down: **`Other` means the bot ran and could not
place it; NULL means the bot never ran.** Folding a failed classification into NULL would make it
indistinguishable from a fallback, and the Bot-fallbacks metric counts the latter.

**`Other` does not exist today.** `SEED_TAXONOMY` has eight intents, none of them `Other`, and
`intent.is_system` is declared in the schema and set nowhere — despite `project-overview.md`
requiring both, and requiring that `Other` cannot be archived or removed. This slice seeds it:

```
intent    { name: 'Other', is_system: true }
subintent { intent: Other, name: 'Uncategorised' }
```

British spelling, per the conventions. Idempotent through the existing
`UNIQUE (workspace_id, name)` and `UNIQUE (workspace_id, intent_id, name)`, so re-running the seed on
an existing workspace adds it and changes nothing else.

`resolveFallbackSubintent(tx, workspaceId)` reads the `is_system` intent's subintent. **If it is
absent it returns null, logs an error, and the conversation is classified NULL** — a workspace
provisioned outside the seed path must not crash a bot turn. That is a known gap, not a designed
state: workspace creation seeding `Other` belongs to the workspace-provisioning slice, and is
recorded as its prerequisite.

`Other` appears in the rendered `{{subintents}}` list like any other subintent, so the model can also
choose it deliberately. Same destination, two routes: an explicit "I cannot place this" and a failed
resolution.

### 6 · Failure taxonomy, and what each one means

| Situation | Outcome |
|---|---|
| Turn cap reached | `handoff`, reason `turn_cap` — no call made |
| Model returns `action: 'handoff'` | `handoff`, model's `handoff_reason` |
| Model returns `action: 'answer'` | `answer` |
| API error, non-2xx, network failure | throw → BullMQ retry → `unavailable`, `error` |
| 15 s timeout | throw → retry → `unavailable`, `timeout` |
| Refusal, truncated response, unparseable | `unavailable`, `invalid_response` — **no retry** |
| Empty or whitespace-only `reply` on `answer` | `unavailable`, `invalid_response` |

**A refusal or a schema-violating response is not retried.** A deterministic input that produced a
refusal will produce it again; retrying spends 15 s of a player's time to reach the same place. Two
attempts exist for *transient* failures, which is what a network error and a timeout are and what a
refusal is not.

`not_implemented` is **removed** from `UnavailableReason`, and `stubDecider` is deleted. The type
error at the stub's definition is what forces both, exactly as spec 1 said it would.

### 7 · Determinism and logging

`temperature: 0`. Support triage is a classification task, not a creative one; a bot that answers the
same question two ways is a bot nobody can debug or write a regression test against.

`max_completion_tokens` is capped — the rules already say "at most three short sentences", and the cap
is what makes that true when they are edited away.

**Logged per turn at `mild`:** model id, latency, prompt and completion tokens, `action`,
`handoff_reason`, resolved subintent name, and whether the index resolved or fell back. Enough to
answer "why did the bot do that" and "what is this costing" without reading a prompt.

**Only at `verbose`:** the assembled system prompt and the history. Both contain player text, and
`state.raw`-adjacent data is PII by default — so the full turn is available when someone is
deliberately debugging and never in ordinary logs.

Never log the API key, and never log the raw error object end-to-end — `name`/`message`/`stack`, per
the existing guard in `errors.ts`.

---

## Environment

```
OPENAI_APIKEY   required   already exists; spec 2 removed `.optional()`
OPENAI_MODEL    required   no default
```

One key, two consumers: the Weaviate vectorizer header (spec 2) and the chat client (here). Two
purposes on one credential is a deliberate simplification — they are the same OpenAI account, and a
second env var for the same secret invites them to drift.

`OPENAI_MODEL` has **no default**, so an unset value fails at boot through the Zod env schema rather
than silently pinning a model that may be deprecated. Same treatment as `WEAVIATE_URL`.

`.env.example` carries `gpt-5.4-mini`.

> **Verify before implementing:** that exact model id string, and that it supports
> `response_format: json_schema` with `strict: true`. This spec was written past the author's
> knowledge cutoff; the id is what the project owner intends to run, not a verified value. If strict
> structured output is unsupported on that model, §1 needs revisiting — not §6, which would otherwise
> quietly absorb the failure as `invalid_response` on every turn.

---

## Modules

| File | Exports | Notes |
|---|---|---|
| `openaiClient.ts` | `callBotModel(messages)` → validated response | The only file that imports `openai`. Timeout, schema, temperature live here |
| `openaiDecider.ts` | `openaiDecider: BotDecider` | Turn-cap guard, `callBotModel`, response → `BotTurnDecision` |
| `fallbackSubintent.ts` | `resolveFallbackSubintent(tx, workspaceId)` | The `Other` lookup |
| `messageRoles.ts` | `buildMessages(input, playerContext)` | The role split — §3, in one testable function |

### Deltas

- `botTurn.ts` — `HandoffReason` replaced (§2); `not_implemented` removed from `UnavailableReason`;
  `stubDecider` deleted.
- `defaultPrompt.ts` — `DEFAULT_BOT_PROMPT` loses its player-context block. `DEFAULT_BOT_RULES`,
  `BOT_PROMPT_PLACEHOLDERS` and `buildSystemPrompt` are unchanged.
- `orchestrator.ts` — passes `openaiDecider`. One line.
- `seedTaxonomy.ts` — the `Other` entry.
- `BotTurnInput` gains `botTurnCount: number` and `playerContext`, both of which spec 2's gather step
  already has in hand.

`callBotModel` returns a validated object or throws a typed error, so `openaiDecider` maps errors to
reasons and never inspects an SDK exception shape. The SDK stays behind one file, which is what makes
a provider change a one-file change — as this slice's own history demonstrates.

---

## Verification

`openaiClient` is stubbed in every test below. **No test makes a live OpenAI call**, including in CI,
matching how `weaviateArticlesIndex.test.ts` treats Weaviate.

### New `tests/bot.decider.test.ts`

- `action: 'answer'` with a valid index → `{ kind: 'answer' }` with the right subintent id.
- `action: 'handoff'` → `{ kind: 'handoff' }` carrying the model's `handoff_reason` verbatim.
- **Turn cap:** with 2 bot messages already present, the decider returns `turn_cap` and
  **`callBotModel` is never called.** Asserting the *absence* of the call is the point.
- With 1 bot message, the call is made.
- Out-of-range, negative and zero indexes all resolve to `Other`'s catch-all — never NULL, never a
  throw.
- A refusal, a truncated response and an empty `reply` each produce `invalid_response`, and each is
  asserted **not** to be retried.
- A network error and a timeout each throw, so BullMQ can retry them.

### New `tests/bot.messageRoles.test.ts`

- The `system` message contains the assembled prompt and **nothing else** — asserted by checking it
  does not contain the player-context marker or any history body.
- Player context is a `user` message carrying the "reported by the game client, not verified" line.
- History maps `player` → `user` and `bot` → `assistant`, in `seq` order.
- **No `system`-role message after the first.** The load-bearing assertion: it is what stops a future
  edit from quietly moving player-controlled text back into an instruction role.

### New `tests/bot.fallbackSubintent.test.ts`

- Resolves the `is_system` intent's catch-all.
- Returns null and logs when `Other` is absent, rather than throwing.
- Never returns another workspace's `Other`.

### `tests/bot.config.test.ts` — updates

- `DEFAULT_BOT_PROMPT` contains `{{subintents}}` and `{{articles}}` and **not** `{{player_level}}` or
  `{{spend_tier}}`. Replaces the existing four-placeholder assertion.
- `BOT_PROMPT_PLACEHOLDERS` still lists all four — they remain supported for custom prompts.
- The existing assertions that neither default names a real subintent or article still pass.

### `tests/seed.test.ts` (or `schema.test.ts`)

- The seed creates exactly one `is_system` intent named `Other` with one subintent.
- Re-running the seed does not duplicate it.
- `Other` appears in the rendered `{{subintents}}` list (a spec-2 `taxonomyView` test, extended).

### `tests/env.test.ts` — updates

- `OPENAI_MODEL` missing fails validation. `OPENAI_APIKEY` missing fails validation (spec 2's change).

### `tests/jobs.botTurns.test.ts` — updates

- The worker now runs `openaiDecider`; a stubbed answering model produces a `bot` message and the
  conversation stays `bot_active`. The first end-to-end assertion that the bot replies at all.

---

## Deviations

None from `project-overview.md`. Three things it leaves open are decided here: `handoff_reason` is
model-supplied (§2), the turn cap is 2 and is enforced before the call (§4), and the shipped default
prompt no longer places player context in the system role (§3).

Two prerequisites are recorded rather than resolved: **workspace provisioning must seed `Other`**
(§5), and **nothing yet caps a workspace's model spend**.
