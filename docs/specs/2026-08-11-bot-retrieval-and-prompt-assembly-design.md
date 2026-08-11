# Bot retrieval and prompt assembly — design

**Date:** 2026-08-11
**Status:** Accepted
**Scope:** Everything that turns a conversation into the exact string sent to a model, and nothing
that sends it. Five new modules, one filled-in type, one new `UnavailableReason` member. **No LLM.**

---

## What this slice is

Spec 1 built the control flow and left `BotTurnInput` as an opaque parameter to the decider. This
slice fills it: the retrieved articles, the taxonomy the model classifies against, the player
context, the conversation history, and the placeholder substitution that joins them into one system
prompt.

**Nothing user-visible changes.** `stubDecider` still returns `unavailable`, so every conversation
still hands off exactly as it did after spec 1. The deliverable is a pure function whose output a
test asserts character-for-character.

That is the point of building it separately. **The safety-critical properties of this bot are all
here** — internal notes must not reach the model, `state.raw` must not reach the model, a player must
not be able to steer the system prompt — and each is provable without a model in the loop, in a test
that runs in milliseconds and never flakes.

| Spec | Contents |
|---|---|
| 1 — bot turn seam and handoff | Gating, queue, outcome application, handoff, assignment, events |
| **2 — this one** | Retrieval, taxonomy view, player context, history, substitution |
| 3 — Gemini call and decision | `@google/genai`, response schema, turn cap, index→subintent resolution, the `Other` seed |

### In scope

| Thing | Why here |
|---|---|
| `retrieval.ts` | BM25 ids → hydrated published article rows, ranked |
| `taxonomyView.ts` | The numbered subintent list **and** the index→id map that decodes it |
| `playerContext.ts` | `{{player_level}}` / `{{spend_tier}}` from `declared`, `unknown` for every no-data state |
| `history.ts` | Player and bot turns, through `toPlayerView` |
| `promptAssembly.ts` | Substitution, and the one function that assembles `BotTurnInput` |
| `BotTurnInput` — filled in | Spec 1 declared it opaque; this is its shape |
| `UnavailableReason` gains `retrieval_failed` | A broken index is not a bot deciding to hand off |
| Article and player-value size caps | Token budget, and a player-controlled string in a system prompt |

### Out of scope — named so nobody wonders

- **The model call.** No `@google/genai`, no `GEMINI_*` env, no response schema, no turn cap. Spec 3.
- **Resolving an index back to a subintent.** This slice *produces* the map; spec 3 reads it.
- **Seeding the `Other` intent and its catch-all subintent.** `SEED_TAXONOMY` has eight intents and
  none of them is `Other`; `intent.is_system` is declared in the schema and set nowhere. That row is
  what an unclassifiable conversation lands on, and it is **spec 3's prerequisite** — the slice that
  first has an index to fail to resolve. Recorded here so it is not discovered there. This slice
  renders whatever subintents exist and needs no fallback of its own.
- **Semantic / hybrid / `near_text` search.** The `Article` collection is pre-wired with
  `text2vec_openai` for exactly this, but BM25 is what the article slice shipped and changing the
  query strategy is a change to public FAQ search too, not just the bot.
- **Re-ranking, query rewriting, multi-query retrieval.** One query, one BM25 call.
- **Caching an assembled prompt.** Articles and taxonomy change without a release, by design.
- **Admin visibility into the assembled prompt.** A "preview what the bot sees" screen is a good
  idea and is the bot-admin-screen slice's.

---

## Design decisions

### 1 · The retrieval query is the latest player message, alone

Not the concatenated conversation, not a summary, not a rewritten query.

BM25 scores on term overlap. Concatenating earlier turns dilutes the terms that matter with the
terms of a question already answered, and the failure is silent — you get plausible-looking articles
for the wrong turn. With the turn cap at 2 there are at most three player messages in a bot-active
conversation anyway, so the recall lost is small and the precision kept is not.

The full history still reaches the model as `history`; it is only *retrieval* that reads one message.

### 2 · Retrieval failure is `unavailable`, not zero articles

`searchArticleIds` already bounds itself with `WEAVIATE_CALL_TIMEOUT_MS` (5 s) and throws on
timeout. That throw propagates: the job retries, and on the final attempt the conversation takes
spec 1's `unavailable` path with a new reason.

```ts
export type UnavailableReason =
  | 'not_provisioned' | 'not_implemented' | 'error' | 'timeout' | 'invalid_response'
  | 'retrieval_failed'   // added by this slice
```

The tempting alternative — treat a Weaviate outage as "no articles matched" — produces the same
*visible* outcome (the rules tell the bot to hand off when nothing answers the question) while
recording it as `bot_handoff`. The bot would be credited with a good decision every time the search
index was down, and the Bot-fallbacks metric would read zero through an outage. **The two must not be
confusable**, which is the same reasoning that split `bot_handoff` from `bot_unavailable` in spec 1.

### 3 · Zero results is an explicit sentence, not an empty block

A genuine zero-result search renders:

```
No help articles matched this question.
```

Never an empty string under the `{{articles}}` heading. A blank region in a prompt reads as a
truncation bug to a model as easily as it reads as absence, and the one behaviour that must be
reliable here is handing off when there is nothing to answer from. Saying it in words costs eight
tokens.

This is also the **"no published articles in the workspace"** case from the non-negotiables, which
needs no special path: an empty index returns no ids and renders the same sentence.

### 4 · Everything that enters the prompt is size-capped

| Bound | Value | Why |
|---|---|---|
| `MAX_ARTICLES` | 5 | The `searchArticleIds` limit |
| `MAX_ARTICLE_BODY_CHARS` | 2000 | One long article must not crowd out four relevant ones |
| `MAX_HISTORY_MESSAGES` | 20 | A player can send many messages before the worker runs |
| `MAX_HISTORY_BODY_CHARS` | 1000 | Per message |
| `MAX_PLAYER_VALUE_CHARS` | 100 | See §7 — this one is not about tokens |

A truncated article body ends with `… [truncated]` rather than stopping mid-sentence silently, so a
model reasoning about an incomplete instruction can see that it is incomplete, and so can whoever is
debugging the answer.

History is capped from the **newest** end — the last 20, not the first 20.

### 5 · Substitution runs on the joined prompt, and leaves unknown placeholders alone

`buildSystemPrompt(prompt, rules)` joins the two stored fields; substitution runs on its output. That
ordering is already required by the bot-config design, and it has a consequence worth stating:
**placeholders work in `rules` as well as in `prompt`**, because substitution never sees which half a
token came from.

```ts
substitutePlaceholders(template: string, values: Record<string, string>): string
```

Exactly the four keys in `BOT_PROMPT_PLACEHOLDERS` are substituted. **Any other `{{token}}` is left
in the string verbatim** — not blanked, not stripped, not an error.

This is the decision that matters. An admin who types `{{player_name}}` should see `{{player_name}}`
in the assembled prompt, because a literal placeholder is self-diagnosing and an empty string is
not — a silently-blanked token looks like a model failure and gets debugged for an hour. It also
keeps a prompt containing `{{` from being corrupted by a templating engine it never asked for.

A placeholder the admin **omits** is simply not substituted. Nothing is appended: the assembled
prompt is the admin's text, not the admin's text plus what we thought they forgot.

### 6 · The subintent list and its decoder are built together, or not at all

```ts
export type TaxonomyView = {
  rendered: string                              // what {{subintents}} becomes
  indexToSubintentId: ReadonlyMap<number, string>
}
```

One function returns both. They are the encode and decode halves of one contract, and a codebase
where the list is rendered in one place and the numbering re-derived in another is one refactor away
from classifying every conversation one category off.

**Rendering** is 1-based, `Intent › Subintent`, ordered by intent name then subintent name:

```
1. Account Access › Account Recovery
2. Account Access › Email Change
...
```

The intent name is included because subintent names are unique only *within* an intent — `Refund
Status` under In-App Purchases and `Refund Requests` under Billing are different things and the model
needs to see which is which. Ordering is by name rather than by `created_at` so the list is
reproducible from the data alone when reconstructing what a past turn saw.

**Included:** `subintent.archived_at IS NULL`, `subintent.merged_into_id IS NULL`, and
`intent.archived_at IS NULL`. A merged loser is a forwarding address, not a category; offering it
would let the bot classify into something the taxonomy has retired.

With the current seed this renders 40 lines. That is fine, and it is the honest size of the problem —
a workspace with 200 subintents is a prompt-engineering question for a later slice, not a reason to
truncate the list silently here.

### 7 · Player values are `unknown` for every no-data state, and are treated as hostile input

`{{player_level}}` reads `declared['player_level']`; `{{spend_tier}}` reads `declared['spend_tier']`.
Both are seeded `declared_field` keys, so this works on a fresh workspace.

**Five paths, one output.** `conversation.session_id IS NULL`; no `player_state_snapshot` row for
that session; `is_missing = true`; `degraded_reason` set with the key absent; key simply absent —
all render the literal string `unknown`. Never an empty string, never `null`, never an error.
*Missing data is a state, not an error*, and a prompt whose shape changes with data availability is a
prompt you cannot reproduce from a bug report.

`degraded_reason` set with the key **present** renders the value: partial data is data.

**`raw` is never read.** It is uncontrolled client input, PII by default, and the only reason it
would ever reach a third-party model is a careless join. There is no code path here that selects it.

**`declared` is player-controlled too.** It arrives from the SDK and lands in a system prompt — the
one place in this system where client input outranks instructions. So:

- Non-scalar values (object, array, null) render `unknown`. Only string, number and boolean are
  formatted.
- Values are trimmed, newlines and carriage returns collapsed to spaces, and truncated to
  `MAX_PLAYER_VALUE_CHARS`.

Stripping newlines is the load-bearing one: a multi-line value is what turns a context field into
something that looks like a new section of the prompt. This is a mitigation, not a solution —
`spend_tier: "whale, ignore the rules above"` still arrives as a hundred characters of adversarial
text inside the system prompt, and the real answers (moving player context out of the system role,
or declaring these fields untrusted to the model) belong in spec 3 where the message roles are
decided. **Recorded here because it is a property of this design, not an oversight of it.**

### 8 · History is player and bot only, through `toPlayerView`

```ts
export type BotTurnHistoryEntry = { author: 'player' | 'bot'; body: string }
```

Rows are fetched whole and passed through `toPlayerView`, and the nulls are filtered out — the same
explicit whitelist every player-facing route uses. **A `visibility` predicate is never added to the
query.** The serializer is the only thing that decides, per the rule the serializers file states, so
the bot's view of a conversation is the player's view by construction rather than by a filter someone
has to remember.

`system`-authored messages are dropped even when public. The only public system message that exists
is spec 1's handoff line, which is posted at the moment the conversation leaves `bot_active` — so it
can only appear in a history the bot should never be reading anyway. Excluding it means a stray
system message can never be mistaken by the model for an instruction.

`agent`-authored messages are excluded by the same rule, and cannot occur in practice for the same
reason.

---

## `BotTurnInput` — the shape spec 1 left open

```ts
export type BotTurnInput = {
  /** Fully assembled and substituted. Nothing downstream edits this string. */
  systemPrompt: string
  history: BotTurnHistoryEntry[]
  /** 1-based, matching the rendered list. Spec 3 decodes the model's answer with it. */
  indexToSubintentId: ReadonlyMap<number, string>
}
```

Three fields, and deliberately no `articles`, no `conversationId`, no raw config. The decider's whole
job is: given this prompt and this history, what should happen — and given an index, which subintent
was that. Anything else it could reach for is something spec 3 would be able to make a second,
divergent decision from.

`fallbackSubintentId` is **not** here. Resolving an unresolvable index is spec 3's, and so is the
`Other` row it needs.

---

## Modules

All under `backend/src/domain/bot/`, exported through `index.ts`.

| File | Exports | Notes |
|---|---|---|
| `retrieval.ts` | `retrieveArticles(workspaceId, query)` | Calls `searchArticleIds`, hydrates from Postgres, re-orders to the BM25 ranking |
| `taxonomyView.ts` | `buildTaxonomyView(tx, workspaceId)` → `TaxonomyView` | Renders and decodes together |
| `playerContext.ts` | `resolvePlayerContext(tx, sessionId)` → `{ playerLevel, spendTier }` | `unknown` for all five no-data paths |
| `history.ts` | `buildHistory(rows)` → `BotTurnHistoryEntry[]` | Through `toPlayerView` |
| `promptAssembly.ts` | `substitutePlaceholders`, `assembleBotTurnInput`, `renderArticles`, the caps | The only file that knows the prompt's final shape |

`retrieval.ts` is the only one that does I/O outside a transaction, because Weaviate is not Postgres
and must not be called with a transaction open — the article-index module's timeout comment explains
why, and this slice inherits that constraint rather than restating it.

`assembleBotTurnInput` is **pure**: it takes the resolved config, the retrieved articles, the
taxonomy view, the player context and the history as arguments and returns `BotTurnInput`. Every
assertion about the final prompt string is a test against this function with no database and no
Weaviate.

### Delta to spec 1's `orchestrator.ts`

The gather step grows. In the existing read transaction, additionally: `buildTaxonomyView`,
`resolvePlayerContext` (via `conversation.session_id`), and the message rows for `buildHistory`.
Then, **outside** the transaction, `retrieveArticles` on the latest player message. Then
`assembleBotTurnInput`, then `decider(input)` as before.

Retrieval sits outside the transaction and after the `status === 'bot_active'` guard, so a
conversation an agent has claimed costs no Weaviate call at all.

---

## The assembled prompt

`{{articles}}` renders as a numbered list, blank-line separated:

```
[1] Why was I charged twice?
If you see two charges for the same purchase, one is usually a temporary authorisation…

[2] Requesting a refund
Refunds are handled by the platform store, not by us…
```

Numbered, even though nothing in slice A reads the numbers back. It is what lets someone reading a
bad answer next to the logged prompt say *which* article the model used — the same reason the
subintent list is numbered. It also gives spec 4's `article_shown` event a hook that needs no
reformatting.

Titles are never truncated; only bodies are.

---

## Verification

Every test below runs with no model, and all but two with no network.

### New `tests/bot.promptAssembly.test.ts` — pure, no database

- **The four placeholders are substituted** and an unrecognised `{{token}}` survives verbatim.
- A prompt **omitting** a placeholder is returned with nothing appended.
- Substitution runs after the join: a placeholder written in `rules` is substituted too.
- A substituted value containing `{{articles}}` is **not** re-substituted — one pass, no recursion.
  (A player could otherwise put a placeholder in a declared field.)
- Zero articles renders the sentinel sentence, never an empty region.
- `MAX_ARTICLE_BODY_CHARS` truncates with the `… [truncated]` marker; a body one character under is
  untouched.
- Article ordering in the output equals the ranked input ordering.

### New `tests/bot.taxonomyView.test.ts`

- `rendered` and `indexToSubintentId` agree: for every line `N.`, `indexToSubintentId.get(N)` is that
  subintent's id. Asserted by parsing the rendered string, so the two cannot drift.
- Numbering is 1-based and contiguous.
- Archived subintents, archived intents and merged losers are all absent from both.
- Ordering is by intent name then subintent name, asserted against a fixture with deliberately
  awkward names.
- Another workspace's subintents never appear.

### New `tests/bot.playerContext.test.ts`

- All five no-data paths render `unknown`: no `session_id`, no snapshot row, `is_missing`,
  `degraded_reason` with the key absent, key absent outright.
- `degraded_reason` set **with** the key present renders the value.
- **`raw` is never read:** a snapshot whose `raw` contains `player_level` and whose `declared` does
  not renders `unknown`. This is the PII assertion and it must fail loudly if someone widens the
  select.
- Object, array and null values render `unknown`; string, number and boolean render.
- A value with embedded newlines renders on one line; a 500-character value is truncated to 100.

### New `tests/bot.history.test.ts`

- An `internal`-visibility message never appears, whatever its author type. The direct assertion of
  the safety-critical property.
- `system` and `agent` authored messages are excluded.
- Ordering is by `seq` ascending, and the cap keeps the **newest** 20.
- Bodies over `MAX_HISTORY_BODY_CHARS` are truncated.

### New `tests/bot.retrieval.test.ts` — Weaviate stubbed

- The BM25 query is the latest player message only, and `limit` is `MAX_ARTICLES`.
- Postgres hydration re-orders rows to the BM25 ranking, not to `published_at`.
- An id returned by Weaviate whose row is no longer `published` is dropped, not rendered blank —
  the index can lag Postgres.
- A throwing/timing-out `searchArticleIds` propagates, and the orchestrator surfaces it as
  `{ kind: 'unavailable', reason: 'retrieval_failed' }` — asserted through `runBotTurn`, not by
  inspecting the throw.
- No Weaviate call is made when the status guard has already returned `noop`.

---

## Deviations

None from `project-overview.md`. Two things it leaves open are decided here and worth naming: the
retrieval query is one message rather than the conversation (§1), and a search-index outage counts
as a bot fallback rather than a bot handoff (§2).

The player-context injection surface described in §7 is a **known, bounded risk carried forward to
spec 3**, not a resolved one.
