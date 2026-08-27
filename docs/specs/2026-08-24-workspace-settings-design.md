# Workspace Settings

## Problem

Several ticket-handling knobs are currently hardcoded module constants, tunable only by
editing code and redeploying:

| Constant                                       | File                                      | Current value    |
| ---------------------------------------------- | ----------------------------------------- | ---------------- |
| (new) max tickets assigned to an agent at once | `domain/bot/assignOnHandoff.ts`           | none — unbounded |
| `INACTIVITY_WINDOW_HOURS`                      | `domain/conversations/resolutionCycle.ts` | 24               |
| `FORM_TIMEOUT_MINUTES`                         | `shared/jobs/formTimeout.ts`              | 30               |

A fourth knob, `workspace.autoCloseDays`, already exists as a per-workspace schema column
(`shared/db/schema/identity.ts`) and is read correctly by `shared/jobs/autoClose.ts`, but has
never been exposed through any admin-facing API or UI.

Support cadences differ per game (the same reasoning already recorded for `autoCloseDays`), so
these should be per-workspace settings an admin can tune without a code change, not global
constants.

## Scope

Add a **Workspace Settings** tab to the agent console admin area covering four settings:

1. **Max assigned tickets** — cap on how many live tickets `assignOnHandoff` will place on one
   agent before treating them as unavailable for auto-assignment. New.
2. **Auto-close days** — days a `resolved` conversation waits before `runAutoClose` flips it to
   `closed`. Existing column, newly exposed.
3. **Inactivity window (hours)** — hours of silence before a player is asked to confirm
   resolution (and, unchanged, the same window again before the ask itself times out). New.
4. **Form timeout (minutes)** — minutes a form submission waits before `sweepAbandonedForms`
   auto-hands it off. New.

Bot prompt/rules/tools configuration already has its own dedicated screen
(`botConfigRouter.ts` / `pages/BotConfig`) and is explicitly out of scope here.

Enforcement of the max-tickets cap applies to `assignOnHandoff` only (automatic bot handoff
assignment). Manual reassignment (`reassignConversation`) is left alone — a supervisor may
knowingly overload an agent, e.g. to cover for someone.

## Data model

Add three columns to `workspace` (`shared/db/schema/identity.ts`), alongside the existing
`autoCloseDays`, each `notNull` with a DB default equal to today's hardcoded value so existing
behavior is unchanged until an admin opts to tune it:

```ts
maxAssignedTickets: integer('max_assigned_tickets').notNull().default(5),
inactivityWindowHours: integer('inactivity_window_hours').notNull().default(24),
formTimeoutMinutes: integer('form_timeout_minutes').notNull().default(30),
```

Generate and commit the migration with `pnpm db:generate` per repo convention.

## Enforcement changes

- **`assignOnHandoff.ts`**: join `workspace` in the existing least-loaded query and add
  `HAVING liveCount < workspace.maxAssignedTickets` before the `ORDER BY liveCount, agent.id
LIMIT 1`. If every active agent is at or over the cap, the query returns no rows and the
  function keeps its existing `null` return — "no assignable agent," the same fallback already
  used for an empty active-agent pool. The ticket stays unassigned in the queue; no new error
  path.
- **`resolutionCycle.ts`**: `nextInactivityDueAt` becomes a pure function taking the window as
  a parameter (`nextInactivityDueAt(from: Date, windowHours: number)`), dropping its dependency
  on the module constant. `openResolutionCycle` looks up the workspace's `inactivityWindowHours`
  (it already has `workspaceId` and runs inside a workspace-scoped transaction) and passes it
  through. `INACTIVITY_WINDOW_HOURS` is removed.
- **`formTimeout.ts`**: `sweepAbandonedForms` selects `formTimeoutMinutes` alongside `id` in its
  existing per-workspace loop and computes the cutoff per workspace, mirroring exactly how
  `autoClose.ts` already computes its cutoff from `ws.autoCloseDays` inside its loop. The
  `options.timeoutMinutes` test override continues to work, now overriding the per-workspace
  value rather than the module constant. `FORM_TIMEOUT_MINUTES` is removed.
- **`autoClose.ts`**: no change — already reads `workspace.autoCloseDays` correctly.

## Admin API

New `agent/routers/workspaceSettingsRouter.ts`, following the existing read/write role split
used by `botConfigRouter.ts`:

- `GET /workspace-settings` — gated by `requireTeamLeadOrAdmin` — returns all four current
  values.
- `POST /workspace-settings` — gated by `requireAdminRole` — Zod-validates and updates. Bounds:

  | Field                   | Bounds          |
  | ----------------------- | --------------- |
  | `maxAssignedTickets`    | integer, 1–100  |
  | `autoCloseDays`         | integer, 1–365  |
  | `inactivityWindowHours` | integer, 1–720  |
  | `formTimeoutMinutes`    | integer, 1–1440 |

Service function lives in `agent/services/workspaceSettingsService.ts`, controller in
`agent/controllers/workspaceSettingsController.ts`, mirroring the bot-config file layout.
Router is mounted in `agent/router.ts` alongside `botConfigRouter`. Route and Zod schemas are
registered in `docs/openapi.ts` per repo convention.

## Frontend

New `frontend/src/surfaces/agent-console/pages/WorkspaceSettings/WorkspaceSettings.tsx`,
structured like `BotConfig.tsx`:

- One `useQuery` loads current settings from the new `GET` endpoint.
- A single form with four numeric inputs (one per setting), each with inline validation
  matching the backend bounds.
- Inputs and save button are disabled for a Team Lead (read-only view, same pattern the bot
  config screen does not currently need since it has no read-only viewer role distinction
  beyond the route gate — here the distinction is enforced both by disabling the form client-side
  and by the `requireAdminRole` gate server-side rejecting a Team Lead's POST).
- New route `workspace-settings` registered in `routes/AppRoutes.tsx` (lazy-loaded, same pattern
  as `BotConfigPage`), and a nav entry added next to "Bot Config" in
  `components/AgentConsoleShell.tsx`.

## Testing

- Schema/migration: `backend/tests/schema.test.ts` covers the new columns and defaults.
- `assignOnHandoff`: unit tests for (a) an agent at the cap being excluded while under-cap
  agents remain eligible, (b) every active agent at/over cap returning `null`.
- `openResolutionCycle` / `nextInactivityDueAt`: unit test with a non-default
  `inactivityWindowHours` to confirm the computed `inactivityDueAt` reflects it.
- `sweepAbandonedForms`: unit test with two workspaces on different `formTimeoutMinutes` values,
  confirming each uses its own cutoff.
- `workspaceSettingsRouter`: role-gating tests — plain agent forbidden on both routes, team lead
  can `GET` but is forbidden on `POST`, admin can do both; Zod boundary tests (0 and negative
  rejected, values above each field's max rejected).
- Frontend: a `WorkspaceSettings.test.tsx` mirroring `BotConfig.test.tsx` — renders current
  values, submits an update, and asserts the form is disabled for a team-lead session.
