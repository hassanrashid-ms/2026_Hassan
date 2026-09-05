# Ticket assignment sweep + manual unassign

Status: draft
Date: 2026-09-01

## Problem

Conversations that go unassigned (bot handoff found no eligible agent, or a ticket
was manually unassigned) sit in the queue with no automatic path back to an agent.
Today the only way a conversation gets an `assigned_agent_id` is `claimConversation`,
`takeOverConversation`, `reassignConversation` (`backend/src/agent/services/conversationsService.ts`),
or `assignOnHandoff` (`backend/src/domain/bot/assignOnHandoff.ts`) at the moment of
bot handoff. None of these sweep the backlog. There is also no way to unassign a
ticket at all — `assigned_agent_id` can only move to a specific agent, never back to
`NULL`.

Concretely: tickets left unassigned overnight (no agent was online, or the workspace
was at capacity) never get picked up the next morning unless someone manually
reassigns each one via `PATCH /conversations/:id/assign`, which requires knowing the
ticket exists and picking an agent by hand.

## Goals

- When an agent comes online, the unassigned queue should drain toward them and
  other already-online agents automatically, ordered by priority then age.
- Assignment must not dogpile the first agent to log in — load should interleave
  across whoever is online and under cap, not fill one agent to their cap before
  anyone else gets a ticket.
- A Team Lead/Admin should be able to manually trigger the same sweep on demand
  from the Tickets tab.
- An agent should be able to release one of their own tickets back to the
  unassigned queue.

## Non-goals

- Rebalancing tickets that are already assigned to a _busy_ agent (only tickets
  with `assigned_agent_id IS NULL` are touched).
- Auto-unassigning a ticket when its owning agent goes offline. Only a manual
  release action is in scope; presence-driven auto-unassign is a possible future
  extension, not part of this design.
- Team-lead/admin unassigning someone else's ticket. Only the owning agent may
  unassign their own ticket via this feature. Team leads keep using the existing
  `PATCH /conversations/:id/assign` to reassign.
- Cross-workspace sweeping in one pass — a sweep always operates within a single
  workspace, consistent with RLS scoping everywhere else in this codebase.

## Algorithm

### Single-ticket assignment: `assignNextTicket(tx, workspaceId)`

Returns the conversation id assigned, or `null` if nothing was assigned.

1. Select the top unassigned conversation in the workspace:
   `status IN ('open', 'awaiting_player', 'escalated') AND assigned_agent_id IS NULL`,
   ordered by `priority ASC, created_at ASC, id ASC` (same ordering already used
   for inbox listing in `conversationsService.ts`, `priority` sorts lexically
   `p1 < p2 < p3 < p4` which matches "most urgent first").
   If none, return `null`.
2. Pick the least-loaded eligible online agent, reusing `assignOnHandoff`'s
   candidate logic verbatim (active workspace membership, agent
   `status = 'active'`, live-ticket count under `workspace.maxAssignedTickets`,
   ordered `liveCount ASC, agent.id ASC`, first Redis-`online` candidate wins,
   fail-closed on presence-check failure). If none, return `null` (leave the
   conversation unassigned — do not partially advance).
3. Assign: write `conversation.assigned_agent_id` and a `conversation_assigned`
   event in the same transaction, using the existing state-change pattern (the
   one function that writes `conversation` + `event` together — see
   `conversationsService.ts` claim/take-over/reassign for the pattern to follow).
4. Return the assigned conversation id.

### Sweep: `sweepUnassignedQueue(workspaceId)`

Loops `assignNextTicket` inside a bounded loop (cap iterations at, e.g., the
current unassigned-queue count at loop start + 1, to guarantee termination even
under concurrent inserts) until it returns `null`. Each iteration is its own
transaction — a sweep is "assign one, assign one, ..." not one giant transaction,
so a mid-sweep failure only loses the one in-flight assignment, not the whole
sweep. Because step 2 of `assignNextTicket` re-reads live ticket counts every
call, successive tickets naturally interleave across all online agents under
cap — an agent who already received a ticket becomes less likely to win the next
one, rather than being filled to their cap before other online agents are
considered.

## Triggers

1. **Presence flip to online.** Wherever the codebase currently updates Redis
   presence to `online` (the same signal `assignOnHandoff` reads), enqueue a
   sweep for that agent's workspace. This is fire-and-forget relative to the
   presence update itself — the sweep runs after, does not block the presence
   write.
2. **Manual button.** `POST /conversations/sweep-assign`, restricted to Team
   Lead/Admin via `requireTeamLeadOrAdmin` (same guard as
   `PATCH /conversations/:id/assign` and `GET /workload`), runs
   `sweepUnassignedQueue` for the caller's workspace synchronously and returns
   the count of conversations assigned. Surfaced in the agent-console **Tickets**
   tab (not the inbox) as an "Assign next" action, visible only to Team
   Lead/Admin, with a toast reporting how many tickets were picked up (including
   zero).

A sweep triggered by one agent's presence change or button click is **not**
scoped to that agent — it drains the queue across all currently-online eligible
agents in the workspace, per the interleaving behavior above.

## Manual unassign

`unassignConversation(tx, conversationId, callerAgentId)`:

- Loads the conversation, scoped by RLS as usual.
- Requires `conversation.assigned_agent_id === callerAgentId`; otherwise 403
  (mirrors "expect 404 not 403 from RLS" only for tenancy — this is an
  authorization check within the tenant, so 403 is correct here, matching the
  existing `requireTeamLeadOrAdmin` pattern's use of 403 for role checks).
- Sets `assigned_agent_id → NULL`, writes a new `conversation_unassigned` event
  in the same transaction.
- Does **not** trigger a sweep itself. The ticket re-enters the unassigned queue
  and is picked up by the next presence-change or manual sweep, same as any
  other unassigned ticket.

Route: `POST /conversations/:id/unassign`, agent-console only, no special role
requirement beyond ownership.

## API surface

| Method | Path                          | Handler                       | Notes                                                                                    |
| ------ | ----------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `POST` | `/conversations/:id/unassign` | `unassignConversationHandler` | 403 if caller isn't the assigned agent                                                   |
| `POST` | `/conversations/sweep-assign` | `sweepAssignHandler`          | `requireTeamLeadOrAdmin`; returns `{ assignedCount: number, conversationIds: string[] }` |

Both must be registered in `backend/src/docs/openapi.ts` per repo convention.

## Data model changes

No schema changes. `assigned_agent_id` already nullable; existing enums cover all
needed conversation statuses. One new event type: `conversation_unassigned`
(payload: `{ previousAgentId: string }`, snapshotted per the append-only event
convention).

## Frontend

- New "Assign next" button in the agent-console **Tickets** tab
  (`frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx`), gated the
  same way `GET /workload` already is on the frontend (Team Lead/Admin only),
  calling `POST /conversations/sweep-assign` and showing a toast with the
  assigned count.
- New "Release ticket" action in `ThreadPanel.tsx` (or wherever claim/take-over
  actions currently live), visible only when `conversation.assigned_agent_id`
  equals the current agent, calling `POST /conversations/:id/unassign` and
  invalidating the same inbox caches claim/take-over already invalidate.

## Error handling

- `assignNextTicket` finding no eligible agent is not an error — it's the normal
  "queue drained as far as it can go" stop condition for the sweep loop.
- Presence-check failures during agent selection fail closed (agent excluded),
  same as `assignOnHandoff` already does.
- Sweep loop iteration cap prevents an infinite loop if conversations are being
  inserted into the unassigned queue faster than the sweep can drain them; a
  sweep simply stops at the cap and a later trigger continues the drain.
- Unassign on a ticket not owned by the caller: 403, no state change.
- Unassign on a ticket that's already unassigned or in a terminal status
  (`resolved`/`closed`): 409 or no-op — treat as a conflict, since the caller's
  view of the ticket is stale.

## Testing

- Unit: `assignNextTicket` ordering — priority beats age, age beats id tie-break.
- Unit: interleaving — two eligible online agents, N unassigned tickets, assert
  tickets alternate rather than filling agent A to cap first.
- Unit: cap enforcement — agent at `maxAssignedTickets` is excluded even if
  otherwise eligible.
- Unit: presence exclusion — `away`/`offline`/presence-check-failure agents are
  never selected.
- Unit: sweep loop terminates (bounded iteration) and returns correct assigned
  count.
- Unit: unassign — 403 for non-owning agent, success + event for owning agent,
  conflict for already-unassigned/terminal-status ticket.
- Integration: `POST /conversations/sweep-assign` end-to-end against seeded
  workspace data.
- OpenAPI doc entries added for both new routes.
