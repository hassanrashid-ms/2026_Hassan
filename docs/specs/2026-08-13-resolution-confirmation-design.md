# Resolution confirmation — bot and agent-initiated — design

**Date:** 2026-08-13
**Status:** Implemented (2026-08-13)
**Builds on:** `2026-08-12-bot-tool-calling-decider-design.md` (spec 4)
**Scope:** Implements spec 4's `confirm_resolution` flow (not yet built), and adds a parallel
agent-triggered path that shares the same player-facing mechanism. One renamed column, one new
endpoint, two new event types.

**Implementation note:** `bot_phase` had in fact shipped (migration 0001), so the rename cost a
migration (0002) and a value rename `article_confirm` → `bot_article`. The player's answer arrives
through `POST /surface/resolution-answer`, not through the message endpoint; a typed answer to an
`agent_ask` is not interpreted (buttons only). `confirm_phase` is exposed on `GET /surface/messages`
and the agent inbox summary, with a `conversation:phase_changed` socket event. See
`docs/plans/2026-08-13-resolution-confirmation-implementation.md` § Contradictions resolved.

---

## What this slice is

Spec 4 designed a bot flow where offering an article can lead to asking the player "did this solve
it?", gated so the bot can never decide on its own that a conversation is done. That flow was never
implemented — `bot_phase` doesn't exist as a column yet.

This slice implements that flow, and generalizes it: an agent can also ask "is this resolved?" at
any point while they own the conversation, without needing to offer an article first. Both paths
post the same fixed question, render the same player-facing Yes/No banner, and are answered through
one shared handler.

**Nothing about spec 4's `resolve`/`handoff` outcomes changes.** This only widens *what can put a
conversation into "waiting on a yes/no"* — an article offer (bot) or an explicit ask (agent) — while
keeping the safety property spec 4 established: the bot still never decides it is done on its own,
and here, neither does the general mechanism decide anything — a human (player) always answers.

### In scope

- `conversation.confirm_phase` column (renamed/repurposed from spec 4's unshipped `bot_phase`)
- `POST /agent/conversations/:id/ask-resolved` — new agent-facing endpoint
- Shared player-answer handling for both `bot_article` and `agent_ask` sources
- Player webview banner + agent console "Ask if resolved" button
- Two new event types: `resolution_check_requested`, `resolution_check_declined`

### Out of scope

- **The inactivity clock.** The 24h "is your issue resolved?" timeout message and `resolution_cycle`
  metrics remain a separate worker slice, per spec 4.
- **Bot asking standalone/anytime.** The bot's ask stays gated to immediately after an article
  offer, unchanged from spec 4. A general-purpose "bot decides to check in" tool was explicitly
  considered and rejected — it would reopen the exact risk spec 4 §3 designed `confirm_resolution`'s
  scoping to prevent (a model reading an ambiguous message as confirmation outside of a real yes/no
  question).
- **Agent resolving without asking.** There is no direct "mark resolved" action for agents. Every
  agent-side resolution goes through the same player confirmation as the bot's.
- **Agent-customized question copy.** The ask is always the fixed string used by the bot's flow.

---

## Schema

```
conversation.confirm_phase   text not null default 'none'
  CHECK (confirm_phase IN ('none', 'bot_article', 'agent_ask'))
```

Replaces spec 4's planned `bot_phase` column — never shipped, so this is a rename with no migration
cost. The forms slice still adds a `'form'` value later, unchanged from spec 4's plan.

- `bot_article` — set by the bot's `offer_article` tool call (spec 4 §3), unchanged. Continues to
  gate whether `confirm_resolution` is offered to the model at all.
- `agent_ask` — set by the new agent endpoint below. No article required.
- The player-facing banner renders whenever `confirm_phase != 'none'`, regardless of value. The
  value is read only to decide event `source` and post-answer behavior.

---

## Agent-triggered ask

`POST /agent/conversations/:id/ask-resolved`

**Guard:**
- `conversation.status` must be `open` or `awaiting_player` (the agent must own the conversation).
- `conversation.confirm_phase` must currently be `'none'`. Rejects a double-ask, and rejects a
  replayed request — the same job spec 4's `bot_phase` guard does for the bot.

**Effect**, one transaction, per this repo's rule that every state change writes `conversation` and
`event` together:
- Post a `system`, public message with the fixed copy: *"Did this solve it?"* — the same string the
  bot's flow posts.
- Set `confirm_phase = 'agent_ask'`.
- Append event `resolution_check_requested`, `{ source: 'agent', actorId: <agentId> }`.
- Emit to both socket rooms (`conv:{id}:agents`, `conv:{id}:player`), as with any other message.

---

## Player answers Yes / No

One shared handler for both sources, reachable by tapping the banner or by an equivalent typed
message, converging on identical rows and events — the same buttons-are-accelerators property spec 4
§2 established for the bot's flow.

**Guard:** `confirm_phase != 'none'`. An answer arriving while `confirm_phase = 'none'` is rejected
and writes nothing.

**Yes:**

| `confirm_phase` | Outcome |
|---|---|
| `bot_article` | Spec 4's `resolve` outcome, unchanged: status → `resolved`, `conversation_resolved` event with `{ source: 'bot', confirmed_by: 'player' }`. No message posted. |
| `agent_ask` | Same status transition: status → `resolved`, `conversation_resolved` event with `{ source: 'agent', confirmed_by: 'player' }`. No message posted — the status change is the confirmation, same reasoning as spec 4's. |

Both branches set `confirm_phase → 'none'`.

**No:**

| `confirm_phase` | Outcome |
|---|---|
| `bot_article` | Spec 4's existing `handoff('article_rejected')`, unchanged: status → `open`, `assignOnHandoff`, handoff message posted, `bot_article_rejected` + `bot_handoff` events. |
| `agent_ask` | `confirm_phase → 'none'`. Status is untouched (stays `open`/`awaiting_player`) — a human already owns the conversation, so there is nothing to hand off. Event `resolution_check_declined`, `{ source: 'agent' }`. No message posted; the agent sees the decline live via socket update. |

---

## Frontend

**Player webview** (`surfaces/webview/pages/SupportChat.tsx`): render the "Did this solve it? Yes /
No" banner whenever `confirm_phase != 'none'`. Both buttons call the same endpoint used for a typed
confirmation. No branching on source in the frontend — the backend decides what the tap means.

**Agent console** (`surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx`): add an "Ask if
resolved" button.
- Enabled when status is `open` or `awaiting_player` and `confirm_phase === 'none'`.
- Disabled, with a "Waiting on player" tooltip, while `confirm_phase === 'agent_ask'`.
- Calls `POST /agent/conversations/:id/ask-resolved`.

No new UI is needed for the response — the existing status badge flipping to `resolved` (or staying
`open` on a decline) is the visible confirmation.

---

## Events

New types, `actorType: 'agent'` / `'player'` as noted:

| Type | Payload | Actor |
|---|---|---|
| `resolution_check_requested` | `{ source: 'agent' }` | agent |
| `resolution_check_declined` | `{ source: 'agent' }` | player |

The bot's ask/accept/reject path reuses spec 4's existing `bot_article_offered`,
`conversation_resolved`, `bot_article_rejected` events unchanged — no new event types needed there.

---

## Interaction with reopen and assignment (spec 4 §10)

No changes needed. Spec 4's assignment table already anticipates an agent-resolved case:

| Previous state | Assignment on reopen |
|---|---|
| Bot-resolved — never assigned to anyone | `assignOnHandoff` |
| Agent-resolved, previous owner still active | Keep them |
| Agent-resolved, previous owner deactivated | `assignOnHandoff` |

`conversation_resolved.source: 'agent'` (written by this slice) is exactly the signal that table's
middle row keys off. Reopening after an agent-triggered resolution just works once this slice is
implemented — spec 4 wrote the reopen logic before anything could produce that source.

---

## Verification

- `ask-resolved` rejects when status is not `open`/`awaiting_player`.
- `ask-resolved` rejects when `confirm_phase` is not `'none'` (double-ask).
- Yes on `agent_ask` resolves with `source: 'agent'`; Yes on `bot_article` resolves with
  `source: 'bot'` — asserted as producing different event payloads from the same handler.
- No on `agent_ask` leaves status untouched and clears `confirm_phase`; no message is posted.
- No on `bot_article` still produces spec 4's unchanged `handoff('article_rejected')` behavior —
  regression check that this slice didn't alter the bot path.
- Tapping the banner button and posting the typed equivalent produce identical rows and events, for
  both sources — the same assertion spec 4 makes for the bot's buttons-vs-typing convergence.
- A reopen of an agent-resolved conversation with an active previous owner keeps that owner,
  unchanged from spec 4 §10 — exercised for the first time by this slice.
