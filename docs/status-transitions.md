# Conversation status transitions — implementation status

Tracks each transition in the status machine (`docs/project-overview.md` §"Conversation status
machine") against what the backend actually enforces today. The status machine there is the
**spec**; this file is the **build state**.

Last verified: 2026-08-13, by grepping every write to `conversation.status` in `backend/src`.
There are exactly five such call sites — two in `surface/services/messagesService.ts`, one in
`agent/services/messagesService.ts`, two in `domain/bot/applyBotTurn.ts` (handoff and
unavailable). Creation is a sixth entry point: it inserts at the `bot_active` column default
rather than updating. If you add another, update this table.

**2026-09-01:** a seventh call site was added and missed at the time —
`agent/services/resolutionService.ts`'s `forceResolve` (`any non-resolved/closed status →
resolved`). Caught late because this table wasn't updated when force-resolve shipped; see the
Implemented table below and `docs/specs/2026-08-31-admin-force-resolve-design.md`.

## Rule of the machine

Every status change goes through one transaction that writes both `conversation` and `event`
(`shared/events/appendEvent.ts`). `event.type` is `text`, not an enum, so a new transition needs
no migration — just a new type string. Never `update conversation set status` without an event.

The same rule now covers **entering** the machine and **assignment**, not just status flips:
creation writes `conversation_opened` + `conversation_assigned_bot`, and claiming writes
`conversation_assigned`. A state that is only ever the column default is still a state, and an
unrecorded one is invisible to every metric.

Player-caused events carry `event.session_id` when a verified session accompanied the request;
everything else carries `null`. See
`docs/specs/2026-08-13-conversation-lifecycle-events-and-session-attribution-design.md` for the
rule and why the nulls are deliberate.

---

## Implemented

| From → To                                          | Trigger                                                                                                                                                                                               | Where                                                                                                                                                              | Event appended                                                                                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| — → `bot_active`                                   | First player message; the conversation is inserted at the column default                                                                                                                              | `surface/services/messagesService.ts:70-102`                                                                                                                       | `conversation_opened` (`{ entry_point }`) **+** `conversation_assigned_bot`                                                                                 |
| `open` → `awaiting_player`                         | Agent sends a **public** reply while status is `open`. Internal notes never trigger it                                                                                                                | `agent/services/messagesService.ts:42-52`                                                                                                                          | `conversation_awaiting_player`                                                                                                                              |
| `awaiting_player` → `open`                         | Player replies. Assignment is **preserved** — the agent who asked stays owner                                                                                                                         | `surface/services/messagesService.ts:118-132`                                                                                                                      | `conversation_player_replied`                                                                                                                               |
| `resolved` / `closed` → `open`                     | Player replies. Also clears `assigned_agent_id`, so it lands back in Unassigned. No time limit                                                                                                        | `surface/services/messagesService.ts:100-114`                                                                                                                      | `conversation_reopened`                                                                                                                                     |
| `bot_active` → `open`                              | Bot hands off, or the bot is unavailable. Also sets `assigned_agent_id` from `assignOnHandoff`                                                                                                        | `domain/bot/applyBotTurn.ts:56-71`, `96-111`                                                                                                                       | `bot_handoff` / `bot_unavailable`                                                                                                                           |
| `open` / `awaiting_player` → `resolved`            | The inactivity clock times out after a second silent window, **or** the player answers Yes to the clock's own ask                                                                                     | `shared/jobs/inactivityClock.ts:187` (`resolution_source = 'timed_out'`), `domain/conversations/resolutionAnswer.ts:81` (`resolution_source = 'player_confirmed'`) | `conversation_resolved`                                                                                                                                     |
| any status except `resolved`/`closed` → `resolved` | Admin uses force-resolve to bypass the ask/confirm cycle entirely — no player consent, no message posted. Also sets `resolution_source = 'admin_forced'` and `assigned_agent_id` to the forcing admin | `agent/services/resolutionService.ts:103-138` (`forceResolve`)                                                                                                     | `conversation_resolved_forced` (`{ admin_agent_id }`), deliberately not `conversation_resolved` — see `docs/specs/2026-08-31-admin-force-resolve-design.md` |
| `resolved` → `closed`                              | Auto-close window elapses (`workspace.auto_close_days`)                                                                                                                                               | `shared/jobs/autoClose.ts`                                                                                                                                         | `conversation_closed` (`payload.reason = 'auto_close'`)                                                                                                     |

The three status flips emit `emitInboxChanged(...)` after commit so the agent console inbox
refetches; so does creation.

Assignment changes without a status change, and is recorded the same way:

| Change                           | Trigger                                                                                                            | Where                                          | Event appended                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `assigned_agent_id` NULL → agent | Agent claims from the Unassigned queue. Status deliberately untouched                                              | `agent/services/conversationsService.ts:45-70` | `conversation_assigned` (`{ agent_id, via: 'claim' }`)                             |
| `assigned_agent_id` NULL → agent | Bot hands off; `assignOnHandoff` picks least-loaded, and `null` (no active agent) is a valid outcome, not an error | `domain/bot/applyBotTurn.ts`                   | `bot_handoff` (`{ reason, assigned_agent_id }`) / `bot_unavailable` (`{ reason }`) |

Tests: `backend/tests/agent.messages.test.ts` (forward flip, internal-note no-op),
`backend/tests/surface.messages.test.ts` (reply flip + assignment preserved, reopen, a no-op case
from `escalated`, and the lifecycle-event / session-stamping suite),
`backend/tests/agent.conversations.test.ts` (claim event, losing racer writes nothing),
`backend/tests/bot.turnSeam.test.ts` (`bot_handoff.assigned_agent_id`, including the null case).

---

## Not implemented

| From → To                               | Trigger per spec                                                                                                        | What's missing                                                                                                                                                                                                               | Blocked on                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| — → `new` → `bot_active`                | Always. The bot is the entry point; no menu path                                                                        | Only `new` is still missing — nothing writes it. Creation at `bot_active` **is** implemented and now recorded (`conversation_opened` + `conversation_assigned_bot`); see the Implemented table                               | —                                                                         |
| `bot_active` → `resolved`               | Player confirms the bot's answer solved it                                                                              | No bot resolve path, no confirmation turn                                                                                                                                                                                    | Bot runtime                                                               |
| `bot_active` → `open`                   | **Form submitted or skipped** only — the handoff / error / disabled triggers are implemented, see the Implemented table | No form runtime. Note `claimConversation` (`agent/services/conversationsService.ts:45-70`) still sets `assigned_agent_id` only and deliberately leaves status alone — it appends `conversation_assigned`, not a status event | Forms (`docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md`) |
| `open` ↔ `escalated`                    | Handed to engineering and returned                                                                                      | No route, no service, no event. Enum value exists (`shared/db/schema/enums.ts:12`), nothing writes it. Reminder: `escalated` is never surfaced to the player, and the agent stays owner                                      | Escalation slice                                                          |
| `open` / `awaiting_player` → `resolved` | Agent resolves directly (not admin force-resolve, which **is** implemented — see the Implemented table)                 | No agent-initiated resolve action outside `askResolved`'s ask/confirm cycle — an agent still cannot mark resolved without the player's Yes                                                                                   | Resolution slice                                                          |

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
- **An event is not optional because the state was a default.** `bot_active` was invisible for two
  slices purely because creation wrote no event. If a conversation enters, leaves, or changes
  hands, something appends.
- **Never let attribution fail a player's write.** A client-supplied `session_id` is verified and
  degraded to `null` on any miss; it is never allowed to roll back the transaction that carries the
  player's message. Same spirit as "missing player state is a state, not an error."
