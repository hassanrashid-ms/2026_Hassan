# Per-agent workload view — Design

## Why

Team Leads and Admins gained a manual reassignment path today
([[2026-08-24-reassign-and-reclassify-design]]): `AssignPicker` lets them move a conversation to any
active agent in the workspace. That picker has no view of *who to pick* — it's a flat name list with
no signal for who's overloaded versus idle. This spec adds the missing view: a per-agent workload
page showing current open-ticket count and recent resolution throughput for every agent in the
workspace.

## Goals

- One screen, scoped to the current workspace, showing every active agent's current open-ticket load
  and how much they've resolved recently.
- Purely informational — no actions live on this page. Reassignment stays in `AssignPicker`.

## Non-goals

- Live/socket-driven updates — this is a monitoring view, checked occasionally, not a queue watched
  continuously.
- Per-status breakdown (open vs. awaiting_player vs. escalated) — one open-count number per agent.
- Cross-workspace view — that's admin-console territory ([[2026-08-21-admin-dashboard-design]]) and
  out of scope here.
- Historical trend charts or drill-down into an agent's individual ticket list.

## Metrics

Per active agent in the workspace:

- **Open count** — conversations where `assigned_agent_id = agent.id` and
  `status IN ('open', 'awaiting_player', 'escalated')`. Same predicate as the Tickets board's
  "Mine"/"Agent Assigned" columns ([[2026-08-20-tickets-page-design]]) — no new definition of
  "currently owned."
- **Resolved (7d)** — count of `resolution_cycle` rows where `resolved_at >= now() - interval '7
  days'` and the parent conversation's `assigned_agent_id` was this agent. This naturally excludes
  cycles resolved straight out of `bot_active` (no agent ever owned those) and correctly attributes a
  cycle to whichever agent owned the conversation at resolution time — a conversation reassigned
  mid-cycle counts toward the agent who held it when it resolved, not whoever held it earlier. Timed-
  out resolutions count the same as agent-confirmed ones; both closed out under that agent's
  ownership.

## Backend

### Query

New function `getWorkspaceWorkload(ctx)` in `agent/services/conversationsService.ts`, alongside the
existing `listConversations` filter modes it reuses the same predicates from:

```sql
-- open count, per agent
SELECT assigned_agent_id, count(*) AS open_count
FROM conversation
WHERE assigned_agent_id IS NOT NULL
  AND status IN ('open', 'awaiting_player', 'escalated')
GROUP BY assigned_agent_id;

-- resolved-7d count, per agent
SELECT c.assigned_agent_id, count(*) AS resolved_7d
FROM resolution_cycle rc
JOIN conversation c ON c.id = rc.conversation_id
WHERE rc.resolved_at >= now() - interval '7 days'
  AND c.assigned_agent_id IS NOT NULL
GROUP BY c.assigned_agent_id;
```

Both run under normal RLS (`app.workspace_id` scoping — no admin bypass needed, this is a
workspace-scoped read like any other agent-console query).

The two GROUP BYs are left-joined onto the workspace's active `workspace_member` roster (role
`agent | team_lead`, not deactivated) so every active agent appears with `0` rather than being
absent — an idle agent is exactly the case this page exists to surface, so a `GROUP BY` alone (which
silently omits zero-row agents) is wrong here.

### Route

`GET /agent/workload`, gated by the existing `requireTeamLeadOrAdmin` middleware
(`shared/middleware/requireTeamLeadOrAdmin.ts`), the same guard `botConfigRouter` and `formsRouter`
already use — no new middleware. Registered in `agent/routers/conversationsRouter.ts` alongside the
other conversation-scoped reads.

Response:

```jsonc
{
  "agents": [
    { "agentId": "...", "agentName": "...", "openCount": 4, "resolved7d": 11 }
  ]
}
```

Register the route and its Zod response schema in `backend/src/docs/openapi.ts`, per repo
convention.

## Frontend

New page `surfaces/agent-console/pages/Workload/Workload.tsx`, new standalone nav item — visible
only when `canBuildForms(session)` is true (`lib/agentSession.ts`), the same role gate
`AgentConsoleShell.tsx` already uses to show the Forms nav item, reused as-is (its role set,
`team_lead | admin`, is exactly this feature's gate — no new `canSeeWorkload` helper).

- Single table: **Agent | Open | Resolved (7d)**.
- Default sort: Open, descending. Column headers are clickable to re-sort client-side (data is
  already fully loaded — no re-fetch on sort).
- Fetched once via TanStack Query on mount (`['workload']` key). No socket subscription, no
  polling — matches the page's occasionally-checked, not continuously-watched, usage.
- No actions on any row — this page is read-only by design; reassignment happens from
  `AssignPicker` in `ThreadPanel.tsx`.

## Error handling and edge cases

- **Solo workspace** — one agent, one row. No special-casing.
- **Zero-ticket agent** — renders `0` / `0`, not omitted (this is the reason for the left join in the
  backend query).
- **Mid-cycle reassignment** — a cycle resolved after being reassigned counts for the agent who held
  it at `resolved_at`, per the join above, not whoever claimed it first.
- **Non-team_lead/admin caller** — `403`, enforced by `requireTeamLeadOrAdmin`, matching every other
  route that middleware already guards.
- **Deactivated agent** — excluded from the roster (left join is against *active* `workspace_member`
  rows only), consistent with the existing rule that a deactivated agent's open conversations return
  to the unassigned queue rather than staying attributed to them.

## Testing

- Backend: open count matches the exact predicate `listConversations`'s `agentAssigned` mode uses;
  resolved-7d excludes bot-resolved cycles and correctly attributes a reassigned-mid-cycle
  resolution; zero-ticket active agents appear with `0`s; deactivated agents are excluded; 7-day
  window boundary (a cycle resolved exactly 7 days + 1 second ago is excluded).
- Backend: non-team_lead/admin request gets `403`.
- Frontend: sort toggling by each column; nav item hidden for `agent` role, shown for
  `team_lead`/`admin`.
