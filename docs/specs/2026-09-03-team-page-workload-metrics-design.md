# Team page (Workload) — richer per-agent metrics, remove leave toggle

## Context

The Team page is `frontend/src/surfaces/agent-console/pages/Workload/Workload.tsx`. Today it shows,
per agent: avatar, presence dot, name, open count, resolved-in-7-days count, and a single
"Set on leave" / "Clear leave" action.

Two changes:

1. Remove the leave toggle from this page (UI-only — see below).
2. Add four columns that give a team lead a more useful read of the roster: role, capacity,
   escalated count, overdue count.

## 1. Remove "Set on leave" (UI-only)

The leave feature has real backend reach: a DB enum value + two `agent` columns
(`onLeaveSince`/`onLeaveUntil`), a `PATCH /agents/:id/leave` route, an audit trail via
`change_log`, a BullMQ auto-expiry job (`leaveExpiry.ts`), and it's read by ticket-routing
eligibility (`pickEligibleAgent.ts` excludes `status != 'active'`) and by the workload roster query
itself (`conversationsService.ts` overrides live presence with `on_leave`).

Given that reach, this pass removes only the UI surface:

- Delete the "Leave" column, the "Set on leave"/"Clear leave" button, and the `LeaveDialog`
  import/usage from `Workload.tsx`.
- Remove the `handleConfirmLeave` handler and related dialog state.
- Leave `PresenceDot`'s `on_leave` color and the `DisplayStatus` type as-is — an agent's status can
  still be `on_leave` in the DB (set previously, or via direct API/job), and the dot should still
  render it correctly. Only the _action_ to set/clear it from this page is removed.
- Backend route, service, job, DB columns/enum: untouched. This keeps the change small and
  reversible; a full teardown (dropping the column/enum/job) is a separate, larger change if ever
  needed.

## 2. New columns

Final column order: **Agent** (avatar + name + role badge) → **Status** (presence dot) →
**Open / Capacity** → **Escalated** → **Overdue** → **Resolved (7d)**.

- **Role** — badge next to the agent's name, from `workspaceMember.role` (`agent` / `team_lead`).
  Already joined in `getWorkspaceWorkload`; just add it to the returned shape.
- **Open / Capacity** — replaces the current bare "Open" count with `openCount/maxAssignedTickets`
  (e.g. "8/10"). `maxAssignedTickets` is workspace-level (`workspace.maxAssignedTickets`), so it's
  fetched once per call and applied to every row. Styled amber/red when `openCount >= capacityMax`.
- **Escalated** — count of the agent's open conversations with `status = 'escalated'`. Same
  grouped-by-`assignedAgentId` shape as the existing open-count query, just filtered further.
- **Overdue** — count of the agent's open conversations where the **player's** last message has
  gone unanswered for **more than 4 hours**. This is deliberately _not_ based on
  `resolutionCycle.inactivityDueAt` — that clock resets on a message from either side and is a
  general silence timer, not an agent-responsiveness signal. Overdue here means: latest message on
  the conversation is from the player, and it's older than 4 hours, and the conversation is still
  open/assigned to this agent.

Sorting extends to `escalated` and `overdue` alongside the existing `agent` / `open` /
`resolved7d` sort keys.

## Backend changes

`getWorkspaceWorkload` (`backend/src/agent/services/conversationsService.ts:977-1075`):

- Add `role` to the existing roster select (already joins `workspaceMember`).
- Add one scalar fetch of `workspace.maxAssignedTickets` for the calling workspace; return as
  `capacityMax` alongside each entry (or once at the top level — frontend applies it per row
  either way).
- Add a grouped count query for `escalatedCount`, filtered to `status = 'escalated'`, grouped by
  `assignedAgentId` — mirrors the existing open-count query.
- Add a grouped count query for `overdueCount`: open conversations grouped by `assignedAgentId`
  where the latest message's `authorType` is `player` and that message's `createdAt` is more than
  4 hours before now.

No schema or migration changes — everything is derived from existing columns.

`AgentWorkloadEntry` (`frontend/src/surfaces/agent-console/api/agentApi.ts`) gains `role`,
`capacityMax`, `escalatedCount`, `overdueCount`.

## Frontend changes

`Workload.tsx`:

- Remove leave column/button/dialog/handler as described above.
- Add Role badge, Open/Capacity cell (with over-capacity styling), Escalated cell, Overdue cell.
- Extend `SortColumn` type and header click handlers to cover `escalated` and `overdue`.

## Testing

- `Workload.test.tsx`: remove leave-button assertions; add cases for role badge rendering,
  capacity display (including over-capacity styling), escalated count, overdue count, and sorting
  by the two new columns.
- `conversationsService` tests (`backend/tests/agent.workload.test.ts`): add cases for the new
  fields, including an agent with an escalated ticket and an agent with a >4h-unanswered player
  message.

## Out of scope

- Any change to `inactivityClock.ts` / `resolutionCycle.ts` behavior (the auto "did this solve it?"
  ask firing regardless of who's silent) — flagged during this design as a real issue, but it's a
  core conversation-lifecycle behavior change and will get its own design pass.
- Full teardown of the leave feature (DB columns, enum value, route, job) — UI-only removal for
  this pass.
