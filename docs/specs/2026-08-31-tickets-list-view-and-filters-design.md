# Tickets list view and widened filters

## Context

The Tickets board (`docs/specs/2026-08-20-tickets-page-design.md`,
`docs/specs/2026-08-27-resolved-closed-ticket-queues-design.md`) shows six columns — Unassigned,
Bot Handling, Agent Assigned, Escalated, Resolved, Closed — each a virtual queue computed from
`conversation.status`/`assignedAgentId`, independently paginated. Search and filters
(`docs/specs/2026-08-21-tickets-search-and-filters-design.md`) narrow all six columns at once but
never change the column layout itself.

When an agent searches or filters, the useful result is usually spread thin across all six columns
— a handful of matches each, most columns empty. There's no way to see the matches as one ranked
list. Separately, the filter bar is missing two controls the product spec calls for: filtering by
status directly (today status is only expressed by which column a ticket sits in) and filtering by
a date range.

## Goals

- Let an agent collapse the six-column board into one merged, ranked list of every ticket matching
  the active search/filters, regardless of which queue it's in.
- Add a Status filter (multi-select over the six queue states) and a Created-date range filter to
  the shared filter bar, usable in both board and list view.

## Non-goals

- Saved/named filter views — still deferred (per the search-and-filters spec).
- Full-text search over message bodies, filtering by declared player-state fields — still deferred.
- Changing the 7-day Resolved/Closed window, or Resolved/Closed's own timestamp source
  (`resolutionCycle.resolvedAt`/`closedAt`) — unchanged.
- A take-over action inline in the list row — selecting a row still opens the existing conversation
  detail pane, same as board mode.
- Changing board mode's per-column sort, pagination, or real-time reconciliation — untouched.

## UI

**View toggle.** A small "Board / List" segmented control sits next to the filter bar. State lives
in the URL (`?view=list`, default `board` when absent), alongside the existing filter params, so a
list-view + filter combination is bookmarkable like today's filtered board.

**Board mode** is unchanged except for one new interaction: the new Status filter (below) hides any
column whose queue isn't in the selected set, using the same visibility mechanism columns already
use when they're empty under active filters.

**List mode** replaces the column grid with one `TicketsListView`: a single infinite-scroll list of
`ConversationRow`s, ranked across all matching queues. Each row already renders its own status badge
(`ConversationRow` today), so which queue a ticket belongs to is still visible per-row even though
rows aren't grouped by column. "Claim" renders on a row only when that row's actual `status`/
`assigned_agent_id` mean it's currently unassigned (same condition Board mode's Unassigned column
uses), not based on which filter produced the row.

**Filter bar** (`TicketsFilterBar`), shared by both modes:

| Control                                           | Behavior                                                                                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status                                            | New. Multi-select over the six queue states. Empty selection = no restriction (all six). In Board mode narrows which columns render; in List mode narrows which queues are unioned. |
| Created                                           | New. Date range (from/to). Filters `conversation.createdAt`.                                                                                                                        |
| Search, Priority, Label, Subintent, Assignee, Age | Unchanged from the existing spec.                                                                                                                                                   |

All controls AND together, same as today.

**Empty states:** List mode shows the existing "no tickets match your filters" message
(`TicketsListView`'s empty state) when the merged query returns zero rows; Board mode's per-column
empty states are unchanged.

## Data model changes

None. No new columns — `createdAt` already exists on `conversation`; the merged list's sort key
(below) is computed from the existing `message` table, not stored.

## Backend

`conversationsService.ts`:

- `ConversationsFilter` gains `'all'`.
- `ConversationsListFilters` gains:
  - `statuses?: Exclude<ConversationsFilter, 'all' | 'mine'>[]` — subset of the six board queues
    (`unassigned`, `botHandling`, `agentAssigned`, `escalated`, `resolved`, `closed`). Omitted or
    empty = all six.
  - `createdFrom?: string`, `createdTo?: string` — ISO date strings.
- `extraFilterConditions` gains two more conditions, `conversation.createdAt >= createdFrom` /
  `<= createdTo`, applied in every filter mode (board columns included) — no special-casing, same
  AND-on-top model the other filters already use.
- New `'all'` branch in `listConversations`:
  - Builds the where-clause by OR-ing together the same per-queue conditions the five existing
    board branches use (`unassigned`, `botHandling`, `agentAssigned`, `escalated`) plus the
    resolved/closed branches (`listResolvedOrClosedConversations`'s conditions, including their
    existing 7-day window), restricted to whichever queues are in `statuses`.
  - AND'd with `extraFilterConditions(extra)` same as every other mode.
  - **Sort:** priority ASC, then most-recent-activity DESC. "Most recent activity" isn't a stored
    column (`last_message_at` is computed per-row post-fetch today, per the existing N+1 lookup at
    lines ~208-215). For this mode only, add a scalar subquery —
    `(select max(m.created_at) from message m where m.conversation_id = conversation.id)` — used
    directly in `ORDER BY` and the keyset cursor, so pagination is exact (not the JS post-filter
    pattern `olderThanHours` uses). Existing modes' sort/cursor/pagination are unchanged.
  - Cursor shape: `{ priority, lastMessageAt: string | null, id }`, `NULLS LAST` ordering for
    conversations with no messages yet.
  - Reuses the existing 26-row-fetch/trim-to-25 pagination pattern and the same per-row tags/last-
    message lookup for the returned page.

`conversationsController.ts`:

- Extend the `status` zod enum with `'all'`.
- New optional query params: `statuses` (repeated), `createdFrom`, `createdTo` — passed through to
  the service.

`openapi.ts`: register the new enum value and params, per repo convention.

## Frontend

`agentApi.ts`:

- `ConversationListFilter` gains `'all'`.
- `TicketsQueryFilters` gains `statuses?: string[]`, `createdFrom?: string`, `createdTo?: string`.
- `buildTicketsQuery` appends them the same way existing array/scalar params are appended.

`useTicketsFilters.ts`:

- `TicketsFilters` gains `statuses: string[]`, `createdFrom: string`, `createdTo: string`, and
  `view: 'board' | 'list'`. All five persist in URL params exactly like the existing fields.

`TicketsFilterBar.tsx`:

- Add a `MultiSelectFilter` for Status (options = the six `COLUMNS` titles/filter values already
  defined in `Tickets.tsx` — hoist that list, or a copy of the six `{value, label}` pairs, so both
  files share one source of the six queue names).
- Add a date-range control (two `Input type="date"`, or a single popover range-picker if one already
  exists in `components/ui`; otherwise two plain date inputs to stay within existing primitives).

`Tickets.tsx`:

- Add the Board/List toggle, reading/writing `filters.view`.
- Board mode: column visibility gains one more condition — hidden if `filters.statuses.length &&
!filters.statuses.includes(col.filter)`, alongside the existing empty-and-filtered hide.
- List mode: new `TicketsListView` component, structurally the same as today's `QueueColumn` but:
  - `useInfiniteQuery(['tickets', 'all', queryFilters])`, `fetchInbox(token, 'all', queryFilters, pageParam)`.
  - Not resizable/draggable (no per-column height/order state — it's the only "column").
  - Renders `ConversationRow`s with `onClaim` computed per-row from that row's own
    `status`/`assigned_agent_id`, not a fixed `claimable` prop.
- `toQueryFilters`/`hasActiveFilters` extended with `statuses`/`createdFrom`/`createdTo`.

**Real-time:** on `conversation:changed`, unconditionally also invalidate `['tickets', 'all']` —
any status can appear in the merged list, so unlike the per-status branching for the six board
queues, there's no cheap way to know if a changed conversation newly matches or newly stops
matching without refetching.

## Pagination interaction

Same as the existing search/filters spec: changing any filter (including the two new ones, or
`view`) resets pagination — filters are already part of every query key.

## Testing

- Backend: unit tests for the `'all'` filter — union of a subset of `statuses`, defaulting to all
  six when omitted, AND semantics with the two new date-range params and the existing filters,
  correct priority-then-activity sort, and keyset pagination stability (insert a row between page
  fetches, confirm no duplicate/skip — same pattern as the resolved/closed pagination test).
- Backend: `createdFrom`/`createdTo` applied correctly in at least one existing board-mode filter
  (e.g. `unassigned`), confirming the "applies everywhere" AND-on-top claim.
- Frontend: toggling to List mode renders one merged, paginating list; toggling Status filter in
  Board mode hides the deselected columns; toggling Status filter in List mode narrows the merged
  results; Claim appears only on rows that are actually unassigned within the merged list.
