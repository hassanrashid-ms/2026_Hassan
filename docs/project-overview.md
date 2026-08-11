# Project Overview

Full reference for the Support CRM system. Read this when working on domain logic, data
modelling, metrics, or any feature that touches the core entities.

---

## Domain model

### Key decisions — non-obvious things, read before touching any of these entities

**Conversation / Resolution cycle**
- `resolution_cycle` is its own table (`resolved_at`, `resolution_kind`, `first_human_reply_at`,
  `inactivity_due_at`, `closed_at`). A conversation resolves more than once; each cycle counted
  separately in its window. Cycle 1 opens at creation; every reopen opens the next.
- `reopen_count` is `cycle_no - 1` — no counter column.
- Partial unique index (`WHERE resolved_at IS NULL`) makes one-open-cycle-per-conversation a
  database guarantee and finds the current cycle without a circular FK.

**Player state snapshot**
- Keyed to the **session**, not the conversation. The SDK captures it in `Open()` and delivers
  it on `POST /sdk/sessions/start` — before any conversation exists. A conversation reaches its
  snapshot via `conversation.session_id`.
- A reopen never rewrites that FK — "a reopened cycle keeps the original snapshot" is enforced
  by the graph.
- Snapshot may arrive *after* the conversation (Outbox retries). `ON CONFLICT (id) DO NOTHING`
  on `session_id` makes delivery order irrelevant.
- Three distinct no-data states, all rendered "unavailable" but diagnosed differently: **no row**
  (never arrived), **`is_missing = true`** (delivered, provider returned nothing), **`degraded_reason`
  set** (partial — device fields captured, some provider fields threw). All three are states, never errors.
- Two `jsonb` columns: `declared` (admin-promoted, GIN indexed) and `raw` (everything else).
  Split happens at write time against the current `declared_field` set — promotion is non-retroactive
  by construction. **No backfill, ever.**

**Taxonomy (Intent → Subintent)**
- **Store only the deepest level reached, derive the parent.** Storing both lets them drift
  when the taxonomy is edited.
- `Other` is an intent. Seed a catch-all subintent beneath it in the first migration —
  conversations store a subintent, and "anything it can't place" needs somewhere to land.
  Keep `Other` distinct from `subintent_id IS NULL`, which means the bot never ran.
- Archiving an intent is blocked if it has non-archived subintents or published articles.
  Subintents archive freely. Write that asymmetry down or someone implements a cascade.
- **`taxonomy_change` covers both levels, including `create`.** `entity_type` (`intent` | `subintent`),
  nullable `intent_id` and `subintent_id`, CHECK that exactly one is set. `kind` is
  `create | rename | move | merge | archive`.
- **Merge repoints conversations.** Loser keeps a `merged_into_id` forwarding address. Emits one
  `subintent_merged` event per affected conversation with both names snapshotted into the payload.
  `subintent_merged` is distinct from `intent_corrected` — a taxonomy merge must not spike
  misclassification rate.

**Articles**
- `keywords` lives separately from `body` for search matching. See
  `docs/specs/2026-08-07-weaviate-faq-search-design.md` for the current article search/data model
  (Weaviate Cloud BM25, superseding the earlier dead embedding scaffolding).
- **Publish and sync to Weaviate in one flow.** The bot must never see a published article missing
  from the search index.
- Which article the bot offered is **not a column** — it's in `article_shown` / `article_rejected`
  events with the title snapshotted into the payload.

**Forms** — *(2026-08-10: superseding the earlier conversational design below)*
- **Forms are structured, Google-Form-style UIs opened in a modal — not messages in the
  conversation thread.** The bot no longer asks form questions turn-by-turn in the thread; it
  offers the form as a distinct UI action, the player fills it out in the modal, and the answers
  land as one structured submission.
- **Mapped at the subintent level, admin-decided.** An admin chooses which subintents get a
  form and builds it. A subintent maps to exactly one form; a form can serve several subintents.
  A subintent with no form mapped never shows one.
- Field types: short text, long text, number, date, choice, attachment.
- **The thread still shows the outcome, even though the form itself isn't in-thread.** A system
  message/card reports the `form_submission.status` — completed, partial, or **skipped** — the
  same way the bot's article-offered card does today. The modal is where the fields live; the
  thread is still the record of what happened.
- `form_submission.status` is `in_progress | completed | partial | skipped`. Row created when
  the modal opens (`started_at`); `submitted_at` is nullable.
- `form_answer` now holds the field value written directly from the modal's structured input —
  **not** extracted from a chat message. `form_answer.message_id` is dropped; there is no prose
  to parse, so the earlier "original words must be reachable" reasoning no longer applies.
- Attachments: an attachment answer is a direct upload from the form (same presigned-PUT path
  as chat attachments), not an image message in the thread. `attachment.form_answer_id` now
  needs to exist as the direct link — this reverses the earlier "does not exist" note.
- **`is_required` stays soft, but the enforcement point moves.** There's no bot turn to "re-ask
  once" anymore — the modal can validate a required field client-side, but the player can still
  submit with the form skip option or leave it unanswered; nothing may block handoff.
- **Answers are corrected by adding** a second `form_answer` row for the same field. Newest by
  `created_at` wins. Never update in place.

<details>
<summary>Superseded — original conversational design</summary>

- Forms were conversational — the bot asked questions as messages in the same thread, no modal.
- `form_answer.message_id` recorded which message supplied the value; the bot extracted
  structure from prose, so the original words had to stay reachable.
- Attachments: an attachment answer was an image message, reached via
  `form_answer → message → attachment`. `attachment.form_answer_id` did not exist.
- `is_required` was soft at the field level — re-ask once, then move on and record it unanswered.

</details>

**Labels**
- Two tables + mapping: `label` (workspace vocabulary), `conversation_label` (applied tags),
  `subintent_label` (admin-managed many-to-many: classify as this subintent → apply these labels).
- `subintent_label` is a table, not a rule — bot picks subintent → server applies labels and
  `default_priority` → *then* rules evaluate and may read those labels. This ordering is load-bearing.
- An applied tag is permanent until an agent removes it. Reclassification does not swap tags.
- `applied_by IS NULL` marks an auto-applied tag. `label.archived_at` retires a tag from new use
  while keeping it on old tickets.
- **Priority is never a tag.** `subintent.default_priority` already exists.

**Session**
- Session id is **generated by the SDK**, not the server. It has to go in the webview URL before
  any network call succeeds. Accepting it as PK makes `POST /sdk/sessions/start` idempotent via
  `ON CONFLICT (id) DO NOTHING`. Duplicate delivery is expected, not exceptional.
- `session.entry_point` is context only — where in the game they tapped support. **Never classification.**

**Rules**
- **Exactly one extra evaluation pass after an action changes the conversation, then stop.**
  Two rules triggering each other indefinitely otherwise.
- Every firing is logged (which rule, which conversation, what it did). A rule engine without an
  execution log is unmaintainable within weeks.

---

## Conversation status machine

This section is the spec — the target machine, not the build state. For which transitions the
backend actually enforces today and which are still unbuilt, see
[`status-transitions.md`](status-transitions.md).

| Status | Meaning | Player sees |
|---|---|---|
| `new` | Created, transient, always left immediately | Received |
| `bot_active` | Bot handling it. **Every conversation starts here** | Received |
| `open` | Assigned to an agent. Support owns next action | We're looking into it |
| `awaiting_player` | Agent asked something. Player owns next action | Waiting for your reply |
| `escalated` | Handed to engineering | We're looking into it |
| `resolved` | Player-confirmed **or** timed out | Resolved |
| `closed` | Settled for reporting. Automatic after `resolved` | Resolved |

`abandoned` **does not exist.** Don't reintroduce the name.

| From → To | Trigger |
|---|---|
| — → `new` → `bot_active` | Always. No menu path, bot is the entry point |
| `bot_active` → `resolved` | Player confirms bot's answer solved it |
| `bot_active` → `open` | Form submitted or skipped; player asks for a person; bot errors/times out/disabled (unclassified) |
| `open` → `awaiting_player` | Agent asks something and marks waiting |
| `awaiting_player` → `open` | Player replies |
| `open` ↔ `escalated` | Handed to engineering and returned |
| `open` / `awaiting_player` → `resolved` | Agent resolves, or inactivity clock |
| `resolved` → `closed` | Auto-close window elapses (**7 days**, per-workspace setting) |
| `resolved` / `closed` → `open` | Reopened. **No time limit, ever** |

`closed` is terminal for reports only. **No status is terminal for the player** — a message of
any age reopens the existing conversation.

**Escalation moves the work, not the relationship:** the agent stays owner; player-visible status
stays "We're looking into it". Never surface `escalated` to the player.

### Inactivity clock — two stages

1. 24 h with no message from either party → bot asks "Is your issue resolved?"
2. Player says yes → `resolved`, **player-confirmed**.
3. Player says no → clock restarts.
4. No reply within a further 24 h → `resolved`, **timed out**.

Fires from `open` as well as `awaiting_player`. On `escalated`: set `inactivity_due_at = NULL`
so the worker skips it.

If support owed the reply when the clock fired, **flag the conversation** — surfaces in the queue
and reporting. A timed-out conversation where support owed a reply is a support failure wearing a
resolution's clothing.

### Message delivery states

`sending` → `sent` → `delivered` → `read`. `failed` offers retry. Tracked per message, both
directions. Push is best effort; **fetch-on-open is the guaranteed path.**

### Assignment

Round-robin among active agents; bot handoffs are auto-assigned. No active agent → unassigned
queue. **Two agents claiming at once: exactly one succeeds; the other sees "already claimed" —
not an error, not a duplicate reply.** Deactivating an agent returns their open conversations to
the unassigned queue.

---

## Server-side decisions

**Message ordering.** Server-assigned sequence, never device clocks.
`UPDATE conversation SET message_seq = message_seq + 1 WHERE id = :id RETURNING message_seq`,
then insert the message with that seq, both in one transaction. Unique index on
(`conversation_id`, `seq`). Gaps are fine; order is not. **No I/O inside that transaction.**

**API Documentation (Swagger / OpenAPI 3.0).**
The API routes and Zod schemas (`@support/types`) are compiled into an OpenAPI 3.0 specification (`backend/src/docs/openapi.ts`).
- **Interactive Swagger UI**: `http://localhost:4000/docs`
- **Raw OpenAPI JSON Spec**: `http://localhost:4000/docs/json`
All authentication schemes (`WorkspaceSecretAuth`, `PlayerJwtAuth`, `AgentJwtAuth`) are documented with "Try it out" enabled.
- **Rule**: When adding any new API endpoint, always register its path and Zod schema in `backend/src/docs/openapi.ts` so the Swagger UI remains automatically updated.

**Tenancy.** Every scoped table gets:
```sql
CREATE POLICY tenant ON <t> USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
```
Every request runs `SET LOCAL app.workspace_id = '<uuid>'` inside its transaction. A query
with no workspace predicate returns zero rows — no code path around it. Only `workspace` and
`agent` are unscoped. Write one integration test: authenticate as workspace A, try every
endpoint against workspace B's IDs. **Expect `404`, not `403`** — under RLS, rows are invisible
so "not yours" and "not there" are indistinguishable.

**Internal notes leaking is safety-critical.** Do not filter in the query. Two serializers:
`toAgentView(message)` and `toPlayerView(message)`. The player serializer is an explicit field
**whitelist** and returns null for `visibility !== 'public'`. Player-facing routes may only call
the player serializer. Emit to `conv:{id}:agents` and `conv:{id}:player` as **separate rooms**
so a player socket can never receive an internal-note event.

**Metrics require event sourcing.** "Resolution counts events, not current status" and "a reopen
starts a new resolution cycle" cannot be computed from a conversation's current `status`. Use an
append-only `event` table:
```
{ workspace_id, type, conversation_id, session_id, actor_id, actor_type, occurred_at, payload }
```
Enforce append-only with `REVOKE UPDATE, DELETE`, not a convention. BRIN index on `occurred_at`;
btree on (`conversation_id`, `occurred_at`). **Build this on day two** — most numbers cannot be
reconstructed retroactively.

Event types needed: `intent_set` (with `source: bot|agent`), `intent_corrected`,
`subintent_merged`, `article_shown`, `article_rejected`, `session_start`, `article_read`,
`still_need_help_reached`, `session_end`, `first_human_reply`, `conversation_resolved`,
`conversation_reopened`, `assignment_returned`, `form_started`, `form_completed`, `form_partial`,
`form_skipped`, `sdk_incident`.

**`article_read` and `still_need_help_reached`** are what the funnel is made of (Opened → Viewed
article → Reached "still need help?" → Created a ticket). `article_read` ≠ `article_feedback`:
reading and answering "did this help?" are separate signals.

**`sdk_incident`** is where `POST /sdk/incidents` lands — an `event` row, not its own table.
Low volume; inherits workspace scoping, BRIN and append-only for free. **Something must watch it**
— a rising count is how you find out a release broke support entry for a whole platform.

**Payload values are snapshotted, never live pointers.** A name resolved through a FK silently
rewrites history when someone renames the thing.

**Events are a projection, not the source of truth.** `conversation` stays a mutable row the
console reads directly; every state change also appends to `event`. All state changes go through
one function that writes both in a single transaction — never ad-hoc updates.

**Any bulk operation touching conversations emits a per-conversation event**, not just a summary
row. Merge and deactivating-an-agent are the two cases.

**Embeddings.** Publish an article and write its embeddings in one transaction.

**Permission checks run at the API.** Hiding a control in the UI is not enforcement.

**Change log.** Status, permission, taxonomy, bot and configuration changes are recorded **with
the value before and after**.

### Traps

- **`SET LOCAL app.workspace_id = $1` is a syntax error.** Use
  `select set_config('app.workspace_id', $1, true)`.
- **RLS does not bind the table owner** unless the table is `FORCE ROW LEVEL SECURITY`. The app
  connects as a non-owner role (`support_app`) — a mistake in either mechanism is caught by the other.
- **Foreign-key checks bypass RLS.** Any client-supplied id used as a FK must first be confirmed
  visible with an explicit scoped `SELECT`, or a row can point across the tenant boundary while
  every policy is in place.
- `resolved → closed` needs a scheduled worker (7 days, per-workspace setting). The inactivity
  clock and auto-close are **sequential clocks, not the same clock** — inactivity outputs
  `resolved`; auto-close starts after that, whatever produced it. Inactivity clock ships week 1;
  auto-close ships week 3.
- Inactivity worker reads the open cycle:
  `WHERE resolved_at IS NULL AND inactivity_due_at < now()`. On `escalated`, set
  `inactivity_due_at = NULL` so it is skipped.
- Never store both intent and subintent — store the deepest reached, derive the parent.
- **No hard deletes anywhere; don't even write the route.** Enforce with `ON DELETE RESTRICT`.
- An unsent upload has no `attachment` row and *is* deleted — garbage collection, not a record.
  Once the row exists, the object is permanent.
- Version-stamp every form submission.
- **Signing a presigned GET must check the parent message's `visibility`.** An internal note's
  attachment is hidden by the serializer but its key is still signable. Walk
  `attachment.message_id → message.visibility` and refuse for a player token.
- Missing player state is a state, not an error — never reject the conversation.
- Treat `state.raw` as **PII by default**: uncontrolled client input.
- Deleting an article must not break the record of which article the bot offered. That record is
  a fact about what happened, not a FK to live content.

---

## Roles and permissions

Four roles: **Player**, **Agent**, **Team Lead**, **Admin**. Permissions attach to roles;
**a permission is never granted to an individual.**

| Capability | Agent | Team Lead | Admin |
|---|---|---|---|
| Reassign any conversation | · | ✓ | ✓ |
| Create a shared saved filter | · | ✓ | ✓ |
| View per-agent workload | · | ✓ | ✓ |
| Create / edit an article draft | ✓ | ✓ | ✓ |
| Import articles from markdown | · | ✓ | ✓ |
| Build or edit forms · map forms to subintents | · | ✓ | ✓ |
| See bot config · trigger manual sync | · | ✓ | ✓ |
| **Publish a form** | · | · | ✓ |
| Create / rename / archive / move / merge a subintent | · | · | ✓ |
| Edit bot prompt or rules · provision or disable bot | · | · | ✓ |
| Build or edit rules · declare searchable player fields | · | · | ✓ |
| Change a role · deactivate an agent · create a workspace | · | · | ✓ |
| **Delete a message, conversation or subintent** | · | · | · |

Reporting is visible to everyone; the **Agents tab is Team Lead and Admin only**.
**Building and publishing are separate acts by different people** — Team Leads build; only Admins
put things in front of players.

---

## Metrics

### Counting rules — getting these wrong makes the numbers quietly meaningless

- **Resolution counts events, not current status.** "Currently resolved" changes retroactively
  when someone replies — last month's figure would move today.
- **A reopen starts a new resolution cycle.** Each counts separately, in the window it happened.
- **Player-confirmed and timed-out are reported separately.** Folded together, silence counts as
  success and the rate rises fastest when support is at its worst.
- **Self-serve is per session, never per ticket.** Per ticket, the rate improves whenever
  conversations get harder to start: better number, worse product.
- **First reply means first *human* reply.** Bot, system and internal-note messages don't count.
- **Active agent-days means days actually worked**, not days employed.
- **Bot containment is reported, never a goal.** Optimising to keep players away from humans is
  how a support tool becomes something players work around.

### Metrics table

| Metric | Calculation |
|---|---|
| Self-serve rate | Sessions ending without a conversation created |
| Resolved by the bot | Conversations player confirmed the bot's answer for |
| Resolution rate | Conversations reaching `resolved`, **split player-confirmed vs timed out** |
| Time to first reply | Created → **first agent message** |
| Resolutions per agent per day | Resolution events ÷ **active agent-days** |
| Reopen rate | Conversations reopened at least once |
| Misclassification rate | Conversations where an agent changed the **subintent** |
| Asked for a person | Conversations where the player bypassed the bot |
| Bot fallbacks | Conversations created unclassified because bot was unavailable |

---

## Non-negotiables

- **Nothing may prevent a player reaching a human.** Asking for a person redirects immediately;
  bot error/timeout/disabled still creates the conversation unclassified and auto-assigned;
  refusing the form still hands off, marked form-skipped.
- **Failure is never silent.** Player sees no error; support is alerted. A silent fallback nobody
  notices is its own failure.
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
- **Changing taxonomy, forms, bot prompt or rules must never require a release.**
- **Bot prompt and rules are two stored fields, sent as one system prompt.** `bot_config.prompt` and
  `bot_config.rules` are separate nullable columns — separately editable, separately audited in
  `change_log` — joined only at send time by `buildSystemPrompt`. Never store them merged.

---

## Conventions

- Status values, delivery states and player-state keys: **lowercase snake_case**. Priority: `p1`–`p4`.
  Prompt placeholders: `{{double_brace}}`.
- "Category" = "intent"; "ticket" = "conversation"; "tag" = "label" (table is `label`); "agent" = CSR.
- The spec is in **British spelling** (categorise, labelling, behaviour). Match it in user-facing copy.
- Article import: **markdown only** — one file, `##` = title, `###` = intent, body = plain text.
  No CSV. Unrecognised intents file under `Other` as drafts.
