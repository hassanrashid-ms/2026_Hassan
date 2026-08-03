# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

The **Core API, agent console, admin console and web support surface** for Support CRM — a
multi-tenant customer support tool for mobile games. This repo is one of two:

| Repo | Contents |
|---|---|
| `2026_Hassan` (this one) | Core API + console + web support surface |
| `2026_Hassan_Sdk` | Unity game-client SDK |

### Source of truth, in order

1. `mindstorm/crm/Docs/Customer Support Tool - CRM v2 (1).pdf` — the product spec (45 pages).
   **Requirements. Wins over everything.**
2. `mindstorm/crm/Docs/Customer Support - CRM.txt` — 10 delivery slices across 3 weeks. Wins on
   *what belongs to which week*.
3. The SDK repo's `docs/specs/overview+sdk.md` — the decision record for things settled in
   conversation and not written in the spec.
4. This file — a summary of 1–3 plus the server decisions. If it disagrees with the spec, the spec
   is right and this file is stale.

`Docs/` sits one level above both repos and is deliberately tracked by neither.

## Current state

**Scaffold only.** `frontend/` and `backend/` contain nothing but a README. There is no
`package.json`, no workspace manifest, no env template, no models, no tests. Do not invent commands
for this repo — there are none yet. The first task is scaffolding the pnpm workspace.

Planned stack (decided, not installed):

| Layer | Choice |
|---|---|
| Repo | pnpm workspaces monorepo, shared `@support/types` as the SDK↔server contract |
| Server | Express 5 + TypeScript + Zod (schemas double as validation and types) |
| ODM | Mongoose 8 — chosen specifically for the plugin/hook system the tenancy guard needs |
| Database | MongoDB |
| Realtime | Socket.io + `@socket.io/redis-adapter`, rooms per conversation |
| Jobs | BullMQ repeatable jobs |
| Files | S3 or Cloudflare R2, presigned PUT — never proxy uploads through Node |
| Bot retrieval | Atlas Vector Search, or in-memory cosine if self-hosting |
| Console | Vite + React + TanStack Query + Tailwind + shadcn/ui |
| Charts | Recharts |

## Architecture

```
Unity SDK ─┐
Web SDK ───┼──▶ Core API (Express, Socket.io, workspace scoping)
Console ───┘         │
                     ├── MongoDB (documents + append-only events)
                     ├── Redis + BullMQ (sockets, scheduled jobs)
                     └── Object storage (presigned uploads)
```

**The support UI is built once as a web app; every platform's SDK is a thin shell that opens it with
a signed token.** So the chat thread, image upload, article browsing, the bot conversation and the
forms all live here, not duplicated per platform. The token arrives in the URL **fragment**
(`#t=`) — fragments never reach the server in a request line, so they stay out of access logs and
`Referer` headers. Issue a short-lived player JWT from `POST /auth/player-token`, which the *game's*
backend calls with its workspace secret. The SDK never holds a secret.

## The core loop

Everything in the spec serves one loop, and every feature is an optimisation of it:

> A player opens support inside the game → reads the help articles → if that doesn't solve it,
> describes the problem to the bot → the bot answers from the FAQ, or collects what's needed and
> hands off → an agent resolves it → the conversation closes.

**"If this loop does not work, nothing else matters."** Three doors out, each cheaper than the next:
help articles (free), the bot (almost free), an agent (the expensive one). The first two exist to
make sure the third only handles what actually needs a person — **not** to block it.

## Domain model

**Workspace = one game.** Scoped to a workspace: articles, subintents, forms, labels, saved filters,
bot config, player records, conversations. Shared across workspaces: **nothing**. Agent accounts are
global — one login per person — but an agent's **role is held per workspace**. A player of two of
your games has two unrelated records and no cross-game history.

**Conversation** (= Ticket; the terms are interchangeable) is the central object. Holds: messages,
internal notes (inline in the same thread), attachments, the player-state snapshot, classification
(intent + subintent, labels, priority `p1`–`p4`), form submission or a form-skipped marker,
ownership, status, reopen count, classification source (`bot` | `agent` | unset), which article the
bot offered and whether it was rejected, and an inactivity-clock flag.

**Message** — author type `player` | `agent` | `bot` | `system`, body, attachments, server-assigned
`seq`, `delivery_state`, internal-note flag.

**Player state** — one blob from the SDK, stored two ways:

| | Declared | Freeform |
|---|---|---|
| What | Fields an admin declared in advance | Everything else the SDK sent |
| Storage | Typed and indexed | As-is |
| Searchable | Yes — filter, sort, save as a view | Display only |

Declared set expected on every conversation: `player_id`, `client_version`, `platform`,
`os_version`, `device_model`, `locale`, `player_level`, `total_spend`, `spend_tier`,
`account_created_at`, `last_session_at`. **Promotion is never retroactive — no backfill, ever.**
Record the declaration date so a filter returning partial results is explainable rather than
mysterious. Nothing the game sends is ever dropped.

**Intent** (= category) → **Subintent**. Articles belong to an **intent**, not a subintent.
Subintent holds parent intent, default priority, and a linked form. **Store only the deepest level
reached** and derive the parent — storing both lets them drift apart when the taxonomy is edited.
Start with 3–4 subintents per intent.

**Article** — title, body, intent (exactly one), **summary** and **search keywords** (these two are
for the bot and for search, not for humans). States: Draft / Published / Archived. Only Published is
ever in the bot's knowledge or visible to players.

**Form** — attached to a subintent, versioned, always skippable. A subintent maps to exactly one
form; a form can serve several subintents. **Exactly six field types**: short text, long text,
choice, date, number, attachment. Editing a live form mints a new version; every submission records
the version it used.

**Rule** — conditions read conversation fields, classification, labels, and any searchable
player-state field; actions apply a label, set priority, assign, or send a message. **Exactly one
extra evaluation pass after an action changes the conversation, then stop** — otherwise two rules
trigger each other indefinitely. Every firing is logged (which rule, which conversation, what it
did); a rule engine without an execution log is unmaintainable within weeks.

Also: **Label** (flat, many per conversation), **Saved filter** (private, or shared by a Team Lead),
**Session** (the denominator for self-serve rate), **Agent** (active / on leave).

## Conversation status machine

| Status | Meaning | Player sees |
|---|---|---|
| `new` | Created, not yet handled — transient, always left immediately | Received |
| `bot_active` | The bot is handling it. **Every conversation starts here** | Received |
| `open` | Assigned to an agent. Support owns the next action | We're looking into it |
| `awaiting_player` | The agent asked something. The player owns the next action | Waiting for your reply |
| `escalated` | Handed to engineering | We're looking into it |
| `resolved` | Player-confirmed **or** timed out | Resolved |
| `closed` | Settled for reporting. Automatic, some days after `resolved` | Resolved |

`abandoned` **does not exist** — the inactivity clock replaced it. Don't reintroduce the name.

Transitions:

| From → To | Trigger |
|---|---|
| — → `new` → `bot_active` | Always. The bot is the entry point; **there is no menu path** |
| `bot_active` → `resolved` | The player confirms the bot's answer solved it |
| `bot_active` → `open` | Form submitted or skipped; or player asks for a person; or bot errors/times out/disabled (**unclassified**) |
| `open` → `awaiting_player` | Agent asks something and marks it waiting |
| `awaiting_player` → `open` | Player replies |
| `open` ↔ `escalated` | Handed to engineering, and returned |
| `open` / `awaiting_player` → `resolved` | Agent resolves, or the inactivity clock does |
| `resolved` → `closed` | Auto-close window elapses (**the spec never states the window**) |
| `resolved` / `closed` → `open` | Reopened. **No time limit, ever** |

`closed` is terminal **for reports only**. **No status is terminal for the player** — a message of
any age reopens the *existing* conversation, so the player never re-explains, and a fresh resolution
cycle starts on the same record with `reopen count + 1`.

**Escalation moves the work, not the relationship:** the agent stays owner throughout, and the
player-visible status stays "We're looking into it". Never surface `escalated` to the player.

### The inactivity clock — two stages, both sides equally

1. 24 h with no message **from either party** → the bot asks "Is your issue resolved?"
2. Player says yes → `resolved`, recorded **player-confirmed**.
3. Player says no → stays as it was, **clock restarts**.
4. No reply within a **further 24 h** → `resolved`, recorded **timed out**.

Two hard consequences: reporting must **separate player-confirmed from timed-out** resolutions, and
**if support owed the reply when the clock fired, flag the conversation** — it surfaces in both the
queue and reporting. A conversation that timed out waiting on an agent is a support failure wearing
a resolution's clothing.

This needs a scheduled worker, and it fires from `open` as well as `awaiting_player`. The spec never
says what it does to `escalated`.

### Message delivery states

`sending` (client has it, server hasn't confirmed) → `sent` (server has it) → `delivered` (reached
the device) → `read` (recipient opened the conversation with it visible). `failed` offers retry. No
client report → stays at `delivered`. Tracked **per message, both directions** — an agent needs to
know their reply landed.

**Push is best effort; fetch-on-open is the guaranteed path. No requirement may depend on push
alone.**

### Assignment

Round-robin among active agents; bot handoffs are **auto-assigned**. No active agent → the
unassigned queue, where it still ages and is visible to everyone. **Two agents claiming at once:
exactly one succeeds; the other sees "already claimed" — not an error, not a duplicate reply.**
Deactivating an agent returns their open conversations to the unassigned queue.

### Taxonomy changes

Rename freely (existing conversations follow the new name). **Delete is not permitted — archive
instead.** Archived is hidden from the bot but kept on existing conversations and in reporting. Move
and merge are allowed and **their date is recorded**, so a volume trend can distinguish real change
in player behaviour from someone reorganising the list. Seed the **`Other`** intent in a migration
and guard it in the archive handler: `Other` can never be archived or removed, and rising volume
there is the signal that the taxonomy has a gap.

## Server-side decisions worth not re-deriving

**Message ordering.** Server-assigned sequence, never device clocks. Atomic `findOneAndUpdate` on
the conversation with `$inc: { messageSeq: 1 }` and `returnDocument: 'after'`, then insert with that
seq. Unique compound index on `{ conversationId: 1, seq: 1 }`. Gaps are fine; order is not.
**Do not embed messages in the conversation document** — 16 MB cap and unbounded growth.

**Declared vs freeform.** Store `state.declared` (admin-promoted) and `state.raw` (everything else).
A wildcard index on `state.declared.$**` gives filtering on any declared field without an index per
field, which matches the admin-promotes-a-field workflow exactly. The attribute pattern is the
alternative; wildcard ships faster.

**Tenancy is the highest-risk thing in the build.** "No cross-workspace reads, enforced in the data
layer" means a Mongoose global plugin with `pre` hooks on `find`, `findOne`, `updateOne`,
`countDocuments` and — the one people forget — **`aggregate`**, which needs a manual `$match`
unshifted onto the pipeline. Pull `workspaceId` from `AsyncLocalStorage`. Write one integration test
that authenticates as workspace A and tries every endpoint against workspace B's IDs.

**Internal notes leaking is safety-critical** — the spec says so explicitly: "one bug leaks internal
notes to a player." Do **not** filter in the query. Use two serializers, `toAgentView(message)` and
`toPlayerView(message)`, where the player one is an explicit field **whitelist** and returns null for
`visibility !== 'public'`. Player-facing routes may only call the player serializer. Same for
sockets: emit to `conv:{id}:agents` and `conv:{id}:player` as **separate rooms**, so a player socket
can never receive an internal-note event.

**Metrics require event sourcing.** "Resolution counts events, not current status" and "a reopen
starts a new resolution cycle" cannot be computed from a conversation's current `status`. Use an
append-only `events` collection —
`{ workspaceId, type, conversationId, actorId, actorType, ts, payload }` — written on every state
change, with all reporting as aggregations over it. **Build this on day two.** Retrofitting it in
week 3 means weeks 1–2 have no data, and most of these numbers cannot be reconstructed later.

Event types needed: `intent_set` (with `source: bot|agent`), `intent_corrected`, `article_shown`,
`article_rejected`, `session_start`, `session_end`, `first_human_reply`.

**Article schema.** Embed `summary` and `knownPhrasings` separately from `body`. Body text full of
"tap the button below" retrieves badly — embed the summary and each phrasing, match against those,
and return the body.

**Permission checks run at the API.** Hiding a control in the UI is not enforcement.

**Change log.** Status, permission, taxonomy, bot and configuration changes are recorded **with the
value before and after**.

### Traps

- `resolved → closed` needs a scheduled worker, and so does the two-stage inactivity clock.
- Never store both intent and subintent — store the deepest reached, derive the parent.
- **No hard deletes anywhere; don't even write the route.**
- Version-stamp every form submission.
- Missing player state is a state, not an error — never reject the conversation. Those are exactly
  the conversations where something is broken.
- Treat `state.raw` as **PII by default**: it is uncontrolled client input and may contain anything,
  so it must be handled as personal data for access and retention purposes regardless of contents.
- Deleting an article must not break the record of which article the bot offered. That record is a
  fact about what happened, not a foreign key to live content.

## Roles and permissions

Four roles: **Player** (nothing but the in-game surface), **Agent**, **Team Lead**, **Admin**.
Permissions attach to roles; **a permission is never granted to an individual.**

Every agent-or-above can view every conversation in the workspace, claim, reply, note, reclassify,
label, reprioritise, mark awaiting-player, resolve, reopen and escalate. The asymmetries are what
matter:

| Capability | Agent | Team Lead | Admin |
|---|---|---|---|
| Reassign any conversation | · | ✓ | ✓ |
| Create a **shared** saved filter | · | ✓ | ✓ |
| View per-agent workload | · | ✓ | ✓ |
| Create / edit an article **draft** | ✓ | ✓ | ✓ |
| Import articles from markdown | · | ✓ | ✓ |
| Build or edit forms · map forms to subintents | · | ✓ | ✓ |
| See the bot's configuration · trigger a manual sync | · | ✓ | ✓ |
| **Publish a form** | · | · | ✓ |
| Create / rename / archive / move / merge a subintent | · | · | ✓ |
| Edit the bot prompt or rules · provision or disable the bot | · | · | ✓ |
| Build or edit rules · declare searchable player fields | · | · | ✓ |
| Change a role · deactivate an agent · create a workspace | · | · | ✓ |
| **Delete a message, conversation or subintent** | · | · | · |

Reporting is visible to everyone, but the **Agents tab is Team Lead and Admin only** — agents can
see reporting, not each other's throughput.

**Building and publishing are separate acts by different people.** Team Leads build forms and draft
articles; only an Admin puts them in front of players. (See contradiction 2 below.)

## Metrics

| Metric | Calculation |
|---|---|
| Self-serve rate | Sessions ending without a conversation created |
| Resolved by the bot | Conversations the player confirmed the bot's answer for |
| Resolution rate | Conversations reaching `resolved`, **split player-confirmed vs timed out** |
| Time to first reply | Created → **first agent message** |
| Resolutions per agent per day | Resolution events ÷ **active agent-days** |
| Reopen rate | Conversations reopened at least once |
| Misclassification rate | Conversations where an agent changed the **subintent** |
| Asked for a person | Conversations where the player bypassed the bot |
| Bot fallbacks | Conversations created unclassified because the bot was unavailable |

Counting rules — getting these wrong makes the numbers quietly meaningless:

- **Resolution counts events, not current status.** Reopening never expires, so "currently resolved"
  changes retroactively and last month's figure would move when someone replies today.
- **A reopen starts a new resolution cycle.** The same conversation can resolve more than once; each
  counts separately, in the window it happened.
- **Player-confirmed and timed-out are reported separately.** Folded together, silence counts as
  success and the rate rises fastest when support is at its worst.
- **Self-serve is per session, never per ticket.** Per ticket, the rate improves whenever
  conversations get harder to start: better number, worse product.
- **First reply means first *human* reply.** Bot, system and internal-note messages don't count.
- **Active agent-days means days actually worked**, not days employed.

Deliberately **not** metrics: total ticket volume (moves with player count and live events), time to
resolution as a headline (mostly measures the player's availability), and **bot containment as a
target** — reported, never a goal, because optimising to keep players away from humans is how a
support tool becomes something players work around.

Reporting product rules: four tabs (**Overview · Self-serve · Agents · Bot**), any date range plus a
separate comparison period, a sparkline on every headline number, and **no targets anywhere** for
the first 30 days of live data. Queue-right-now and active-agent panels are live; everything else
respects the date range. No composite score and no ranking on the Agents tab — reopen rate and
corrections are coaching signals, not scores.

Two panels **cannot exist** without the article "Did this help? / Did this solve it?" signal: the
self-serve split between "found the answer" and "left without an answer", and the bot's
articles-offered→rejected panel. Capture that signal early.

## The bot

Not trained — **the published article corpus is its entire knowledge**, which is why support owns
its quality and engineering does not. It reads what the player wrote in their own language, infers
intent and subintent, offers the relevant article in the conversation, and asks whether that solved
it. Yes → resolve, recorded player-confirmed. No → show the form for that subintent. Form submitted
or skipped → assign to an agent.

- **The bot only resolves when the player says so.** It never decides on its own that it is finished.
- **It may only choose subintents that already exist. It never invents one.** Anything it can't
  place goes to `Other`.
- Handoff carries everything: what the player wrote, the classification, which article was offered
  and that it was rejected, the form answers or that they were skipped, and the player-state
  snapshot. An agent who re-asks what the bot already gathered has been slowed down by the bot.
- **Two mechanisms for reaching a person, not one:** understood from what they wrote (including
  visible frustration), *and* a control that is always on screen.
- Config has four tabs, all required before provisioning: **Prompt · Rules · Form mapping ·
  Knowledge** (+ sync state). The prompt uses placeholders — `{{subintents}}`, `{{articles}}`,
  `{{player_level}}`, `{{spend_tier}}` — and **never contains a hard-coded subintent or article**.
- **Two rules can never be switched off:** hand off immediately when the player asks for a person,
  and never ask for a password, card number or personal ID. Locked rules are visible but not
  editable, so an admin can see why the bot behaves that way.
- **The bot cannot be provisioned with an empty rule set.** Anything that can't be expressed as a
  rule belongs in the prompt, never as hidden behaviour in code.
- **Knowledge sync must be loud.** Publishing, unpublishing or archiving syncs automatically; a
  manual sync exists for recovery; last-synced time and last-attempt outcome are always on screen,
  including next to Publish in the article editor. A bot answering from stale content is worse than
  one that says it doesn't know. **The subintent list syncs on the same path** — an unsynced
  subintent will never be assigned, and an archived one the bot still knows about keeps being used.
- Bot failure (model error, timeout, disabled) → conversation created **unclassified and
  auto-assigned**, player sees a normal conversation and **no error**, support is alerted.
  "100% uptime" is not implementable; detection, automatic fallback and alerting are.

## Non-negotiables

**The one hard constraint: nothing may prevent a player reaching a human.** It holds three ways —
asking for a person redirects immediately (not after three turns, not after a failed answer); a bot
that errors/times out/is disabled still creates the conversation, unclassified and auto-assigned;
and refusing the form still hands off, marked form-skipped.

- **Failure is never silent.** The player sees no error; support is alerted. A silent fallback nobody
  notices is its own failure, because quality drops and nothing says why.
- **Nothing is deleted** — not a message, not a conversation, not a subintent.
- **Internal notes never reach a player.**
- **"Still need help?" and "Talk to a person" appear on every screen**, including empty search
  results. No dead ends.
- **The form skip option cannot be removed.**
- **Missing data is a state, not an error** — never a blank panel, never an error page.
- **`Other` cannot be archived or removed.**
- **Everything imports as a draft. Nothing goes live on import.**
- **No cross-workspace reads, enforced in the data layer.**
- **No published articles in a workspace** → skip the article step, go straight to the bot.
- Support owns content, taxonomy, forms, bot prompt and rules. **Changing any of it must never
  require a release.**

## Known spec contradictions

The spec disagrees with itself in a few places. Don't silently pick a side — these are worth a
decision record in `docs/decisions/`.

1. **Player state: tab or panel?** The console wireframes show it as a tab
   (`Conversation | Custom fields | Player state | Other issues`); the prose insists it is *not* a
   tab, because "putting it one click away reintroduces the problem in miniature." Two incompatible
   layouts for the same screen.
2. **Who publishes articles?** The fixed rules and the editor note both say only an Admin publishes;
   the permission matrix gives Team Lead ✓ on publish/unpublish. The matrix is more permissive than
   the stated rule.
3. **`abandoned` is retired — except in Reporting**, where an "Abandoned" column and an 11% figure
   still appear. It presumably means "resolved, timed out" under the retired name.
4. **Reporting tabs:** prose says the Bot tab replaced Flows; every wireframe tab strip still renders
   `Flows`.
5. **Article states:** three (Draft / Published / Archived) in the table and the bot's knowledge
   counts, but the lifecycle diagram says "two states" and omits Archived. Three is the safer read.
6. **"Nothing is deleted" vs. article delete:** the fixed rule enumerates messages, conversations and
   subintents only, while the matrix explicitly allows Admin to delete an article. Easy to
   over-apply in either direction.
7. **Immediate handoff vs. the three-reply rule:** the hard constraint says "not after three turns",
   yet a switchable "hand off after three unhelpful replies" rule ships on by default. Compatible —
   the locked rule is about *asking* for a person — but the wording collides.

Also simply unspecified: the **auto-close window** ("some days after resolved"), what a **queue**
entity actually is (routing examples reference a "senior queue"; the console shows a "Default
queue"), and the behaviour of the inactivity clock on `escalated` conversations.

## Conventions

- Status values, delivery states and player-state keys are **lowercase snake_case**. Priority is
  `p1`–`p4`. Prompt placeholders use `{{double_brace}}`.
- "Category" and "intent" mean the same thing; "ticket" and "conversation" are interchangeable;
  "agent" = CSR.
- The spec is written in **British spelling** (categorise, labelling, behaviour). Match it in any
  user-facing copy lifted from it.
- Article import is **markdown only** — one file, `##` = article title, `###` = intent, following
  plain text = body. No CSV, no spreadsheets. Unrecognised intents file under `Other` as drafts.
