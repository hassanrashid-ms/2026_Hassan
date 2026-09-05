# Analytics Tab — Design

## Purpose

Agents and team leads currently have no aggregate view of how a workspace is performing — ticket
volume, response/resolution speed, bot effectiveness, and team load all have to be inferred from
scanning the Tickets board or Workload page one conversation at a time. This spec adds an Analytics
tab to the agent console: a workspace-scoped dashboard of number/graph/chart tiles that the agent can
drag and resize to their own liking, built on the existing "reporting spine" (`event` + `conversation`
tables) rather than any new tracking mechanism.

Out of scope: cross-workspace/admin rollups (a separate spec, if wanted, building on the same
aggregate queries) and per-agent breakdown tiles (already covered by the existing Workload page —
this tab only adds workspace-aggregate load numbers).

## Surface & placement

Lives in `frontend/src/surfaces/agent-console/pages/Analytics/`, added to the existing agent-console
nav alongside Tickets/Inbox/Workload/etc. Scoped to the agent's current workspace via the existing
RLS `app.workspace_id` mechanism — no new tenancy work.

## Tile catalog

One aggregate endpoint powers all tiles (see API below); each tile is a pure rendering of a slice of
that response. Four metric groups, matching what's already tracked in `event`/`conversation`:

| Group                            | Tile                              | Shape              | Source                                                                         |
| -------------------------------- | --------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| Volume & status                  | New vs. resolved over time        | line               | `conversation_opened` / `conversation_resolved(_forced)` events, bucketed      |
| Volume & status                  | Status breakdown                  | donut              | `conversation.status` grouped                                                  |
| Volume & status                  | Total open count                  | number             | `conversation.status` not in (resolved, closed)                                |
| Volume & status                  | Volume by priority                | bar                | `conversation.priority` grouped                                                |
| Speed                            | First-response time (avg/p50/p90) | number + sparkline | `conversation_opened` → first `message_sent` (actor=agent)                     |
| Speed                            | Resolution time (avg/p50/p90)     | number + sparkline | `conversation_opened` → `conversation_resolved`/`conversation_resolved_forced` |
| Speed                            | Time-to-claim trend               | line               | `conversation_opened`/`conversation_assigned_bot` → `conversation_assigned`    |
| Bot performance                  | Bot containment rate              | number             | `conversation_resolved` where `resolution_source = 'bot'` ÷ total resolved     |
| Bot performance                  | Handoff rate + top reasons        | donut              | `bot_handoff` events, grouped by reason in payload                             |
| Bot performance                  | Article search hit rate           | number             | `bot_search` vs `bot_article_offered` events                                   |
| Team & workload (aggregate only) | Avg open tickets per active agent | number             | `conversation.assignedAgentId` count ÷ active agent count                      |
| Team & workload (aggregate only) | Unassigned queue depth over time  | line               | sampled from `conversation_opened`/`conversation_assigned` events per bucket   |

No per-agent breakdown here — that stays on Workload, to avoid duplicating it.

## Backend

### `GET /workspaces/:workspaceId/analytics`

Query params: `from`, `to` (ISO dates), `granularity` (`day` | `week`, default `day` — chosen from
range length). One request returns every metric group in one JSON payload; tiles slice it client-side.
Avoids 11 separate round-trips and lets shared aggregates (e.g. total conversation count) compute
once. Read-only, scoped by the existing per-request `app.workspace_id` RLS — no bypass role needed
(unlike the admin dashboard's cross-workspace queries).

Response shape:

```
{
  range: { from, to, granularity },
  volume: { series: [{bucket, opened, resolved}], byStatus: [{status, count}], openTotal, byPriority: [{priority, count}] },
  speed: { firstResponse: {avgSeconds, p50Seconds, p90Seconds, series}, resolution: {avgSeconds, p50Seconds, p90Seconds, series}, timeToClaim: {series} },
  bot: { containmentRate, handoff: {rate, byReason: [{reason, count}]}, articleHitRate },
  team: { avgOpenPerActiveAgent, unassignedQueueDepth: {series} }
}
```

Speed metrics are computed via SQL window functions over `event`, keyed off `conversation_id` and
ordered by `occurred_at` (the table's existing BRIN index on `occurred_at` and btree on
`(conversation_id, occurred_at)` cover this without new indexes).

### Layout persistence — `agent_dashboard_layout`

```
agent_dashboard_layout
  agent_id      uuid NOT NULL REFERENCES agent(id) ON DELETE RESTRICT
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT
  layout        jsonb NOT NULL   -- react-grid-layout items [{i, x, y, w, h}] + visible tile ids
  updated_at    timestamptz NOT NULL DEFAULT now()
  PRIMARY KEY (agent_id, workspace_id)
```

One row per agent per workspace — an agent's layout in workspace A doesn't affect workspace B. RLS
policy scoped by `workspace_id` like every other scoped table; the row is additionally only
readable/writable by the owning `agent_id` (enforced in the route handler, same pattern as other
"my own resource" endpoints).

- `GET /workspaces/:workspaceId/analytics/layout` — returns the caller's saved layout, or a
  hardcoded default layout (all 11 tiles in a sensible default grid) if no row exists yet.
- `PUT /workspaces/:workspaceId/analytics/layout` — upserts the caller's layout. Called on
  drag-end/resize-end, debounced ~500ms client-side so a resize drag doesn't fire a write per frame.

Both routes registered in `backend/src/docs/openapi.ts` per repo convention.

## Frontend

```
Analytics/
  Analytics.tsx              page: time-range bar + grid
  AnalyticsTimeRangeBar.tsx  presets (Today/7d/30d/90d) + react-day-picker custom range
  AnalyticsGrid.tsx          react-grid-layout wrapper; loads/saves layout; "Add tile" / "Reset layout"
  tiles/
    TileFrame.tsx            shared card chrome: title, drag handle, resize handle, remove button
    NumberTile.tsx           big stat + optional sparkline + delta vs. previous equal-length period
    LineChartTile.tsx        Recharts line/area — volume, TTR trend, queue depth trend
    DonutChartTile.tsx       Recharts pie — status breakdown, handoff reasons
    BarChartTile.tsx         Recharts bar — volume by priority
  api/analyticsApi.ts        fetchAnalytics(), fetchLayout(), saveLayout()
  useAnalyticsData.ts        TanStack Query hook, keyed on [workspaceId, from, to, granularity]
  useTileLayout.ts           layout state + debounced PUT, optimistic local update on drag/resize
```

- **Grid mechanics**: `react-grid-layout` (new dependency) — chosen over hand-rolling resize on top
  of the existing `dnd-kit` because drag+resize+collision+responsive breakpoints are exactly its job,
  and building resize-with-collision from scratch is real work for no behavioral gain here. Its
  default CSS is not used; `TileFrame` and grid item styling are done entirely in Tailwind v4
  utilities on the existing agent-console theme tokens (`bg-surface`, `text-text`, `rounded-card`,
  etc.), per the repo's "no hand-written CSS" rule.
- **Charts**: built with Recharts (already the repo's chart library) following the `dataviz` skill's
  palette and mark-spec guidance for consistent, theme-aware colors — invoked at implementation time,
  not re-derived here.
- **Loading**: the saved layout (positions/sizes) loads first and renders immediately as skeleton
  tiles — each skeleton takes the exact `{x, y, w, h}` grid slot and tile-type shape (number vs.
  chart) of the tile that will render there, so nothing jumps or reflows once data arrives; only the
  tile's inner content swaps from skeleton to real. Not a full-page spinner.
- **Empty state**: zero conversations in the selected range → single centered `EmptyState` message,
  tiles hidden, time-range bar still usable to pick a different range.
- **Error**: query failure → inline retry banner above the grid; existing (last-good) layout and any
  previously-fetched tile data stay visible rather than blanking the page.
- **Responsiveness**: `react-grid-layout`'s built-in breakpoints collapse to a single stacked column
  on narrow viewports; drag/resize are disabled below that breakpoint (view-only on mobile).

## Testing

- Backend: unit tests for each metric group's SQL against seeded `event`/`conversation` fixtures
  (known input → known aggregate output), plus a workspace-isolation test (`analytics` for workspace
  A never reflects workspace B's events). Layout route tests: get-with-no-row returns default,
  put-then-get round-trips, one agent's PUT never affects another agent's row.
- Frontend: component tests for each tile type rendering a fixed data shape, `AnalyticsGrid`
  drag/resize triggering the debounced save, empty/error/loading states.

## Worktree

Implementation happens in an isolated git worktree per the user's request, created via
`superpowers:using-git-worktrees` before the implementation plan is executed.
