# Spec Contradictions

The spec disagrees with itself in a few places. This document records each contradiction and
the decision taken. Don't silently pick a side in code — any new contradiction should be added
here with a decision.

---

## Contradictions with a decision

### 1. Who creates an intent?

**Conflict:** The p44 Taxonomy block grants Admin "Create or rename a subintent" and "Archive,
move or merge a subintent", plus "View intents and subintents" — but there is no intent row
at all. The spec discusses intents throughout but never says who may create one.

**Decision:** Read as an omission, not a prohibition. "Changing taxonomy must never require a
release" covers intents, so they are Admin-editable at the same level as subintents.
See `docs/specs/2026-08-04-database-and-schema-design.md`.

---

### 2. The auto-close window

**Conflict:** `resolved → closed` happens "some days after resolved." No number given.

**Decision:** **7 days**, per-workspace setting in the admin console.

---

### 3. What is a "queue"?

**Conflict:** The spec uses "queue" loosely (e.g. "senior queue", p29). No `queue` entity is
defined in the data model.

**Decision:** There is no queue entity. p2 glossary: "the list of tickets waiting to be worked."
Unassigned is `assigned_agent_id IS NULL`. A named queue is a label + a shared saved filter —
support can invent one with no release.

---

### 4. The inactivity clock on `escalated`

**Conflict:** The spec never states what the inactivity clock does to `escalated` conversations.

**Decision:** Set `inactivity_due_at = NULL` while escalated so the worker skips it. Timing
out a ticket engineering owns would be wrong.

---

### 5. Cross-intent merge

**Conflict:** The spec describes merging subintents but does not address whether two subintents
under different intents can be merged.

**Decision:** Cross-intent merge is allowed. Recorded with both `from_intent_id` and
`to_intent_id` in `taxonomy_change`.

---

### 6. Reopened cycle and player-state snapshot

**Conflict:** The spec does not address whether a reopened conversation keeps the original
player-state snapshot or captures a new one.

**Decision:** A reopened cycle keeps the original snapshot. The Game View must display
`captured_at` prominently — an agent must not read a six-month-old client version as current.

---

### 14. Form fields: a table, or jsonb on the version?

**Conflict:** The schema spec models fields as `form_field` rows under a `form_version`, with
`form_answer.form_field_id` as the FK, and explicitly rejects collapsing them
("`form_field` → `jsonb` on `form_version`: defensible; **not taken**. Kept as a table for the FK
from `form_answer`"). That reasoning was written when forms were conversational and the bot
resolved one field at a time.

**Decision:** **Fields are a validated jsonb array on `form_version`; answers are keyed by a text
`field_key`.** The 2026-08-10 supersession makes forms a modal, so the whole field list is read in
one shot and there is no per-field join to save. A stable string key also survives field reordering
and relabelling without touching answer rows. The integrity the FK gave up — an answer naming a
field that does not exist — moves to one guard in the submission service, and each answer
snapshots its `field_type` so a stored value is interpretable without resolving the version.
See `docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md`.

---

### 15. `bot_config` shape

**Conflict:** The schema spec gives `bot_config` a surrogate `id` with `workspace_id` UK, plus
`last_synced_at`, `last_sync_outcome` and `last_sync_error`.

**Decision:** **`workspace_id` is the primary key** — one row per workspace becomes structural
rather than a unique key over a surrogate. The table still carries a `workspace_id` column, so
`002_rls.sql`'s structural policy loop picks it up unchanged.

The three `last_sync_*` columns are **dropped**. They are operational status, not audit — one row's
worth of "did the last push succeed", overwritten each time, with no actor and no before/after — and
nothing pushes bot config anywhere: the orchestrator reads `bot_config` from Postgres per message,
and the only external sync in the system is article publishing to Weaviate. Re-add them in the slice
that introduces an actual push, with a consumer.

**Audit is `change_log`**, which the spec already designs and which lands in the same slice.
`bot_config` edits write one `change_log` row per changed field, in the same transaction as the
upsert. Reusing `event` for this was rejected: `event.actor_id` deliberately has no FK, and `event`
is the conversation/session reporting spine.
See `docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md`.

---

### 16. Agent assignment on handoff: round-robin, or least-loaded?

**Conflict:** §7 of the spec specifies round-robin agent assignment on handoff.

**Decision:** **Deterministic least-loaded assignment.** The active workspace member with the
fewest conversations in a live status (`open`, `awaiting_player`, `escalated`) is assigned, ties
broken by `agent.id` ascending. This is testable without controlling a rotation cursor's starting
position, and it balances actual load rather than arrival order. "Active" means
`workspace_member.deactivated_at IS NULL AND agent.status = 'active'`; role is never consulted.
Implemented in `backend/src/domain/bot/assignOnHandoff.ts`, plan
`docs/plans/2026-08-12-bot-turn-domain-core.md` Task 5.
See `docs/specs/2026-08-11-bot-turn-seam-and-handoff-design.md` §7.

---

### 17. Reopen's "previous resolution source" (spec §10)

**Conflict:** Spec §10 says reopen should keep an agent-resolved conversation's previous owner but
reassign a bot-resolved one — without saying how to tell the two apart, since no code path writes
an agent-resolved or `closed` status yet.

**Decision:** `conversation` gains a `resolution_source` column (`bot | agent`, nullable), written
whenever a conversation becomes `resolved`/`closed`. This slice writes it only from the bot's
`resolve` outcome (`'bot'`); a future agent-resolve action writes `'agent'`. Reopen reads it back
to decide assignment, then clears it. Implemented in `backend/src/domain/bot/applyBotTurn.ts` and
`backend/src/surface/services/messagesService.ts`, plan
`docs/plans/2026-08-13-bot-tool-calling-decider-implementation.md`.
See `docs/specs/2026-08-12-bot-tool-calling-decider-design.md` §10.

---

## Contradictions still open (no decision yet)

These have not been resolved. Do not silently pick a side — add a decision here when one is made.

### 7. Player state: tab or panel?

**Conflict:** The console wireframes show player state as a tab
(`Conversation | Custom fields | Player state | Other issues`). The prose insists it is *not* a
tab: "putting it one click away reintroduces the problem in miniature." Two incompatible layouts
for the same screen.

---

### 8. Who publishes articles?

**Conflict:** Fixed rules and an editor note say only an Admin publishes. The permission matrix
gives Team Lead ✓ on publish/unpublish. The matrix is more permissive than the stated rule.

---

### 9. `abandoned` in reporting

**Conflict:** `abandoned` is retired as a status. It still appears in the Reporting wireframe
as a column with an 11% figure. Presumably means "resolved, timed out" under the old name.

---

### 10. Reporting tabs: Bot vs. Flows

**Conflict:** Prose says the Bot tab replaced Flows. Every wireframe tab strip still renders `Flows`.

---

### 11. Article states: two or three?

**Conflict:** Three states (Draft / Published / Archived) appear in the table and the bot's
knowledge counts. The lifecycle diagram says "two states" and omits Archived.

**Best read:** Three is safer — Archived is necessary to retire content without deleting it.
Not yet formally decided.

---

### 12. "Nothing is deleted" vs. article delete

**Conflict:** The fixed rule enumerates messages, conversations and subintents only. The
permission matrix explicitly allows Admin to delete an article.

---

### 13. Immediate handoff vs. three-reply rule

**Conflict:** The hard constraint says a player asking for a person must redirect "not after
three turns, not after a failed answer." Yet a switchable "hand off after three unhelpful
replies" rule ships on by default.

**Likely compatible** — the locked rule covers *voluntarily asking* for a person; the
switchable rule is about bot failure to help. But the wording collides.

---

### 14. Article `summary` field — rejected, not missing

**Conflict:** `project-overview.md` gives an article five fields and labels `Summary` as
*"search + bot"*, and the editor wireframe renders it. The `article` table has `title`, `body`,
`keywords`, `intent_id`, `state` — no `summary`, and no slice plans one.

**Decided 2026-08-12 — the field is not wanted.** A summary is a second copy of the answer that
has to be kept in step with the first, and a stale summary is worse than no summary because it is
the copy the bot reads. `keywords` covers the machine-reader case it was meant to serve: it is
indexed in Weaviate and boosted `^2` in the query, so the retrieval benefit arrives through
ranking rather than through prompt tokens.

`{{articles}}` therefore renders titles grouped by intent, not *"titles and summaries"*. See
`2026-08-11-bot-retrieval-and-prompt-assembly-design.md` §10.

**Do not add it back on the strength of the wireframe.**

---

### 15. Session as a *gate* vs. session as *attribution*

**Conflict:** The chat module treated `session_id` on `GET /surface/messages` as an authorisation
gate — no session row, no thread — while the schema treats `event.session_id` as attribution data
(nullable, plus a `(session_id, type)` index). Those are two different jobs for one column, and
the gate reading won.

**Decided 2026-08-13** — they are separated for good:

- **A session is never an authorisation gate.** Reads are scoped by the token's `player_id` under
  RLS. A session id that is unknown, foreign, or simply not uploaded yet is accepted and ignored,
  never a 404. The Outbox makes "not uploaded yet" the *normal* early state, so gating on it fails
  exactly the players who most need the thread.
- **A session is attribution, and attribution never blocks a write.** A client-supplied
  `session_id` is verified with a scoped `(id, player_id)` lookup — mandatory, because FK checks
  bypass RLS — and degrades to `null` on any miss. `event.session_id` is `ON DELETE RESTRICT`, so
  stamping an unverified id would roll back the transaction carrying the player's message. Nothing
  may prevent a player reaching a human, so the stamp is what gives way.
- **`null` is an answer, not a gap.** Background-worker and agent-console events carry no session
  on purpose. Inventing one puts a wrong row into the `(session_id, type)` index; consistent nulls
  beat inconsistent stamps.

See `docs/specs/2026-08-13-conversation-lifecycle-events-and-session-attribution-design.md`.
