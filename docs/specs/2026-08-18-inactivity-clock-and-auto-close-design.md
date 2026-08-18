# Inactivity clock & auto-close — design spec

Status: **design only, not implemented.** Covers the two remaining status-transition gaps in
`docs/status-transitions.md`'s "Not implemented" table:

- `open` / `awaiting_player` → `resolved` via the inactivity clock (agent-initiated resolve is a
  separate, simpler slice — see that doc's row above this one; not covered here)
- `resolved` → `closed` via the auto-close window

Spec sources: `docs/project-overview.md` §"Conversation status machine" → "Inactivity clock — two
stages", and the `resolution_cycle` table named throughout that doc but not yet built
(`backend/src/shared/db/schema/conversations.ts:19-24`).

---

## 1. New table: `resolution_cycle`

One row per resolution attempt. Cycle 1 opens at conversation creation; every reopen opens the
next. `reopen_count = cycle_no - 1` — no separate counter column, per spec.

```
resolution_cycle
  id                    uuid PK default gen_random_uuid()
  workspace_id          uuid NOT NULL FK -> workspace(id) restrict
  conversation_id       uuid NOT NULL FK -> conversation(id) restrict
                        (composite FK on (workspace_id, conversation_id) -> conversation's
                         (workspace_id, id) unique index, same pattern as subintent/form_submission)
  cycle_no              integer NOT NULL           -- 1-based
  opened_at             timestamptz NOT NULL default now()
  first_human_reply_at  timestamptz NULL           -- column created now, population deferred
                                                    -- (metrics slice, out of scope here — see §7)
  inactivity_due_at     timestamptz NULL           -- NULL = clock not running (bot_active, escalated,
                                                    -- already resolved)
  resolved_at           timestamptz NULL
  resolution_kind       resolution_source NULL     -- reuse existing enum, extended (see §2)
  closed_at             timestamptz NULL
  support_owed_flag     boolean NOT NULL default false  -- see §4, stage 2

  unique index on conversation_id WHERE resolved_at IS NULL   -- "current open cycle", DB-enforced
  index on (workspace_id, inactivity_due_at) WHERE resolved_at IS NULL   -- stage 1+2 worker scan
  index on (workspace_id, resolved_at) WHERE closed_at IS NULL AND resolved_at IS NOT NULL
                                                                -- auto-close worker scan
```

RLS is automatic: `002_rls.sql`'s generic loop grants a tenant policy to any table with a
`workspace_id` column (`backend/src/shared/db/sql/002_rls.sql:81-116`) — no hand-written policy
needed, unlike `truncateAll`'s `SCOPED_TABLES` list in `backend/tests/helpers/db.ts:17-36`, which
**is** manually maintained and needs `'resolution_cycle'` added.

Not append-only — this is a mutable projection like `conversation` itself (ticks `inactivity_due_at`
repeatedly over its life), not a `REVOKE UPDATE, DELETE` table like `event`/`change_log`/`form_answer`.

**New workspace column**: `workspace.auto_close_days integer NOT NULL default 7`
(`backend/src/shared/db/schema/identity.ts:11-28`) — "per-workspace setting" per spec. `workspace`
is unscoped, no RLS involved.

## 2. Enum changes

- `confirm_phase` (`backend/src/shared/db/schema/enums.ts:35`): add `'inactivity_ask'`, alongside
  existing `none | bot_article | agent_ask | form`. Distinguishes a clock-triggered "did this help?"
  from an agent-triggered one, so the answer can be attributed correctly (see §4).
- `resolution_source` (`enums.ts:36`, currently `bot | agent`): add `'player_confirmed'` and
  `'timed_out'` — the two new terminal outcomes the doc requires metrics to keep separate ("Player-
  confirmed and timed-out are reported separately"). This same enum is reused as
  `resolution_cycle.resolution_kind`'s type, so a cycle's permanent record and the conversation's
  current (reopen-cleared) `resolutionSource` share one vocabulary rather than two enums that could
  drift.

No changes to `conversation_status` — `escalated` already exists and is wired (this session's
earlier escalate/unescalate work).

## 3. Why a column, not a computed check

Stage eligibility could be computed at worker-run time from `MAX(message.created_at)` instead of
maintaining `inactivity_due_at`. Rejected: `postMessage` (`backend/src/domain/conversations/postMessage.ts`)
is already the single choke point every message goes through — bot, agent, player, system — per its
own doc comment. Adding one centralized bump there is not scope creep, it's the direct extension of
"the one place all messages go through," and it produces an indexable column the worker can scan
with `WHERE inactivity_due_at < now()` instead of a `MAX()` subquery over `message` per candidate row.

## 4. Behavioral wiring (where each piece attaches)

**Cycle open** — insert `resolution_cycle` (cycle_no = 1, or max+1 on reopen, `inactivity_due_at`
NULL since a fresh cycle starts at `bot_active`, not `open`):
- `surface/services/messagesService.ts` — new-conversation branch (line ~92-98) and reopen branch
  (line ~126-148)
- `surface/services/newTicketService.ts` — `openNewTicket`'s creation of the replacement conversation
  (line ~84-88), and its old-conversation close (line ~70) should also stamp `resolution_cycle.closed_at`
  on the ticket it just force-closed, for consistency with the auto-close semantics

**Clock touch** (bump `inactivity_due_at = now() + 24h` on the cycle currently open) —
`postMessage.ts`, after insert: if `visibility === 'public'` and the conversation's status (read
in the same tx) is `open` or `awaiting_player`, touch the cycle. This single hook covers every
existing path for free: agent replies, player replies, bot handoff's system message, the inactivity
worker's own "did this help?" post, and a manual agent ask-resolved post — no other call site needs
to know about the clock.

**Clock pause/resume** — no message is involved, so these need direct calls:
- `escalationService.ts` `escalateConversation`: set `inactivity_due_at = NULL` on the open cycle
  (matches the documented trap: "On escalated: set `inactivity_due_at = NULL` so the worker skips
  it").
- `escalationService.ts` `unescalateConversation`: set `inactivity_due_at = now() + 24h` (resume,
  fresh window) — symmetric completion, not explicitly in the two-stage spec but required for the
  clock to ever run again on an unescalated conversation.

**Cycle close** (`resolved_at = now()`, `resolution_kind = <kind>`, `inactivity_due_at = NULL`):
- `domain/bot/applyBotTurn.ts` resolve case (line ~74-89) → kind `'bot'`
- `domain/conversations/resolutionAnswer.ts` `agent_ask` + `helped` branch (line ~73-100) → kind
  `'agent'`
- `resolutionAnswer.ts` **new** `inactivity_ask` + `helped` branch → kind `'player_confirmed'`
- `resolutionAnswer.ts` **new** `inactivity_ask` + declined branch → no close; instead reset
  `confirm_phase = 'none'`, post the decline message (which re-touches the clock to `+24h` for
  free via the `postMessage` hook in §"Clock touch" — this literally is spec step 3, "clock
  restarts")
- New inactivity worker stage 2 (below) → kind `'timed_out'`

## 5. `resolutionAnswer.ts` — new `inactivity_ask` branch

Mirrors the existing `agent_ask` branch (`domain/conversations/resolutionAnswer.ts:73-125`) almost
exactly; the only differences are the resolution kind on `helped === true` (`'player_confirmed'`
instead of `'agent'`) and the event payload's `source` (`'inactivity'` instead of `'agent'`). No
new endpoint — this reuses the existing `/resolution-answer` route and `applyResolutionAnswer`
entry point; the player's client already can't distinguish who asked, and doesn't need to.

## 6. Two new jobs

### `backend/src/shared/jobs/inactivityClock.ts` — `runInactivityClock({ now? })`

Same per-workspace loop shape as `sessionTimeout.ts` (`withoutWorkspace` over non-disabled
workspaces, then `withWorkspace(ws.id, tx => ...)` per tenant — never bypasses RLS).

**Stage 1 (ask)**: `resolution_cycle.resolved_at IS NULL AND inactivity_due_at <= now AND` joined
conversation `status IN ('open','awaiting_player') AND confirm_phase = 'none'`, `FOR UPDATE`. For
each: post the existing `RESOLUTION_CHECK_MESSAGE` (system, public) via `postMessage` — which
itself bumps `inactivity_due_at` to `now + 24h` for stage 2, satisfying "no other code needed to
set the second window." Set `confirm_phase = 'inactivity_ask'`. Append `resolution_check_requested`
(`actor_type: 'system'`, `payload: { source: 'inactivity' }`) — same event type the agent's manual
ask already uses, disambiguated by payload `source`, consistent with how `conversation_assigned`
already disambiguates `via`.

**Stage 2 (timeout)**: `resolved_at IS NULL AND inactivity_due_at <= now AND confirm_phase =
'inactivity_ask' AND status IN ('open','awaiting_player')`, `FOR UPDATE`. For each: check the
conversation's last message `author_type` — if it is not `'agent'` (support hadn't replied since
last player activity), set `resolution_cycle.support_owed_flag = true` per spec ("If support owed
the reply when the clock fired, flag the conversation"). Then: `status = 'resolved'`, `confirm_phase
= 'none'`, `resolutionSource = 'timed_out'`; close the cycle with kind `'timed_out'`. Append
`conversation_resolved` (`payload: { source: 'inactivity', confirmed_by: 'timeout' }`).

Both stages run every tick (same 5-minute cadence as the existing schedulers); stage 1 and stage 2
cannot double-process the same row in one tick because stage 1 immediately pushes `inactivity_due_at`
into the future via the `postMessage` touch.

### `backend/src/shared/jobs/autoClose.ts` — `runAutoClose({ now? })`

Per-workspace loop, reading `workspace.auto_close_days` for that tenant's window. Query:
`resolution_cycle.resolved_at IS NOT NULL AND closed_at IS NULL AND resolved_at <= now - auto_close_days`,
joined to `conversation` and filtered `status = 'resolved'` — this join guard is required, not
decorative: a cycle whose conversation was later reopened keeps its old `resolved_at`/`closed_at =
NULL` forever (correct — "this resolution never got auto-closed because it reopened first"), and
without the `status = 'resolved'` filter a stale, superseded cycle could be wrongly auto-closed
after the conversation moved on. For each match: `conversation.status = 'closed'` (guarded in the
`UPDATE`'s `WHERE`, same claim-conversation race-safety pattern as
`agent/services/conversationsService.ts:57-83`), `resolution_cycle.closed_at = now()`. Append
`conversation_closed` (`actor_type: 'system'`, `payload: { reason: 'auto_close', days:
<auto_close_days> }`).

### Registration

Both added to `backend/src/shared/jobs/queue.ts` (`registerJobs()`): two more
`queue.upsertJobScheduler(...)` calls (same `*/5 * * * *` cadence, stable job names
`inactivity-clock` / `auto-close`), dispatched in the shared `Worker`'s handler alongside
`SESSION_TIMEOUT_JOB`/`FORM_TIMEOUT_JOB`.

## 7. Explicitly out of scope for this slice

- **`first_human_reply_at` population.** Column ships (named in the spec table), left unpopulated —
  it belongs to a metrics slice ("Time to first reply"), not to either clock. Consistent with this
  codebase's existing practice of shipping a documented column ahead of the logic that fills it
  (see the "MINIMAL on purpose" comment already on `conversation`,
  `backend/src/shared/db/schema/conversations.ts:19-24`).
- **Reporting/UI surfacing of `support_owed_flag`.** Column and worker logic ship; a queue filter or
  report column reading it is separate follow-up work.
- **Frontend label changes** for `player_confirmed` / `timed_out` in `resolverLabel()`
  (`frontend/.../ThreadPanel.tsx`) — currently falls through to generic "Closed". A two-line addition
  once this ships, not required for the backend behavior to be correct.
- **Agent-initiated resolve** (`open`/`awaiting_player` → `resolved` via an explicit agent action,
  not the clock) — separate row in `docs/status-transitions.md`'s "Not implemented" table, not
  covered by this spec.

## 8. Test plan (once implementation starts)

- `backend/tests/jobs.inactivityClock.test.ts`: stage 1 asks and resets the due date; stage 2
  resolves as `timed_out` with `support_owed_flag` set only when the last message was the player's;
  skips `escalated`/`bot_active`/already-`resolved`; skips before the due date; multi-workspace
  isolation (mirror `jobs.sessionTimeout.test.ts` structure).
- `backend/tests/jobs.autoClose.test.ts`: closes past the per-workspace window; skips a reopened
  (superseded) cycle; skips within the window; respects a non-default `auto_close_days`.
- Extend `backend/tests/domain.resolutionAnswer.test.ts` with the `inactivity_ask` yes/no branches.
- Extend `backend/tests/agent.escalate.test.ts` to assert `inactivity_due_at` is nulled on escalate
  and restored on unescalate.
- New/extended coverage asserting `resolution_cycle` row creation on ticket creation and on reopen
  (cycle_no increments), and cycle close on each of the three existing resolve paths plus the new
  timed-out path.
