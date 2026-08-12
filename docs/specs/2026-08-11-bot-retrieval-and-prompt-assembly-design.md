# Bot retrieval and prompt assembly — design

**Date:** 2026-08-11
**Status:** Accepted — revised in part on 2026-08-12 by
`2026-08-12-bot-tool-calling-decider-design.md` (spec 4)

> **What spec 4 changed here.** The taxonomy view (§7), substitution (§6), player context (§8),
> history (§9) and the size caps (§5) all stand as written — they are the safety-critical half and
> nothing about them depends on how the model is called.
>
> **Retrieval is no longer prefetched.** §1 is superseded: the query is phrased by the model through
> the `search_articles` tool rather than being the latest player message. `searchArticleIdsHybrid`,
> `HYBRID_ALPHA`, `BOT_ARTICLE_LIMIT` and the no-floor decision (§4) are unchanged — only the caller
> moves. `{{articles}}` consequently changes meaning: see §10, added below.
>
> §8's player-context injection risk, recorded here as *"carried forward to spec 3"*, is **resolved**
> by spec 4 §7 moving player context into a `user` message.

**Scope:** Everything that turns a conversation into the exact string sent to a model, and nothing
that sends it. Five new modules, one new Weaviate query function, one filled-in type, one new `UnavailableReason` member. **No LLM.**

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
| ~~3 — OpenAI call and decision~~ | **Superseded by spec 4** |
| 4 — tool-calling decider | `openai` SDK, five tools, budgets, `bot_phase`, context assembly, the `Other` seed |

### In scope

| Thing | Why here |
|---|---|
| `retrieval.ts` | Hybrid search ids → hydrated published article rows, ranked |
| `searchArticleIdsHybrid` in `shared/weaviate/articlesIndex.ts` | The bot's query strategy, separate from public FAQ search |
| `OPENAI_APIKEY` becomes required in `env.ts` | Hybrid cannot vectorize the query without it |
| `taxonomyView.ts` | The numbered subintent list **and** the index→id map that decodes it |
| `playerContext.ts` | `{{player_level}}` / `{{spend_tier}}` from `declared`, `unknown` for every no-data state |
| `history.ts` | Player and bot turns, through `toPlayerView` |
| `promptAssembly.ts` | Substitution, and the one function that assembles `BotTurnInput` |
| `BotTurnInput` — filled in | Spec 1 declared it opaque; this is its shape |
| `UnavailableReason` gains `retrieval_failed` | A broken index is not a bot deciding to hand off |
| Article and player-value size caps | Token budget, and a player-controlled string in a system prompt |

### Out of scope — named so nobody wonders

- **The model call.** No `openai` chat client, no `OPENAI_MODEL` env, no response schema, no turn
  cap. Spec 4. (`OPENAI_APIKEY` *is* touched here — see §2 — but only as the Weaviate vectorizer
  header it already is.)
- **Resolving an index back to a subintent.** This slice *produces* the map; spec 4 reads it.
- **Seeding the `Other` intent and its catch-all subintent.** `SEED_TAXONOMY` has eight intents and
  none of them is `Other`; `intent.is_system` is declared in the schema and set nowhere. That row is
  what an unclassifiable conversation lands on, and it is **spec 4's prerequisite** — the slice that
  first has an index to fail to resolve. Recorded here so it is not discovered there. This slice
  renders whatever subintents exist and needs no fallback of its own.
- **Changing public FAQ search.** `listPublicArticles` keeps `searchArticleIds` and its BM25 floor,
  untouched. The bot gets a second function against the same collection — see §2.
- **Re-ranking, query rewriting, multi-query retrieval.** One query, one hybrid call.
- **Tuning `alpha`.** It ships as a named constant at 0.5. Making it configurable, or fitting it to
  real traffic, needs traffic first.
- **Caching an assembled prompt.** Articles and taxonomy change without a release, by design.
- **Admin visibility into the assembled prompt.** A "preview what the bot sees" screen is a good
  idea and is the bot-admin-screen slice's.

---

## Design decisions

### 1 · ~~The retrieval query is the latest player message, alone~~ — superseded by spec 4

**This section is obsolete.** It argued against concatenating the conversation into one query, and
that argument still holds — but the conclusion it drew, that the query should therefore be the latest
player message verbatim, was the wrong fix.

The player's own words are frequently a poor query. *"paid, got nothing"* shares almost no term with
an article titled *"Why didn't my gems arrive?"*, and the vector half of a five-word fragment carries
little signal either. Spec 4 makes retrieval the `search_articles` tool: the model reads the message,
phrases a query (*"missing in-app purchase not delivered"*), reads the returned titles and bodies,
and may query again — up to three times per turn.

Retrieval is the textbook case for a tool. It is idempotent, side-effect-free, and cheap to get
wrong, so letting the model iterate costs nothing but tokens and reliably beats one fixed query.

Everything mechanical below is unchanged: same function, same `alpha`, same limit, same workspace
filter, same absence of a score floor. Only the caller and the query string move.

### 2 · The bot searches hybrid; public FAQ search stays BM25

Two query strategies against one collection, as two functions in
`shared/weaviate/articlesIndex.ts`:

```ts
export const HYBRID_ALPHA = 0.5      // 0 = pure BM25, 1 = pure vector
export const BOT_ARTICLE_LIMIT = 3

export async function searchArticleIdsHybrid(
  query: string,
  opts: { workspaceId: string; limit: number },
): Promise<string[]>
```

Same `workspaceId` filter, same `WEAVIATE_CALL_TIMEOUT_MS` wrapper, same
`collection.query.hybrid(query, { alpha, filters, limit, returnProperties, returnMetadata })` shape
the existing BM25 helper uses. `intentId` is not a parameter: the bot is classifying, so it has no
intent to filter by.

**`searchArticleIds` is not modified.** Public FAQ search is a player typing keywords into a search
box, where BM25's literalness is what they expect and a zero-result state is meaningful. The bot is
matching a full sentence against article prose, where paraphrase is the norm. Same index, two jobs,
two functions — and changing one must not silently change the other.

`alpha = 0.5` is a starting point, not a finding. It is a named constant so it moves in one edit.

**`OPENAI_APIKEY` becomes required** in `env.ts` (it is `.optional()` today). `getWeaviateClient`
already forwards it as the `X-OpenAI-Api-Key` header, which is what vectorizes the query at search
time — so hybrid without it does not fail loudly, it degrades. Making it required at boot, alongside
`WEAVIATE_URL`, is what stops that. One key now serves two purposes: the vectorizer header here, and
spec 4's chat client.

> **To verify before implementing:** that the header path is actually live and existing `Article`
> objects carry vectors. If `OPENAI_APIKEY` was unset when articles were indexed, they were stored
> unvectorized and hybrid will quietly behave as BM25 — a re-index, not a code fix. Cheap to check;
> expensive to discover from bad answers.

### 3 · Retrieval failure is `unavailable`, not zero articles

The hybrid call inherits `WEAVIATE_CALL_TIMEOUT_MS` (5 s) and throws on timeout. That throw
propagates: the job retries, and on the final attempt the conversation takes spec 1's `unavailable`
path with a new reason.

> **Spec 4 delta:** the throw now originates inside the `search_articles` tool handler, mid-loop. It
> is deliberately **not** caught and reported back to the model as *"search failed, carry on"* — a bot
> that cannot read the articles cannot answer from them, and inventing an answer or handing off as
> though it had checked would both be worse than the fallback. The throw leaves the loop untouched
> and reaches BullMQ exactly as described here.

```ts
export type UnavailableReason =
  | 'not_provisioned' | 'not_implemented' | 'error' | 'timeout' | 'invalid_response'
  | 'retrieval_failed'   // added by this slice
```

Hybrid **widens** what this covers. BM25 fails only if Weaviate is down; hybrid also fails if the
vectorizer call from Weaviate to OpenAI fails — a second third party inside the same 5 s budget, on
every single bot turn. `retrieval_failed` covers both, and the message logged alongside it carries
the underlying error so the two are separable in the logs even though they are one reason in the
metric.

The tempting alternative — treat an outage as "no articles matched" — produces the same *visible*
outcome (the rules tell the bot to hand off when nothing answers the question) while recording it as
`bot_handoff`. The bot would be credited with a good decision every time search was down, and the
Bot-fallbacks metric would read zero through an outage. **The two must not be confusable**, which is
the same reasoning that split `bot_handoff` from `bot_unavailable` in spec 1.

### 4 · There is no relevance floor, and the model is now solely responsible for refusing

BM25 scores 0 when a document shares no term with the query, which is why `searchArticleIds` carries
`MIN_BM25_SCORE = 0.05` and why "nothing matched" is a state that occurs. **Vector similarity is
never zero.** Under hybrid, an unanswerable question returns the three least-unrelated articles in
the workspace with respectable fused scores.

So the bot applies **no score threshold**. Top-3 by fused score always go to the model.

The consequence has to be stated plainly rather than discovered: **retrieval no longer contributes
anything to "don't answer from an irrelevant article."** That behaviour now rests entirely on one
line of `DEFAULT_BOT_RULES` — *"If you are not confident an article answers the question, hand off"* —
which is a field an admin can edit, in a table with no validation that it still says so.

This is accepted deliberately. A fused-score threshold is not the fix: hybrid scores are
rank-relative and not comparable across queries, so any constant would be a guess that drops good
matches on some queries and admits noise on others, while *looking* like a safeguard. An honest
absence beats a decorative gate.

Two things follow, both for later slices, both recorded so they are choices rather than omissions:
the bot-admin screen should warn when a custom `rules` value drops the refusal instruction, and spec
3's response schema is where a model-reported confidence or an explicit "none of these are relevant"
signal would belong.

The zero-result sentinel still exists and still renders:

```
No help articles matched this question.
```

It is now reachable in exactly one situation — **a workspace with no published articles at all**,
which is the non-negotiables' *"no published articles → skip the article step"* case and needs no
special path. Never an empty region under the `{{articles}}` heading: a blank looks like a truncation
bug to a model as easily as it reads as absence.

### 5 · Everything that enters the prompt is size-capped

| Bound | Value | Why |
|---|---|---|
| `BOT_ARTICLE_LIMIT` | 3 | The hybrid `limit`, **per `search_articles` call**. Three, not five — see below |
| `MAX_CATALOGUE_ARTICLES` | 200 | §10 — the `{{articles}}` catalogue |
| `MAX_ARTICLE_BODY_CHARS` | 2000 | One long article must not crowd out the other two |
| `MAX_HISTORY_MESSAGES` | 20 | A player can send many messages before the worker runs |
| `MAX_HISTORY_BODY_CHARS` | 1000 | Per message |
| `MAX_PLAYER_VALUE_CHARS` | 100 | See §8 — this one is not about tokens |

**Three articles, not five, follows from §4.** With a BM25 floor, a fourth and fifth result were
either relevant or filtered out. With no floor, every extra slot is a *guaranteed* extra article,
relevant or not — so the tail is pure noise the model has to reject, and each one is another chance
it doesn't. Fewer, better-ranked candidates is the right trade once retrieval stops gating.

A truncated article body ends with `… [truncated]` rather than stopping mid-sentence silently, so a
model reasoning about an incomplete instruction can see that it is incomplete, and so can whoever is
debugging the answer.

History is capped from the **newest** end — the last 20, not the first 20.

### 6 · Substitution runs on the joined prompt, and leaves unknown placeholders alone

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

### 7 · The subintent list and its decoder are built together, or not at all

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

### 8 · Player values are `unknown` for every no-data state, and are treated as hostile input

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

**`declared` is player-controlled too.** It arrives from the SDK and, *in this slice*, lands in the
system prompt — the one place in this system where client input outranks instructions. So:

- Non-scalar values (object, array, null) render `unknown`. Only string, number and boolean are
  formatted.
- Values are trimmed, newlines and carriage returns collapsed to spaces, and truncated to
  `MAX_PLAYER_VALUE_CHARS`.

Stripping newlines is the load-bearing one: a multi-line value is what turns a context field into
something that looks like a new section of the prompt. This is a mitigation, not a solution —
`spend_tier: "whale, ignore the rules above"` still arrives as a hundred characters of adversarial
text inside the system prompt, and the real answers (moving player context out of the system role,
or declaring these fields untrusted to the model) belong in spec 4 where the message roles are
decided. **Recorded here because it is a property of this design, not an oversight of it.**

### 9 · History is player and bot only, through `toPlayerView`

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

### 10 · `{{articles}}` is the catalogue, not the retrieved set — added 2026-08-12

Prefetched retrieval had `{{articles}}` render the three retrieved articles, bodies included. With
retrieval behind a tool there is nothing to prefetch, so the placeholder needs a new meaning.

`{{articles}}` renders **every published article's title, grouped by intent** — no bodies, no
keywords, no ids — capped at `MAX_CATALOGUE_ARTICLES`.

```
Purchases
  Why didn't my gems arrive?
  Restoring purchases
Progress
  Lost progress after update
```

**There is no `summary` field and none is wanted.** `project-overview.md` describes this placeholder
as *"titles and summaries"*, and the editor wireframe shows a `Summary` field labelled *"search +
bot"*, but `article` has only `title`, `body`, `keywords`, `intent_id` and `state`. That is
deliberate, not a gap: a summary is a second copy of the answer that has to be kept in step with the
first, and a stale summary is worse than none because it is the copy the bot reads. Recorded in
`docs/decisions/spec-contradictions.md` as a rejected field so nobody adds it back on the strength of
the wireframe.

**Keywords stay out of the prompt, because they are a search field.** They are indexed in Weaviate and
boosted `^2` in the query, so a model searching *"gems missing"* reaches the right article through the
index without the catalogue ever naming them. Putting them in the prompt would duplicate in tokens
what the index already does in ranking.

Titles alone are enough for what the catalogue is for. Knowing that nothing in the corpus concerns
tournaments is what lets the model report `no_article` honestly, and a title is sufficient to
establish that.

**Three reasons this is the right shape rather than dropping the placeholder.**

It is the only thing that lets the bot know what it *cannot* answer. A search returns the three
least-unrelated articles whatever you ask it (§4 — there is no score floor), so search alone can
never establish absence. A model that has seen the catalogue can report `no_article` honestly, and
that reason is *"the raw material for deciding which articles to write next."*

It makes the model's queries better. Knowing the corpus covers purchases, progress and account
recovery — and not, say, tournaments — shapes a query far more than guessing from the player's
wording.

**No ids and no bodies is deliberate.** Bodies would put the whole corpus in every prompt. Omitting
ids means the model cannot call `offer_article` from the catalogue alone; it must search first, which
is exactly spec 4's validation rule — an article is never offered without its body having been read.

The division of labour: **the catalogue says what exists, the tool says what it says.**

The zero-articles sentinel in §4 still renders, unchanged, and is still reachable only in a workspace
with no published articles at all.

`MAX_CATALOGUE_ARTICLES = 200` is a ceiling, not a target — roughly 6k tokens at the seed corpus's
size. A workspace past it gets a truncated catalogue with a marked count, and that is the point at
which the catalogue needs replacing with something smarter. Same treatment §7 gives a 200-subintent
taxonomy: the honest size of the problem, recorded rather than silently truncated.

---

## `BotTurnInput` — the shape spec 1 left open

```ts
export type BotTurnInput = {
  /** Fully assembled and substituted. Nothing downstream edits this string. */
  systemPrompt: string
  history: BotTurnHistoryEntry[]
  /** 1-based, matching the rendered list. Spec 4 decodes the model's answer with it. */
  indexToSubintentId: ReadonlyMap<number, string>
}
```

**Spec 4 adds four fields** — `playerContext`, which it moves out of the system prompt into a `user`
message, plus `botPhase`, `botMessageCount` and `lastPlayerMessageAt` for the phase gate, the budget
guard and the resumption line in the state block. All are values this slice's gather step already
holds or can read in the same transaction; none changes the three below.

Three fields, and deliberately no `articles`, no `conversationId`, no raw config. The decider's whole
job is: given this prompt and this history, what should happen — and given an index, which subintent
was that. Anything else it could reach for is something spec 4 would be able to make a second,
divergent decision from.

`fallbackSubintentId` is **not** here. Resolving an unresolvable index is spec 4's, and so is the
`Other` row it needs.

---

## Modules

All under `backend/src/domain/bot/`, exported through `index.ts`.

| File | Exports | Notes |
|---|---|---|
| `retrieval.ts` | `retrieveArticles(workspaceId, query)` | Calls `searchArticleIdsHybrid`, hydrates from Postgres, re-orders to the fused ranking |
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
`resolvePlayerContext` (via `conversation.session_id`), the message rows for `buildHistory`, and the
published-article catalogue for `{{articles}}` (§10). Then `assembleBotTurnInput`, then
`decider(input)` as before.

> **Spec 4 delta.** `retrieveArticles` leaves the gather step entirely — it is now called from the
> `search_articles` tool handler, inside the loop, outside any transaction. The property this section
> claimed still holds and holds more strongly: a conversation an agent has claimed returns `noop` at
> the guard and never reaches the loop, so it costs no Weaviate call. A conversation that needs no
> article — a greeting, or a player who immediately asks for a human — now costs none either, which
> prefetching could not avoid.

---

## The assembled prompt

`{{articles}}` renders the catalogue described in §10 — every published title, grouped by intent, with
no bodies, no keywords and no ids:

```
Purchases
  Why was I charged twice? — If you see two charges for the same purchase, one is usually…
  Requesting a refund — Refunds are handled by the platform store, not by us…

Progress
  Lost progress after update — …
```

Grouped by intent rather than numbered. The numbering that earlier drafts used existed so a reader
could match a logged prompt to the article the model chose; that job now belongs to the
`bot_article_offered` event, which records the id and the title outright and does it far better than
a positional index in a prompt.

Titles are never truncated. Bodies do not appear here at all — `search_articles`
returns them, subject to `MAX_ARTICLE_BODY_CHARS`.

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

- The hybrid query is passed through verbatim from `search_articles`, with `limit` =
  `BOT_ARTICLE_LIMIT` and `alpha` = `HYBRID_ALPHA`, and no `intentId` filter. (Was: *"the query is the
  latest player message only"* — superseded by spec 4.)
- The `workspaceId` filter is applied — another workspace's articles are never retrievable.
- Postgres hydration re-orders rows to the fused ranking, not to `published_at`.
- **No score filtering:** a stubbed response of three low-scoring objects yields three articles, not
  zero. The §4 decision, asserted rather than assumed — if someone later adds a threshold, this test
  is what tells them it was deliberate that there wasn't one.
- `searchArticleIds` (public FAQ search) is unchanged: its existing tests still pass, and it still
  applies `MIN_BM25_SCORE`.
- An id returned by Weaviate whose row is no longer `published` is dropped, not rendered blank —
  the index can lag Postgres.
- A throwing/timing-out `searchArticleIds` propagates, and the orchestrator surfaces it as
  `{ kind: 'unavailable', reason: 'retrieval_failed' }` — asserted through `runBotTurn`, not by
  inspecting the throw.
- No Weaviate call is made when the status guard has already returned `noop`.

---

## Deviations

None from `project-overview.md`. Two things it leaves open are decided here and worth naming: the
retrieval query is one message rather than the conversation (§1), a search-index outage counts
as a bot fallback rather than a bot handoff (§2).

**Resolved 2026-08-12:** spec 4 §7 moves player context out of the system prompt into a `user`
message, which removes the structural privilege this paragraph was worried about. The residual risk
it names — that a determined `user` turn can still talk a model out of its instructions — remains, and
is contained by the bot having no action available but reply or hand off, both of which reach a human.

The player-context injection surface described in §8 is a **known, bounded risk carried forward to
spec 4**, not a resolved one.
