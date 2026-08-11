# Conversation status transitions — implementation status

Tracks each transition in the status machine (`docs/project-overview.md` §"Conversation status
machine") against what the backend actually enforces today. The status machine there is the
**spec**; this file is the **build state**.

Last verified: 2026-08-11, by grepping every write to `conversation.status` in `backend/src`.
There are exactly four such call sites — three in `surface/services/messagesService.ts`, one in
`agent/services/messagesService.ts`. If you add a fifth, update this table.

## Rule of the machine

Every status change goes through one transaction that writes both `conversation` and `event`
(`shared/events/appendEvent.ts`). `event.type` is `text`, not an enum, so a new transition needs
no migration — just a new type string. Never `update conversation set status` without an event.

---

## Implemented

| From → To | Trigger | Where | Event appended |
|---|---|---|---|
| `open` → `awaiting_player` | Agent sends a **public** reply while status is `open`. Internal notes never trigger it | `agent/services/messagesService.ts:42-52` | `conversation_awaiting_player` |
| `awaiting_player` → `open` | Player replies. Assignment is **preserved** — the agent who asked stays owner | `surface/services/messagesService.ts:66-81` | `conversation_player_replied` |
| `resolved` / `closed` → `open` | Player replies. Also clears `assigned_agent_id`, so it lands back in Unassigned. No time limit | `surface/services/messagesService.ts:55-65` | `conversation_reopened` |

All three emit `emitInboxChanged(...)` after commit so the agent console inbox refetches.

Tests: `backend/tests/agent.messages.test.ts` (forward flip, internal-note no-op),
`backend/tests/surface.messages.test.ts` (reply flip + assignment preserved, reopen, and a
no-op case from `escalated`).

---

## Not implemented

| From → To | Trigger per spec | What's missing | Blocked on |
|---|---|---|---|
| — → `new` → `bot_active` | Always. The bot is the entry point; no menu path | The `new` status is never written by anything, and the first player message inserts the conversation **directly at `open`** (`surface/services/messagesService.ts:48`) — so `bot_active` is skipped on the live chat path even though it is the column default (`shared/db/schema/conversations.ts:33`) | Bot runtime |
| `bot_active` → `resolved` | Player confirms the bot's answer solved it | No bot resolve path, no confirmation turn | Bot runtime |
| `bot_active` → `open` | Form submitted or skipped; player asks for a person; bot errors / times out / is disabled (unclassified) | No handoff path. Note `claimConversation` (`agent/services/conversationsService.ts:45-54`) sets `assigned_agent_id` only and deliberately leaves status alone | Bot runtime + forms (`docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md`) |
| `open` ↔ `escalated` | Handed to engineering and returned | No route, no service, no event. Enum value exists (`shared/db/schema/enums.ts:12`), nothing writes it. Reminder: `escalated` is never surfaced to the player, and the agent stays owner | Escalation slice |
| `open` / `awaiting_player` → `resolved` | Agent resolves, **or** the inactivity clock times out | No agent resolve action, and no inactivity clock at all: `inactivity_due_at` is not a column, and `backend/src/jobs/` does not exist yet despite being in the CLAUDE.md folder map. Both clock stages (24 h → bot asks; +24 h → timed out) are unbuilt, as is the "support owed the reply" failure flag | Resolution slice + BullMQ worker |
| `resolved` → `closed` | Auto-close window elapses (7 days, per-workspace setting) | No worker, and no per-workspace setting column. Nothing ever writes `closed` — it is only ever read, as a reopen source | Same worker as above |

Also deferred with the resolution work: the `resolution_cycle` table and true resolution-cycle
metrics. Today's `resolved` would be a bare `conversation.status` write
(`docs/specs/2026-08-06-internal-notes-and-status-design.md`, "Out (deferred)").

---

## Invariants to keep while filling the gaps

- **`abandoned` does not exist.** Don't reintroduce the name.
- **No status is terminal for the player.** A message of any age reopens the existing
  conversation; `closed` is terminal for reporting only.
- **A reply is not a reopen.** Only the `resolved`/`closed` path clears `assigned_agent_id`.
  Unassigning on `awaiting_player → open` would dump an actively-handled conversation back into
  Unassigned.
- **Unlisted transitions are a no-op, not an error.** Sending a message from a status with no
  defined transition (e.g. `escalated`) leaves the status untouched and still posts the message —
  per `docs/specs/2026-08-06-internal-notes-and-status-design.md`, server-side enforcement of the
  full transition table is out of scope. Missing player state is a state, not an error; the same
  spirit applies here.
- **Status changes are side effects of sending a message, never a separate agent action.** There
  is intentionally no "Mark Awaiting Player" button.
- Every new transition needs a row in this table and a test asserting both the status write and
  the event append.
