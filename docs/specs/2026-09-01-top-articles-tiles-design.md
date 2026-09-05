# Top articles analytics tiles

## Purpose

Add two new tiles to the agent-console Analytics dashboard so agents/admins can see which
knowledge-base articles are pulling weight, from two different angles:

- **Top cited by bot** — which articles the bot offers most often during handoff-avoidance.
- **Top read by players** — which articles players actually open, independent of how they got there.

## Metrics

Both are workspace + date-range scoped (same range as every other tile), ordered by count
descending, limited to 3, and return an empty array (tile renders "No data in this range") when
there's nothing in range.

- **Top cited**: count of `bot_article_offered` events grouped by `payload->>'article_id'`. Every
  offer counts — no dedup by conversation, consistent with how `bot.articleHitRate` already counts
  raw `bot_search`/`bot_article_offered` events. Title comes from the event's own snapshotted
  `payload->>'article_title'` (per the "payload values are snapshotted, never live pointers"
  convention) — no join to `article` needed.
- **Top read**: count of `article_read` events grouped by `payload->>'article_id'`. This event's
  payload only carries `article_id` (see `articleReadService.ts`), so this query joins the live
  `article` table, scoped to the same workspace, to get the current title.

## Type shape

`packages/types/src/analytics.ts` gets a new top-level section, parallel to `volume`/`speed`/
`bot`/`team`:

```ts
articles: {
  topCited: Array<{ articleId: string; title: string; count: number }>;
  topRead: Array<{ articleId: string; title: string; count: number }>;
}
```

`bot.articleHitRate` is unchanged and stays where it is — it's a different metric (search
hit-rate), not a ranking.

## Backend

- `backend/src/agent/services/analyticsService.ts`: new `getTopArticles(workspaceId, range)`
  function running the two grouped/counted/limited queries above, called alongside the existing
  `getVolumeMetrics`/`getBotMetrics`/etc. and merged into the `AnalyticsResponse` under `articles`.
- `backend/src/agent/services/dashboardLayoutService.ts`: `DEFAULT_LAYOUT` gets two new tile ids —
  `top-cited-articles` and `top-read-articles` — with grid slots.
- `backend/src/docs/openapi.ts`: schema updated to include the new `articles` response section.

## Frontend

- New shared tile component `frontend/src/surfaces/agent-console/pages/Analytics/tiles/RankedListTile.tsx`,
  alongside `NumberTile`/`BarChartTile`/`DonutChartTile`/`LineChartTile`. Props:
  `{ title: string; items: Array<{ id: string; label: string; count: number }> }`. Renders up to 3
  ranked rows (rank number, article title, count) inside the existing `TileFrame`; empty state
  matches the "No data in this range" copy used by the chart tiles.
- `tileCatalog.tsx`: two new entries, `top-cited-articles` and `top-read-articles`, both rendering
  `RankedListTile` off `data.articles.topCited` / `data.articles.topRead` respectively. Both ids
  added to `TILE_IDS` (kept hand-synced with the backend's `DEFAULT_LAYOUT.visibleTileIds`, per the
  existing comment in that file).

## Testing

- Backend: unit tests for `getTopArticles` covering ranking order, the 3-item limit, empty-range
  behavior, and workspace isolation (an article/event in another workspace must never appear).
- Frontend: `RankedListTile` render test (rows, empty state) and a `tileCatalog` test confirming
  both new ids render without throwing, following the existing pattern for other tile ids.

## Scope note

This work is entirely in the main tree. `.claude/worktrees/analytics-tab` is separate,
already-in-progress work on a locked branch and is not touched by this change.
