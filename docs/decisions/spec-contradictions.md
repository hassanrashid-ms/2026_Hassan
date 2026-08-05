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
